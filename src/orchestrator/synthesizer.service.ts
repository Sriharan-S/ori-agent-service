import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import type { ChatMessage } from '../llm/llm.types';
import type { Candidate } from '../registry/function.contract';
import type { ConversationTurn } from '../memory/conversation.service';
import {
  formatReference,
  formatSources,
} from '../knowledge/knowledge-prompt';
import type { Passage } from '../knowledge/retrieval.service';
import { ResponsePolicyService } from '../policy/response-policy.service';
import type { AgentEventSink, CallOutcome } from './orchestrator.types';
import { presentRecord, presentRecords } from './evidence';
import {
  ORI_CONVERSATIONAL_PERSONA,
  ORI_KNOWLEDGE_PERSONA,
  ORI_STATIC_FALLBACKS,
  ORI_SYNTHESIZER_PERSONA,
} from './ori-persona';

/**
 * Turns function results into what the user reads.
 *
 * Three output modes: a final answer, a clarifying question, and an action
 * confirmation. The clarifying question is generated without the model — a list
 * of candidates is a list of candidates, and sending it through an LLM only
 * adds latency and a chance to drop one or rename it.
 *
 * The answer is streamed. Deltas go out as they arrive, so the caller sees text
 * appearing rather than waiting for a complete response.
 */
@Injectable()
export class SynthesizerService {
  private readonly logger = new Logger(SynthesizerService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly policy: ResponsePolicyService,
  ) {}

  async answer(
    question: string,
    outcomes: CallOutcome[],
    history: ConversationTurn[],
    applicationId: number,
    emit: AgentEventSink,
    /** Documentation that explains the results. Never a source of facts. */
    passages: Passage[] = [],
  ): Promise<string> {
    const denials = outcomes.filter(
      (outcome) => outcome.result.status === 'denied',
    );
    const usable = outcomes.filter(
      (outcome) =>
        outcome.result.status === 'single' || outcome.result.status === 'list',
    );

    // A pure denial is the policy's own wording. Do not paraphrase a refusal.
    if (usable.length === 0 && denials.length > 0) {
      const first = denials[0]!.result;
      const message =
        first.status === 'denied' ? first.reason : ORI_STATIC_FALLBACKS.noPermission;
      emit({ type: 'message.delta', channel: 'user', text: message });
      return message;
    }

    // The same policy the reasoning half was given. A writer that has not been
    // told what it may cover softens answers the operator explicitly allowed.
    const policy = await this.policy.compilePrompt(applicationId);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORI_SYNTHESIZER_PERSONA}
${policy}
═══ WHAT THE USER ASKED ═══
${question}
${formatHistory(history)}
═══ NOTES: THE ONLY FACTS YOU MAY USE ═══
${buildEvidence(outcomes)}
${formatReference(passages)}`,
      },
      {
        role: 'user',
        content:
          'Answer their question now, in your own words, as if you already knew ' +
          'this. One or two sentences unless more is genuinely needed. Do not ' +
          'describe the notes, do not list fields, and do not mention where the ' +
          'information came from.',
      },
    ];

    try {
      let text = '';
      const stream = this.llm.stream(messages, {
        purpose: 'synthesizer',
        applicationId,
        temperature: 0.2,
      });

      for (;;) {
        const next = await stream.next();
        if (next.done) break;
        text += next.value;
        emit({ type: 'message.delta', channel: 'user', text: next.value });
      }

      return this.appendArtifacts(text.trim(), outcomes, emit);
    } catch (error) {
      this.logger.error(
        `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // A deterministic rendering beats an error when the data is already here.
      const fallback = renderWithoutLlm(outcomes);
      emit({ type: 'message.delta', channel: 'user', text: fallback });
      return this.appendArtifacts(fallback, outcomes, emit);
    }
  }

  /**
   * Put links and one-time values into the answer without the model's help.
   *
   * The model is told an artifact exists but never shown it — see
   * `buildEvidence`. Appending here is what makes that safe: the URL in the
   * answer is the URL the host returned, not a reconstruction of it, and a
   * password is quoted rather than paraphrased. Both are also emitted as their
   * own events, so a richer client can render a button and ignore this text.
   */
  private appendArtifacts(
    answer: string,
    outcomes: CallOutcome[],
    emit: AgentEventSink,
  ): string {
    const artifacts = outcomes.flatMap((outcome) => outcome.artifacts ?? []);
    if (artifacts.length === 0) return answer;

    const lines = artifacts.map((artifact) =>
      artifact.url
        ? `- [${artifact.label}](${artifact.url})`
        : `- ${artifact.label}: \`${artifact.value ?? ''}\``,
    );

    const appended = `\n\n${lines.join('\n')}`;
    emit({ type: 'message.delta', channel: 'user', text: appended });
    return `${answer}${appended}`;
  }

  /** The clarifying question. Built without the model, deliberately. */
  clarification(candidates: Candidate[], searchedBy: string): string {
    const lines = candidates.map((candidate, index) => {
      const detail = candidate.detail ? ` — ${candidate.detail}` : '';
      return `${index + 1}. **${candidate.label}**${detail}`;
    });

    return [
      `I found ${candidates.length} matches for ${searchedBy}. Which one did you mean?`,
      '',
      ...lines,
      '',
      'Reply with the number or the full name.',
    ].join('\n');
  }

  /**
   * An answer built entirely from uploaded documentation.
   *
   * Reached when the question is a real one, no function serves it, and the
   * knowledge base covers it — "what does the Agile band mean", "how long do
   * credits last". This is the only path that answers without touching live
   * data, which is why it is the only one that cites: the reader has to be able
   * to tell documentation from records.
   */
  async fromKnowledge(
    question: string,
    passages: Passage[],
    history: ConversationTurn[],
    applicationId: number,
    emit: AgentEventSink,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORI_KNOWLEDGE_PERSONA}
