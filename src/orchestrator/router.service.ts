import { Injectable, Logger } from '@nestjs/common';
import type { Candidate } from '../registry/function.contract';
import type { PendingDisambiguation } from '../memory/conversation.service';
import type { Intent, RouterDecision } from './orchestrator.types';

const GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i;
const THANKS = /^(thanks|thank you|ta|cheers|great|nice|perfect|ok(ay)?)\b[\s!.]*$/i;

/**
 * "What can you do", in the shapes people actually type it.
 *
 * The first version of this required the literal phrase `what can you do`, so
 * "show me what you can do" and "Tell me what you can do?" both missed — the
 * words are the same but the auxiliary moves. They fell through to the read
 * path, where the planner was then obliged to pick a data function for a
 * question about capabilities, and answered "what can you do" by reciting one
 * student's registration record.
 *
 * Matching is on the parts that do not move: a "can/could you"-style ability
 * question, or a request to be shown capabilities, in either word order.
 */
const CAPABILITY = new RegExp(
  [
    // what can you do / what you can do / what do you do / what are you able to do
    'what\\s+(can|could|do|are)\\s+you\\b',
    'what\\s+you\\s+can\\b',
    // show me / tell me / list what you can do
    '(show|tell|list|explain)\\s+(me\\s+)?(what|which|your)\\b.*\\b(do|help|capabilit|feature|function|support)',
    // who are you / how do you work / your capabilities
    'who\\s+are\\s+you\\b',
    'how\\s+(do|does)\\s+(you|this)\\s+work\\b',
    'your\\s+capabilit',
    '\\bhelp\\s+me\\b',
    // what can I ask you
    'what\\s+(can|should)\\s+i\\s+(ask|say|do)\\b',
  ].join('|'),
  'i',
);

const WRITE_VERB =
  /\b(update|change|rename|set|edit|modify|correct|fix|delete|remove|deactivate|disable|enable|reset|assign|approve|reject)\b/i;

/**
 * Classifies the incoming message before any expensive work happens.
 *
 * Deliberately heuristic. The router runs on every request, and the four
 * classes are separable by structure rather than nuance: a clarification reply
 * is defined by conversation state, not wording; a write is announced by a
 * verb; a greeting is a greeting. Spending a model call here would add latency
 * to every turn to decide something a regex already gets right.
 *
 * If the class boundaries blur as the function set grows, swap `classify` for a
 * small-model call — the interface is designed for that and nothing downstream
 * depends on how the decision was reached.
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  classify(
    message: string,
    pending: PendingDisambiguation | null,
  ): RouterDecision {
    const text = message.trim();

    if (pending) {
      const resolved = this.matchCandidate(text, pending);
      if (resolved) {
        return {
          intent: 'clarification-reply',
          reason: `matched pending candidate ${resolved.id}`,
          pending,
          resolvedCandidate: resolved,
        };
      }

      // A pending question the reply does not answer means the user moved on.
      // Fall through to normal routing; the orchestrator clears the pending
      // state so a stale candidate list cannot be applied to a later turn.
      this.logger.debug(
        'Pending clarification exists but the reply does not select a candidate — routing normally',
      );
    }

    const intent = this.classifyFresh(text);
    return { intent, reason: `heuristic:${intent}` };
  }

  private classifyFresh(text: string): Intent {
    if (GREETING.test(text) || THANKS.test(text) || CAPABILITY.test(text)) {
      return 'conversational';
    }
    if (WRITE_VERB.test(text)) {
      return 'write';
    }
    return 'read';
  }

  /**
   * Resolve a reply against the candidates we asked about.
   *
   * Accepts the three ways people actually answer: the ordinal ("the second
   * one"), the name, or the raw id. An answer that matches several candidates
   * equally is not a resolution — it leaves the clarification pending rather
   * than guessing, which is the same rule that produced the question.
   */
  private matchCandidate(
    reply: string,
    pending: PendingDisambiguation,
  ): Candidate | null {
    const text = reply.trim().toLowerCase();
    if (text.length === 0) return null;

    const ordinal = this.parseOrdinal(text);
    if (ordinal !== null && ordinal >= 1 && ordinal <= pending.candidates.length) {
      return pending.candidates[ordinal - 1] ?? null;
    }

    const byId = pending.candidates.find(
      (candidate) => String(candidate.id) === text,
    );
    if (byId) return byId;

    const exact = pending.candidates.filter(
      (candidate) => candidate.label.toLowerCase() === text,
    );
    if (exact.length === 1) return exact[0]!;

    const contains = pending.candidates.filter((candidate) =>
      candidate.label.toLowerCase().includes(text),
    );
    if (contains.length === 1) return contains[0]!;

    return null;
  }

  private parseOrdinal(text: string): number | null {
    const words: Record<string, number> = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
    };

    for (const [word, value] of Object.entries(words)) {
      if (new RegExp(`\\b${word}\\b`).test(text)) return value;
    }

    // "2", "2.", "#2", "option 2", "the 2nd one"
    const numeric = text.match(/^(?:option\s*|the\s*|#)?(\d{1,2})(?:st|nd|rd|th)?[.)]?(?:\s+one)?$/);
    return numeric?.[1] ? Number(numeric[1]) : null;
  }
}
