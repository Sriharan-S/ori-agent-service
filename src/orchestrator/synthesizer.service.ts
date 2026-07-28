import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import type { ChatMessage } from '../llm/llm.types';
import type { Candidate } from '../registry/function.contract';
import type { ConversationTurn } from '../memory/conversation.service';
import type { AgentEventSink, CallOutcome } from './orchestrator.types';
import {
  ORI_CONVERSATIONAL_PERSONA,
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

  constructor(private readonly llm: LlmService) {}

  async answer(
    question: string,
    outcomes: CallOutcome[],
    history: ConversationTurn[],
    applicationId: number,
    emit: AgentEventSink,
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

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORI_SYNTHESIZER_PERSONA}

═══ WHAT THE USER ASKED ═══
${question}
${formatHistory(history)}
═══ RESULTS (the only facts you may use) ═══
${buildEvidence(outcomes)}`,
      },
      {
        role: 'user',
        content:
          'Write the answer now. Plain prose or a short markdown list. ' +
          'Do not mention functions, queries or how the data was retrieved.',
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

      return text.trim();
    } catch (error) {
      this.logger.error(
        `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // A deterministic rendering beats an error when the data is already here.
      const fallback = renderWithoutLlm(outcomes);
      emit({ type: 'message.delta', channel: 'user', text: fallback });
      return fallback;
    }
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

  /** Small talk and "what can you do". No data, so no evidence block. */
  async conversational(
    question: string,
    capabilities: string[],
    history: ConversationTurn[],
    applicationId: number,
    emit: AgentEventSink,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `${ORI_CONVERSATIONAL_PERSONA}

═══ WHAT YOU CAN ACTUALLY DO (describe only these) ═══
${capabilities.map((line) => `- ${line}`).join('\n') || '- Nothing is configured yet.'}
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
 * The results, serialized, each tagged with how it turned out so the model
 * cannot mistake an empty result for a zero or a denial for an absence.
 */
function buildEvidence(outcomes: CallOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const { result } = outcome;

      switch (result.status) {
        case 'single':
          return `Result (one record found):\n${stringify(result.data)}`;
        case 'list':
          return (
            `Result (${result.data.length} of ${result.total} records` +
            `${result.truncated ? ', more available' : ''}):\n${stringify(result.data)}`
          );
        case 'empty':
          return `Result: nothing matched ${result.searchedBy}.`;
        case 'denied':
          return `Result: access denied — ${result.reason}`;
        case 'error':
          return `Result: this step failed — ${result.message}`;
        case 'ambiguous':
          // Unreachable: the reflector short-circuits before synthesis.
          return `Result: several records matched ${result.searchedBy}.`;
        default:
          return 'Result: unavailable.';
      }
    })
    .join('\n\n');
}

function renderWithoutLlm(outcomes: CallOutcome[]): string {
  const parts: string[] = [];

  for (const outcome of outcomes) {
    const { result } = outcome;
    if (result.status === 'single') {
      parts.push(formatRecord(result.data));
    } else if (result.status === 'list') {
      parts.push(
        `${result.total} record${result.total === 1 ? '' : 's'} found:`,
        ...result.data.slice(0, 20).map((row) => `- ${formatRecord(row)}`),
      );
    }
  }

  return parts.length > 0
    ? parts.join('\n')
    : ORI_STATIC_FALLBACKS.llmUnavailable;
}

function formatHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return '';
  const recent = history
    .slice(-4)
    .map((turn) => `${turn.role}: ${turn.content.slice(0, 300)}`)
    .join('\n');
  return `\n═══ RECENT CONVERSATION ═══\n${recent}\n`;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 6000);
}

/** One-line summary of a record, for the no-LLM path. */
function formatRecord(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value);

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, entry]) => entry !== null && entry !== undefined)
    .slice(0, 6)
    .map(([key, entry]) => `${key}: ${String(entry)}`);

  return entries.length > 0 ? entries.join(', ') : '(empty record)';
}
