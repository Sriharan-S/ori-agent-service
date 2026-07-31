import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import type { ChatMessage } from '../llm/llm.types';
import type { Candidate } from '../registry/function.contract';
import type { ConversationTurn } from '../memory/conversation.service';
import type { AgentEventSink, CallOutcome } from './orchestrator.types';
import { presentRecord, presentRecords } from './evidence';
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
═══ NOTES: THE ONLY FACTS YOU MAY USE ═══
${buildEvidence(outcomes)}`,
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

      switch (result.status) {
        case 'single': {
          const described = presentRecord(result.data);
          return described === null
            ? 'A record was found but it held nothing worth reporting.'
            : `One record was found:\n${described}`;
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
          return `This step failed — ${result.message}`;
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

function formatHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return '';
  const recent = history
    .slice(-4)
    .map((turn) => `${turn.role}: ${turn.content.slice(0, 300)}`)
    .join('\n');
  return `\n═══ RECENT CONVERSATION ═══\n${recent}\n`;
}

