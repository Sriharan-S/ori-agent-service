import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { LlmService } from '../llm/llm.service';
import { LlmError, type ChatMessage, type ToolCall } from '../llm/llm.types';
import type { PlannerFacingFunction } from '../registry/function.contract';
import { ExecutorService } from './executor.service';
import { describeObservation } from './observation';
import { ORI_LOOP_PERSONA } from './ori-persona';
import { toToolSchema } from './tool-schema';
import type {
  AgentEventSink,
  AgentRun,
  CallOutcome,
  PlannedCall,
} from './orchestrator.types';

/**
 * Why the loop stopped.
 *
 * `declined` and `exhausted` are both "no answer from data", but they mean
 * different things to the caller: the first is the model saying nothing fits,
 * which is a real answer and the point of allowing it; the second is the model
 * going round in circles, which is a bug in a function description far more
 * often than it is a hard question.
 */
export type LoopStop =
  | 'answered'
  | 'ambiguous'
  | 'declined'
  | 'exhausted'
  | 'llm-unavailable';

export interface LoopResult {
  outcomes: CallOutcome[];
  stop: LoopStop;
  /** Prose the model wrote when it stopped without calling anything. */
  text: string;
  steps: number;
}

/**
 * The agent loop: call something, look at what came back, decide what is next.
 *
 * This replaces a single-shot planner that chose every function up front, from
 * the question alone, and never saw a result. That design could not express the
 * most ordinary request there is — "generate the report for Priya" needs a
 * lookup whose *output* is the next call's input — so the model did the only
 * thing left to it and wrote a placeholder where the id belonged. The call then
 * failed validation before it ever started, which is why it was missing from
 * the trace entirely, and the user was told the report "was not available".
 *
 * Three properties matter here and none of them were available before:
 *
 *   1. **A result informs the next decision.** Chaining stops being something
 *      the model has to predict and becomes something it observes.
 *   2. **Declining is a valid move.** `tool_choice: auto` means "no function
 *      fits" is expressible. Forcing a call is what made `find_user` run with
 *      an empty email for "list corporate users".
 *   3. **A rejected call is a turn, not a failure.** The validator's complaint
 *      goes back to the model, which usually fixes it on the next step.
 *
 * What has not changed: the model still cannot reach data except through a live
 * registry function, still never sees the schema, and an ambiguous lookup still
 * short-circuits to a question rather than being resolved by guessing.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly llm: LlmService,
    private readonly executor: ExecutorService,
  ) {}

  async run(
    run: AgentRun,
    catalogue: PlannerFacingFunction[],
    knowledge: string,
    emit: AgentEventSink,
  ): Promise<LoopResult> {
    if (catalogue.length === 0) {
      return { outcomes: [], stop: 'declined', text: '', steps: 0 };
    }

    const tools = catalogue.map(toToolSchema);
    const valid = new Set(catalogue.map((entry) => entry.name));
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(run, knowledge) },
      ...toHistory(run.history),
      { role: 'user', content: run.message },
    ];

    const outcomes: CallOutcome[] = [];
    const attempted = new Set<string>();
    const maxSteps = Math.max(1, this.config.behaviour.maxAgentSteps);
    let retrieving = false;

    for (let step = 1; step <= maxSteps; step += 1) {
      let assistant: Awaited<ReturnType<LlmService['complete']>>;

      try {
        assistant = await this.llm.complete(messages, {
          purpose: 'planner',
          applicationId: run.context.application.id,
          temperature: 0,
          tools,
          // Never `required`. The whole point is that "nothing here fits" is a
          // move the model is allowed to make.
          toolChoice: 'auto',
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Agent loop step ${step} failed: ${detail}`);

        // A model that died mid-loop after useful calls still has something to
        // say. Only a first-step failure means the question was never read.
        return {
          outcomes,
          stop:
            outcomes.length > 0
              ? 'answered'
              : error instanceof LlmError || /no enabled model|all .* failed/i.test(detail)
                ? 'llm-unavailable'
                : 'declined',
          text: '',
          steps: step - 1,
        };
      }

      const calls = assistant.toolCalls.slice(0, this.config.behaviour.maxPlannedCalls);

      emit({
        type: 'agent.step',
        channel: 'trace',
        step,
        calls: calls.map((call) => ({ name: call.name, params: call.arguments })),
        text: assistant.text,
      });

      // Kept so a client written against the old stream still renders a plan.
      emit({
        type: 'plan.created',
        channel: 'trace',
        reasoning: assistant.text || `Step ${step}`,
        considered: catalogue.map((entry) => entry.name),
        isFallback: false,
        calls: calls.map((call) => ({
          name: call.name,
          params: call.arguments,
          reason: '',
        })),
      });

      if (calls.length === 0) {
        // The model chose prose over a call. If it has already gathered
        // something, that is it deciding it has enough; if it has not, it is
        // declining — and those need different things said to the user.
        return {
          outcomes,
          stop: outcomes.length > 0 ? 'answered' : 'declined',
          text: assistant.text.trim(),
          steps: step,
        };
      }

      messages.push({
        role: 'assistant',
        content: assistant.text,
        toolCalls: calls,
      });

      // The user-facing stage moves to "retrieving" the moment real work starts,
      // and stays there for the rest of the loop. A client should not flicker
      // between "choosing" and "fetching" once per step.
      if (!retrieving) {
        retrieving = true;
        emit({ type: 'stage', channel: 'user', stage: 'retrieving' });
      }

      for (const call of calls) {
        const observation = await this.observe(
          call,
          valid,
          attempted,
          outcomes,
          run,
          emit,
        );

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: observation,
        });
      }

      // An ambiguous lookup is the function saying it does not know which record
      // was meant. Nothing later in the loop can supply that, so the loop ends
      // and the user is asked. This is the one short-circuit that is not a
      // judgement call.
      if (outcomes.some((outcome) => outcome.result.status === 'ambiguous')) {
        return { outcomes, stop: 'ambiguous', text: '', steps: step };
      }
    }

    this.logger.warn(
      `Agent loop hit the ${maxSteps}-step ceiling for run ${run.context.runId}`,
    );

    return {
      outcomes,
      stop: outcomes.length > 0 ? 'answered' : 'exhausted',
      text: '',
      steps: maxSteps,
    };
  }

  /**
   * Run one tool call and produce the sentence the model reads next.
   *
   * Everything that can go wrong before the function body is answered here
   * rather than thrown, because each of these is recoverable on the next step
   * and only if the model is told what happened.
   */
  private async observe(
    call: ToolCall,
    valid: Set<string>,
    attempted: Set<string>,
    outcomes: CallOutcome[],
    run: AgentRun,
    emit: AgentEventSink,
  ): Promise<string> {
    if (call.malformed) {
      return `Failed. Your ${call.malformed}. Send the arguments as a JSON object.`;
    }

    // Constrained decoding makes this rare rather than impossible, and a
    // hallucinated name must not reach the executor as a lookup miss.
    if (!valid.has(call.name)) {
      return (
        `Failed. There is no function called "${call.name}". ` +
        `Choose one of: ${[...valid].join(', ')}.`
      );
    }

    const signature = `${call.name}(${stableStringify(call.arguments)})`;
    if (attempted.has(signature)) {
      return (
        'Skipped — you already called that with exactly those arguments. ' +
        'Use the result above, call something different, or answer the user.'
      );
    }
    attempted.add(signature);

    const planned: PlannedCall = {
      functionName: call.name,
      params: call.arguments,
      reason: '',
    };

    const outcome = await this.executor.runCall(planned, run, emit);
    outcomes.push(outcome);

    return describeObservation(outcome);
  }

  private systemPrompt(run: AgentRun, knowledge: string): string {
    return `${ORI_LOOP_PERSONA}

═══ CALLER ═══
Role: ${run.context.role.name}
Results are already limited to what this caller is allowed to see. Do not try to
add that filtering yourself, and do not ask the user which company or account
they mean when the answer is "their own".
${knowledge ? `\n═══ WHAT YOU KNOW ABOUT THIS APPLICATION ═══\n${knowledge}\n` : ''}
═══ HOW TO WORK ═══
1. Call one function at a time. Read what it returned before choosing the next.
2. If a function needs an id you do not have, call the lookup that returns it
   first, then use the id from that result. Never write a placeholder, never
   guess an id, and never pass a name where an id is required.
3. Match ids by their label, not by position. One record often carries several
   different ids — a registration id and a user id are different numbers for the
   same person, and they are not interchangeable. A parameter called "user id"
   takes the field labelled "User id" and nothing else. Passing the wrong one
   silently acts on somebody else's record, so if the exact label is missing,
   say so rather than substituting a different id.
4. Take argument values only from what the user actually said or from a result
   you have already seen. If a required value was never given, do not invent one
   and do not pass an empty string — stop and ask for it.
5. If no function fits what was asked, do not call one. Say so in one sentence
   instead. That is a correct answer, not a failure.
6. Never answer a question about a specific record from memory. If you have not
   called something this turn, you do not know it — look it up.
7. Stop as soon as you have what the question needs. Do not call extra functions
   to be thorough.
8. When you are done, reply with a short plain sentence. Something else turns it
   into the final wording, so do not polish it.`;
  }
}

/**
 * Recent turns, as messages rather than a transcript block.
 *
 * The old prompt pasted history into the system message as `user: …` lines,
 * which reads to a model as a document about a conversation rather than the
 * conversation itself. Real message turns make "the second one" and "now do it
 * for her" resolvable, which is most of what follow-up questions are made of.
 */
function toHistory(history: AgentRun['history']): ChatMessage[] {
  return history.slice(-6).map((turn) => ({
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: turn.content.slice(0, 600),
  }));
}

/** Key-order-independent, so `{a,b}` and `{b,a}` count as the same call. */
function stableStringify(value: Record<string, unknown>): string {
  return Object.keys(value)
    .sort()
    .map((key) => `${key}=${JSON.stringify(value[key])}`)
    .join(',');
}
