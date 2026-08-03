import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditLoggerService } from '../audit/audit-logger.service';
import type { RequestContext } from '../auth/identity';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import {
  ConversationService,
  type PendingDisambiguation,
} from '../memory/conversation.service';
import { RegistryService } from '../registry/registry.service';
import { formatGrounding } from '../knowledge/knowledge-prompt';
import {
  RetrievalService,
  type Passage,
} from '../knowledge/retrieval.service';
import { ExecutorService } from './executor.service';
import { ORI_STATIC_FALLBACKS } from './ori-persona';
import type {
  AgentEventSink,
  AgentResponse,
  AgentRun,
  CallOutcome,
  ExecutionPlan,
} from './orchestrator.types';
import { NOOP_SINK } from './orchestrator.types';
import { AgentLoopService } from './agent-loop.service';
import { ReflectorService } from './reflector.service';
import { RouterService } from './router.service';
import { SynthesizerService } from './synthesizer.service';

/**
 * The request pipeline.
 *
 *   route → catalogue → plan → validate + scope + execute → reflect →
 *   synthesize → audit → respond
 *
 * Every stage emits, so a caller with the `trace` scope watches the agent think
 * and a caller without one gets the answer as it is written. The non-streaming
 * path is the same code with a sink that discards.
 *
 * A clarification reply re-enters at the router, which is why the pending
 * candidate set lives in conversation state rather than in the response.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
    private readonly conversations: ConversationService,
    private readonly registry: RegistryService,
    private readonly router: RouterService,
    private readonly agentLoop: AgentLoopService,
    private readonly executor: ExecutorService,
    private readonly reflector: ReflectorService,
    private readonly synthesizer: SynthesizerService,
    private readonly retrieval: RetrievalService,
    private readonly audit: AuditLoggerService,
  ) {}

  async handle(
    message: string,
    conversationId: string | null,
    context: RequestContext,
    emit: AgentEventSink = NOOP_SINK,
    options: { replaceFromMessageId?: number | null } = {},
  ): Promise<AgentResponse> {
    const startedAt = Date.now();
    const conversationKey = await this.conversations.resolve(
      conversationId,
      context,
    );

    emit({
      type: 'run.started',
      channel: 'user',
      runId: context.runId,
      conversationId: conversationKey,
    });

    await this.openRun(context, conversationKey, emit !== NOOP_SINK);

    // An edited turn replaces itself and everything after it. This has to
    // happen before history is read, or the run would answer with the turns it
    // is meant to be discarding.
    //
    // `resolve` returns a *new* conversation when the caller does not own the
    // one they named, so rewinding is skipped in that case rather than applied
    // to a fresh conversation where the id means nothing.
    if (
      options.replaceFromMessageId != null &&
      conversationId &&
      conversationKey === conversationId
    ) {
      await this.conversations.supersedeFrom(
        conversationKey,
        options.replaceFromMessageId,
        context,
      );
    }

    const [pending, history] = await Promise.all([
      this.conversations.getPending(conversationKey),
      this.conversations.getHistory(conversationKey),
    ]);

    const userMessageId = await this.conversations.appendTurn(
      conversationKey,
      'user',
      message,
    );

    if (userMessageId !== null) {
      emit({
        type: 'turn.recorded',
        channel: 'user',
        role: 'user',
        messageId: userMessageId,
      });
    }

    const run: AgentRun = { message, conversationKey, context, history };

    emit({ type: 'stage', channel: 'user', stage: 'understanding' });
    const decision = this.router.classify(message, pending);

    emit({
      type: 'router.decision',
      channel: 'trace',
      intent: decision.intent,
      reason: decision.reason,
    });

    this.logger.log(
      `[${context.runId}] intent=${decision.intent} app=${context.application.slug} role=${context.endUser.role}`,
    );

    try {
      // `runTimeoutMs` was documented as the upper bound on a run and enforced
      // nowhere — the janitor used it to reap stale *records* every five
      // minutes, which is not the same thing at all. A slow model therefore held
      // the request open indefinitely: 252 seconds was observed against a real
      // endpoint, with the SQL itself taking 55ms of it. The caller waits, a
      // connection stays open, and a pool slot is held the whole time.
      const response = await this.withDeadline(
        decision.intent === 'clarification-reply' &&
          decision.pending &&
          decision.resolvedCandidate
          ? this.handleClarificationReply(
              run,
              decision.pending,
              decision.resolvedCandidate,
              emit,
            )
          : decision.intent === 'conversational'
            ? this.handleConversational(run, emit)
            : this.handleDataRequest(run, pending !== null, emit),
        context.runId,
      );

      const assistantMessageId = await this.conversations.appendTurn(
        conversationKey,
        'assistant',
        response.message,
        { type: response.type, functionsUsed: response.functionsUsed },
      );

      if (assistantMessageId !== null) {
        emit({
          type: 'turn.recorded',
          channel: 'user',
          role: 'assistant',
          messageId: assistantMessageId,
        });
      }

      response.userMessageId = userMessageId;
      response.assistantMessageId = assistantMessageId;

      const latencyMs = Date.now() - startedAt;
      await this.closeRun(context, decision.intent, response, latencyMs, null);

      emit({
        type: 'run.completed',
        channel: 'user',
        responseType: response.type,
        message: response.message,
        functionsUsed: response.functionsUsed,
        latencyMs,
      });

      this.logger.log(
        `[${context.runId}] ${response.type} in ${latencyMs}ms (${response.functionsUsed.join(', ') || 'no functions'})`,
      );

      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${context.runId}] pipeline failed: ${detail}`);
      this.audit.recordRejection(context, `pipeline error: ${detail}`);

      // Someone who has been waiting two minutes is owed a better sentence than
      // "something went wrong" — the cause is known and it is not their fault.
      const timedOut = /exceeded the \d+ms limit/.test(detail);

      const response: AgentResponse = {
        conversationId: conversationKey,
        runId: context.runId,
        type: 'error',
        message: timedOut
          ? ORI_STATIC_FALLBACKS.tooSlow
          : ORI_STATIC_FALLBACKS.error,
        functionsUsed: [],
        requestId: context.requestId,
        userMessageId,
      };

      await this.closeRun(
        context,
        decision.intent,
        response,
        Date.now() - startedAt,
        detail,
      );

      emit({ type: 'error', channel: 'user', message: response.message });
      return response;
    }
  }

  /**
   * Bound a run by the configured deadline.
   *
   * The losing promise is not cancelled — there is no way to cancel an in-flight
   * `fetch` that another layer owns, and the provider already has its own
   * per-request timeout. What this guarantees is that the *caller* is answered:
   * the request completes, the run record closes, and the pool slot is released,
   * whatever the model does afterwards. The abandoned work finishes into a void
   * and is garbage collected.
   *
   * The timer is unref'd so a pending deadline cannot hold the process open
   * during shutdown.
   */
  private withDeadline<T>(work: Promise<T>, runId: string): Promise<T> {
    const limit = this.config.behaviour.runTimeoutMs;
    if (!Number.isFinite(limit) || limit <= 0) return work;

    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `[${runId}] abandoned after ${limit}ms — the model did not respond in time`,
        );
        reject(
          new Error(
            `Run exceeded the ${limit}ms limit. The language model did not ` +
              'respond in time.',
          ),
        );
      }, limit);
      timer.unref?.();
    });

    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * The user answered "which one did you mean". The original function runs
   * again with the chosen id filled in — the same function, so the same RBAC
   * checks and the same audit trail apply. The stored candidate list is not
   * trusted as data: only its id is reused, and the function looks the record
   * up afresh.
   */
  private async handleClarificationReply(
    run: AgentRun,
    pending: PendingDisambiguation,
    candidate: { id: number | string; label: string },
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    await this.conversations.clearPending(run.conversationKey);

    const plan: ExecutionPlan = {
      calls: [
        {
          functionName: pending.functionName,
          params: {
            ...pending.originalParams,
            [pending.resolveInto]: candidate.id,
          },
          reason: `user chose "${candidate.label}"`,
        },
      ],
      reasoning: 'Clarification reply',
      requiresSynthesis: false,
      isFallback: false,
    };

    const outcomes = await this.executor.execute(plan, run, emit);
    return this.respondTo(run, outcomes, emit);
  }

  private async handleConversational(
    run: AgentRun,
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    // "What can you do" answered from a function list alone reads like a menu.
    // The uploaded documentation is what lets it describe the product instead.
    const [catalogue, passages] = await Promise.all([
      this.registry.getCatalogueFor(
        run.context.application.id,
        run.context.role,
      ),
      this.retrieval.search(
        run.context.application.id,
        run.context.role.name,
        run.message,
        3,
      ),
    ]);

    const message = await this.synthesizer.conversational(
      run.message,
      catalogue.map((entry) => entry.description),
      run.history,
      run.context.application.id,
      emit,
      passages,
    );

    return {
      conversationId: run.conversationKey,
      runId: run.context.runId,
      type: 'answer',
      message,
      functionsUsed: [],
      requestId: run.context.requestId,
    };
  }

  private async handleDataRequest(
    run: AgentRun,
    hadStalePending: boolean,
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    // A pending question the user did not answer is stale. Drop it so a later
    // "the second one" cannot be applied to a clarification from two turns ago.
    if (hadStalePending) {
      await this.conversations.clearPending(run.conversationKey);
    }

    const catalogue = await this.registry.getCatalogueFor(
      run.context.application.id,
      run.context.role,
    );

    emit({
      type: 'catalogue.selected',
      channel: 'trace',
      functions: catalogue.map((entry) => entry.name),
    });

    emit({ type: 'stage', channel: 'user', stage: 'selecting' });

    // One search per run, shared by everything that needs it. The loop gets it
    // as vocabulary for choosing a function, the synthesizer gets it as
    // background for explaining a result, and the decline path answers from it
    // outright — three uses, one query, and the same role filter on all of them.
    const passages = await this.retrieval.search(
      run.context.application.id,
      run.context.role.name,
      run.message,
    );

    // The loop chooses, runs, reads the result, and chooses again. It emits its
    // own stage change when the first function actually starts, so the two
    // phases still read as two phases even though they now interleave.
    const loop = await this.agentLoop.run(
      run,
      catalogue,
      formatGrounding(passages),
      emit,
    );

    if (loop.outcomes.length > 0) {
      return this.respondTo(run, loop.outcomes, emit, passages);
    }

    // Nothing ran. Which of the four reasons it was decides both what the user
    // is told and where an operator should go looking.
    this.audit.recordRejection(run.context, `no calls: stop=${loop.stop}`);

    // A deliberate decline is the one case where a canned string is the wrong
    // answer. The model read the question and understood that nothing fits, so
    // the useful reply says what *would* have worked — or, when the uploaded
    // documentation covers the question, simply answers it. The loop's own
    // wording is discarded either way: it is written for a machine and has
    // never been vetted for a reader.
    if (loop.stop === 'declined' && catalogue.length > 0) {
      emit({ type: 'stage', channel: 'user', stage: 'composing' });

      const written =
        passages.length > 0
          ? await this.synthesizer.fromKnowledge(
              run.message,
              passages,
              run.history,
              run.context.application.id,
              emit,
            )
          : await this.synthesizer.conversational(
              run.message,
              catalogue.map((entry) => entry.description),
              run.history,
              run.context.application.id,
              emit,
            );

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'answer',
        message: written,
        functionsUsed: [],
        requestId: run.context.requestId,
      };
    }

    const message =
      catalogue.length === 0
        ? ORI_STATIC_FALLBACKS.nothingConfigured
        : loop.stop === 'llm-unavailable'
          ? ORI_STATIC_FALLBACKS.llmUnavailable
          : loop.stop === 'exhausted'
            ? ORI_STATIC_FALLBACKS.gaveUp
            : ORI_STATIC_FALLBACKS.cannotDo;

    emit({ type: 'message.delta', channel: 'user', text: message });

    return {
      conversationId: run.conversationKey,
      runId: run.context.runId,
      type: 'answer',
      message,
      functionsUsed: [],
      requestId: run.context.requestId,
    };
  }

  private async respondTo(
    run: AgentRun,
    outcomes: CallOutcome[],
    emit: AgentEventSink,
    passages: Passage[] = [],
  ): Promise<AgentResponse> {
    const functionsUsed = outcomes.map((outcome) => outcome.functionName);
    const reflection = this.reflector.reflect(outcomes);

    emit({ type: 'reflection', channel: 'trace', action: reflection.action });

    if (reflection.action === 'clarify') {
      const result = reflection.outcome.result;
      if (result.status !== 'ambiguous') {
        throw new Error('Reflector returned clarify for a non-ambiguous result');
      }

      const definition = await this.registry.getExecutable(
        run.context.application.id,
        reflection.outcome.functionName,
      );
      const resolveInto = definition?.ambiguityResolvesTo;

      if (!resolveInto) {
        // Save-time validation makes this unreachable; a loud failure beats
        // asking a question we could not act on the answer to.
        this.logger.error(
          `${reflection.outcome.functionName} returned ambiguous but declares no ambiguityResolvesTo`,
        );
        emit({ type: 'error', channel: 'user', message: ORI_STATIC_FALLBACKS.error });

        return {
          conversationId: run.conversationKey,
          runId: run.context.runId,
          type: 'error',
          message: ORI_STATIC_FALLBACKS.error,
          functionsUsed,
          requestId: run.context.requestId,
        };
      }

      const originalParams = { ...reflection.outcome.params };
      delete originalParams[resolveInto];

      await this.conversations.setPending(run.conversationKey, {
        functionName: reflection.outcome.functionName,
        resolveInto,
        originalParams,
        candidates: result.candidates,
        searchedBy: result.searchedBy,
        askedAt: Date.now(),
      });

      const message = this.synthesizer.clarification(
        result.candidates,
        result.searchedBy,
      );

      emit({
        type: 'clarification',
        channel: 'user',
        message,
        candidates: result.candidates,
      });

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'clarification',
        message,
        candidates: result.candidates,
        functionsUsed,
        requestId: run.context.requestId,
      };
    }

    if (reflection.action === 'nothing_found') {
      const message = this.synthesizer.nothingFound(outcomes);
      emit({ type: 'message.delta', channel: 'user', text: message });

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'answer',
        message,
        functionsUsed,
        requestId: run.context.requestId,
      };
    }

    const wroteSomething = await this.didWrite(run, outcomes);

    // Phase three: turn the rows into something a person can read. The model
    // sees humanised notes here, never the rows themselves — see evidence.ts.
    emit({ type: 'stage', channel: 'user', stage: 'composing' });

    const message = await this.synthesizer.answer(
      run.message,
      outcomes,
      run.history,
      run.context.application.id,
      emit,
      passages,
    );

    return {
      conversationId: run.conversationKey,
      runId: run.context.runId,
      type: wroteSomething ? 'confirmation' : 'answer',
      message,
      functionsUsed,
      requestId: run.context.requestId,
    };
  }

  private async didWrite(
    run: AgentRun,
    outcomes: CallOutcome[],
  ): Promise<boolean> {
    for (const outcome of outcomes) {
      if (outcome.result.status !== 'single') continue;
      const definition = await this.registry.getExecutable(
        run.context.application.id,
        outcome.functionName,
      );
      if (definition?.kind === 'write') return true;
    }
    return false;
  }

  private async openRun(
    context: RequestContext,
    conversationKey: string,
    streamed: boolean,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO ${quoteIdent(this.db.schema)}.agent_runs
           (application_id, run_key, conversation_key, end_user_id, end_user_role, streamed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_key) DO NOTHING`,
        [
          context.application.id,
          context.runId,
          conversationKey,
          context.endUser.id,
          context.endUser.role,
          streamed,
        ],
      )
      .catch((error: unknown) => {
        // Observability must never break the request it is observing.
        this.logger.warn(
          `Could not open run record: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async closeRun(
    context: RequestContext,
    intent: string,
    response: AgentResponse,
    latencyMs: number,
    error: string | null,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE ${quoteIdent(this.db.schema)}.agent_runs
            SET status = $2, intent = $3, response_type = $4,
                functions_used = $5, latency_ms = $6, error = $7,
                completed_at = now()
          WHERE run_key = $1`,
        [
          context.runId,
          error ? 'failed' : 'completed',
          intent,
          response.type,
          response.functionsUsed,
          latencyMs,
          error,
        ],
      )
      .catch((failure: unknown) => {
        // Still never fails the request — but it says so. This swallowing was
        // total, and a run that cannot be closed stays "in flight" forever in
        // the console. Combined with an open that also failed, it is how a
        // mistyped table name went unnoticed until the database was queried by
        // hand.
        this.logger.warn(
          `Could not close run record: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        );
      });
  }
}
