import { Injectable, Logger } from '@nestjs/common';
import type { CallOutcome } from './orchestrator.types';
import { overallConfidence } from './orchestrator.types';

export type ReflectionAction =
  | { action: 'clarify'; outcome: CallOutcome }
  | { action: 'answer' }
  | { action: 'nothing_found' };

/**
 * Decides what to do with a set of outcomes before an answer is written.
 *
 * The one rule that is not negotiable, and that the predecessor had no
 * equivalent of: **`status: 'ambiguous'` short-circuits straight to a
 * clarifying question.** It is never re-planned around, never resolved by
 * picking the top candidate, and never overridden by a confidence score. An
 * ambiguous result is the function telling us it does not know which record was
 * meant; no amount of downstream reasoning can supply that knowledge.
 *
 * Everything else is a judgement about whether there is enough to answer with.
 */
@Injectable()
export class ReflectorService {
  private readonly logger = new Logger(ReflectorService.name);

  reflect(outcomes: CallOutcome[]): ReflectionAction {
    const ambiguous = outcomes.find(
      (outcome) => outcome.result.status === 'ambiguous',
    );
    if (ambiguous) {
      this.logger.debug(
        `${ambiguous.functionName} returned ambiguous — short-circuiting to clarification`,
      );
      return { action: 'clarify', outcome: ambiguous };
    }

    const usable = outcomes.filter(
      (outcome) =>
        outcome.result.status === 'single' || outcome.result.status === 'list',
    );

    if (usable.length > 0) {
      this.logger.debug(
        `Answering from ${usable.length} result(s), confidence ${overallConfidence(usable)}`,
      );
      return { action: 'answer' };
    }

    // Denials carry their own message and must reach the user as written; the
    // synthesizer handles them. Everything else that produced no data is a
    // "nothing found".
    const denied = outcomes.some(
      (outcome) => outcome.result.status === 'denied',
    );
    if (denied) return { action: 'answer' };

    return { action: 'nothing_found' };
  }
}