${await this.policy.compilePrompt(applicationId)}
${formatHistory(history)}
═══ WHAT THE DOCUMENTATION SAYS ═══
${formatSources(passages)}`,
      },
      { role: 'user', content: question },
    ];

    try {
      let text = '';
      const stream = this.llm.stream(messages, {
        purpose: 'synthesizer',
        applicationId,
        temperature: 0.2,
        maxTokens: 600,
      });

      for (;;) {
        const next = await stream.next();
        if (next.done) break;
        text += next.value;
        emit({ type: 'message.delta', channel: 'user', text: next.value });
      }

      return text.trim();
    } catch (error) {
      this.logger.error(`Knowledge answer failed: ${describeError(error)}`);
      emit({
        type: 'message.delta',
        channel: 'user',
        text: ORI_STATIC_FALLBACKS.llmUnavailable,
      });
      return ORI_STATIC_FALLBACKS.llmUnavailable;
    }
  }

  /** Small talk and "what can you do". No data, so no evidence block. */
  async conversational(
    question: string,
    capabilities: string[],
    history: ConversationTurn[],
    applicationId: number,
    emit: AgentEventSink,
    /** Product documentation, so "what can you do" is not just a function list. */
    passages: Passage[] = [],
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORI_CONVERSATIONAL_PERSONA}
${await this.policy.compilePrompt(applicationId)}
═══ WHAT YOU CAN ACTUALLY DO (describe only these) ═══
${capabilities.map((line) => `- ${line}`).join('\n') || '- Nothing is configured yet.'}
${formatReference(passages)}
${formatHistory(history)}`,
      },
      { role: 'user', content: question },
    ];

    try {
      let text = '';
      const stream = this.llm.stream(messages, {
        purpose: 'synthesizer',
        applicationId,
        temperature: 0.4,
        maxTokens: 400,
      });

      for (;;) {
        const next = await stream.next();
        if (next.done) break;
        text += next.value;
        emit({ type: 'message.delta', channel: 'user', text: next.value });
      }

      return text.trim();
    } catch {
      const fallback =
        capabilities.length > 0
          ? `I can help with: ${capabilities.slice(0, 5).join('; ')}.`
          : ORI_STATIC_FALLBACKS.llmUnavailable;
      emit({ type: 'message.delta', channel: 'user', text: fallback });
      return fallback;
    }
  }

  /** Nothing matched. Says what was searched for rather than shrugging. */
  nothingFound(outcomes: CallOutcome[]): string {
    const empty = outcomes.find((outcome) => outcome.result.status === 'empty');
    if (empty && empty.result.status === 'empty') {
      return ORI_STATIC_FALLBACKS.emptyResult(empty.result.searchedBy);
    }

    const errored = outcomes.find((outcome) => outcome.result.status === 'error');
    if (errored && errored.result.status === 'error') {
      return errored.result.message;
    }

    return ORI_STATIC_FALLBACKS.notUnderstood;
  }
}

