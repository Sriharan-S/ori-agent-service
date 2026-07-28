import type { Candidate } from './function.contract';

export interface AmbiguityThresholds {
  /**
   * Minimum lead the top match needs over the runner-up to be trusted.
   * `gap >= gapThreshold` → single; `gap < gapThreshold` → ambiguous.
   */
  gapThreshold: number;
  /** With rivals present, a top score below this is never trusted outright. */
  minConfidentScore: number;
  /** Search terms this short or shorter are held to `shortTermMinScore`. */
  shortTermLength: number;
  /** Stricter bar for short terms — "Ana" matches far too many people. */
  shortTermMinScore: number;
}

export interface ScoredMatch {
  /**
   * Whatever the host application identifies the record by. Opaque to the
   * agent — it is echoed back into the resolving parameter, never interpreted.
   */
  id: number | string;
  label: string;
  detail?: string;
  score: number;
}

export type AmbiguityDecision<T extends ScoredMatch> =
  | { outcome: 'empty' }
  | { outcome: 'single'; match: T; confidence: number }
  | { outcome: 'ambiguous'; candidates: Candidate[] };

/**
 * Decide whether a fuzzy lookup resolved to one record or must ask the user.
 *
 * This is the ported heart of the predecessor's `executePersonLookup`. The rule
 * that matters is that "more than one row" is **not** ambiguity — a clear
 * winner is a clear winner. Ambiguity is when the field is close, or when the
 * best match is not actually very good.
 *
 * Three ways to end up ambiguous:
 *   1. The runner-up is within `gapThreshold` of the top (the main rule).
 *   2. Rivals exist and the top score is below `minConfidentScore`.
 *   3. The search term was very short and the top score is below the
 *      stricter `shortTermMinScore`.
 *
 * Note on boundaries: the predecessor treated a gap of exactly `6` as
 * ambiguous (`gap <= 6`); this follows the plan's §5.4 rule (`gap >= threshold`
 * → single), so at the default threshold of 6 an exact-6 gap now resolves. Both
 * are defensible; the threshold is configurable and covered by tests.
 *
 * @param matches sorted by score descending
 * @param searchTerm what the user searched by, used for the short-term rule
 */
export function decideAmbiguity<T extends ScoredMatch>(
  matches: readonly T[],
  searchTerm: string,
  thresholds: AmbiguityThresholds,
  maxCandidates = 8,
): AmbiguityDecision<T> {
  if (matches.length === 0) {
    return { outcome: 'empty' };
  }

  const top = matches[0]!;

  if (matches.length === 1) {
    return { outcome: 'single', match: top, confidence: confidenceFor(top.score, null) };
  }

  const second = matches[1]!;
  const gap = top.score - second.score;
  const isShortTerm = searchTerm.trim().length <= thresholds.shortTermLength;

  const tooClose = gap < thresholds.gapThreshold;
  const topNotGoodEnough = top.score < thresholds.minConfidentScore;
  const shortTermNotGoodEnough =
    isShortTerm && top.score < thresholds.shortTermMinScore;

  if (tooClose || topNotGoodEnough || shortTermNotGoodEnough) {
    return {
      outcome: 'ambiguous',
      candidates: matches.slice(0, maxCandidates).map(toCandidate),
    };
  }

  return {
    outcome: 'single',
    match: top,
    confidence: confidenceFor(top.score, second.score),
  };
}

function toCandidate(match: ScoredMatch): Candidate {
  return {
    id: match.id,
    label: match.label,
    ...(match.detail ? { detail: match.detail } : {}),
    score: match.score,
  };
}

/**
 * Confidence in the resolved match: high when the score is high and nothing
 * else came close. Reported to the orchestrator, which uses it for chaining.
 */
function confidenceFor(topScore: number, secondScore: number | null): number {
  const base = Math.min(topScore / 100, 1);
  if (secondScore === null) return round(Math.max(base, 0.6));

  const separation = Math.min((topScore - secondScore) / 100, 0.2);
  return round(Math.min(Math.max(base * 0.85 + separation, 0.5), 0.99));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
