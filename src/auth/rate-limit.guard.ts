import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import type { AgentRequest } from './api-key.guard';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limit, keyed on (application, end user).
 *
 * Runs after ApiKeyGuard so the key is a real identity rather than an IP — an
 * agent run costs GPU time, so it is worth limiting per user rather than per
 * connection. Keying on the application too means one tenant cannot exhaust
 * another's budget.
 *
 * In-process state: with more than one replica the effective limit is
 * `maxRequests × replicas`. Move to Redis before scaling out.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<AgentRequest>();
    const context = request.context;
    if (!context) return true;

    const { windowMs, maxRequests } = this.config.rateLimit;
    const key = `${context.application.id}:${context.endUser.id}`;
    const now = Date.now();

    this.sweep(now);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (existing.count >= maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded. Try again in ${retryAfterSeconds}s.`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    existing.count += 1;
    return true;
  }

  /** Drops expired windows so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
