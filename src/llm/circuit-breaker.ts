/**
 * Per-context circuit breaker, ported in spirit from `utils/llm-fallback.ts`.
 *
 * The predecessor kept a quota cooldown keyed by call site so that one
 * rate-limited planner call did not make every subsequent call pay the primary
 * timeout before failing over. That behaviour is preserved and generalised:
 * consecutive failures of any kind trip the breaker, and a quota/rate-limit
 * error trips it immediately.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(context: string): boolean {
    const until = this.openUntil.get(context) ?? 0;
    if (until > this.now()) return true;
    if (until !== 0) {
      // Cooldown elapsed — half-open: let the next call through.
      this.openUntil.delete(context);
      this.failures.delete(context);
    }
    return false;
  }

  remainingMs(context: string): number {
    return Math.max(0, (this.openUntil.get(context) ?? 0) - this.now());
  }

  recordSuccess(context: string): void {
    this.failures.delete(context);
    this.openUntil.delete(context);
  }

  /** @param immediate trip on this single failure (quota/rate-limit) */
  recordFailure(context: string, immediate = false): void {
    if (immediate) {
      this.openUntil.set(context, this.now() + this.cooldownMs);
      return;
    }

    const count = (this.failures.get(context) ?? 0) + 1;
    this.failures.set(context, count);

    if (count >= this.threshold) {
      this.openUntil.set(context, this.now() + this.cooldownMs);
    }
  }
}

/**
 * Quota and rate-limit detection, carried over from the predecessor. These
 * errors mean "stop asking for a while", which is different from a transient
 * failure worth retrying immediately.
 */
export function isQuotaOrRateLimitError(error: unknown): boolean {
  const err = error as {
    message?: string;
    status?: number;
    statusCode?: number;
    code?: string;
  } | null;

  const status = Number(err?.status ?? err?.statusCode ?? 0);
  if (status === 429 || status === 503) return true;

  const code = String(err?.code ?? '').toLowerCase();
  if (code.includes('rate_limit') || code.includes('quota')) return true;

  const message = String(err?.message ?? '').toLowerCase();
  return (
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429')
  );
}