/**
 * The facts, as readable notes rather than rows.
 *
 * Each block is still tagged with how the call turned out, so the model cannot
 * mistake an empty result for a zero or a denial for an absence. What changed is
 * the vocabulary: values arrive already humanised by `evidence.ts`, so the model
 * has no column names to parrot back. See that file for why prompting alone was
 * not enough.
 */
function buildEvidence(outcomes: CallOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const { result } = outcome;

      // An artifact is named but never shown. The model needs to know one is
      // coming so the sentence it writes makes room for it ("here is your
      // report"), and must not see the value, because a model that has seen a
      // URL will eventually write a subtly different one.
      const artifactNote =
        outcome.artifacts && outcome.artifacts.length > 0
          ? `\nThe following will be shown to the user directly, immediately after your answer: ${outcome.artifacts
              .map((artifact) => artifact.label.toLowerCase())
              .join(', ')}. Refer to it as ready. Do not invent a link or a code.`
          : '';

      switch (result.status) {
        case 'single': {
          const described = presentRecord(result.data);
          return described === null
            ? `The action completed.${artifactNote}`
            : `One record was found:\n${described}${artifactNote}`;
        }
        case 'list': {
          if (result.data.length === 0) return 'Nothing was found.';
          const described = presentRecords(result.data);
          const count =
            result.total === result.data.length
              ? `${result.total} record(s) found`
              : `${result.data.length} of ${result.total} record(s) shown`;
          return `${count}:\n${described}`;
        }
        case 'empty':
          return `Nothing matched ${result.searchedBy}.`;
        case 'denied':
          return `Access denied — ${result.reason}`;
        case 'error':
          // Spelled out because the model will otherwise soften it into a
          // waiting state. Asked to generate a report against a service that
          // was down, it answered "the report is not ready yet" — which reads
          // as *in progress*, so the user waits for something that will never
          // arrive and does not know to retry. A failure has to sound like one.
          return (
            `This step FAILED and produced nothing: ${result.message}\n` +
            'Nothing was created, changed or retrieved by it. Tell the user ' +
            'plainly that it could not be done. Do NOT describe it as pending, ' +
            'in progress, being prepared, on its way, or "not ready yet" — none ' +
            'of those are true, and none of them will become true by waiting.'
          );
        case 'ambiguous':
          // Unreachable: the reflector short-circuits before synthesis.
          return `Several records matched ${result.searchedBy}.`;
        default:
          return 'Unavailable.';
      }
    })
    .join('\n\n');
}

/**
 * What to say when the model died but the data is already in hand.
 *
 * Deliberately plain and clearly mechanical. It uses the same humanised
 * presentation as the prompt, so even this degraded path does not emit column
 * names — but it makes no attempt to sound like prose, because pretending to be
 * a written answer when nothing wrote it is worse than obviously being a listing.
 */
function renderWithoutLlm(outcomes: CallOutcome[]): string {
  const parts: string[] = [];

  for (const outcome of outcomes) {
    const { result } = outcome;

    if (result.status === 'single') {
      const described = presentRecord(result.data);
      if (described) parts.push(`Here is what I have:\n${described}`);
    } else if (result.status === 'list' && result.data.length > 0) {
      const described = presentRecords(result.data, 20);
      if (described) {
        parts.push(
          `I found ${result.total} result${result.total === 1 ? '' : 's'}:`,
          described,
        );
      }
    }
  }

  return parts.length > 0
    ? parts.join('\n')
    : ORI_STATIC_FALLBACKS.llmUnavailable;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return '';
  const recent = history
    .slice(-4)
    .map((turn) => `${turn.role}: ${turn.content.slice(0, 300)}`)
    .join('\n');
  return `\n═══ RECENT CONVERSATION ═══\n${recent}\n`;
}

