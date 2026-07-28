import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AgentRequest } from '../auth/api-key.guard';

/**
 * Catch-all route pattern for `forRoutes`.
 *
 * `'{*splat}'` is the path-to-regexp v8 spelling that Express 5 expects. Nest 11
 * currently normalises a bare `'*'` to something equivalent, so both work today
 * — this uses the explicit form so a future Nest that stops normalising does not
 * break the boot.
 *
 * Exported so `test/unit/middleware-route.spec.ts` can prove the pattern still
 * initialises against whatever Express version is installed.
 */
export const MIDDLEWARE_ROUTE_PATTERN = '{*splat}';

/**
 * Assigns a correlation id to every request and echoes it back.
 *
 * Honours an inbound `x-request-id` so a trace started in OriginBI carries
 * through, but only when it looks like an id — an arbitrary header value ends
 * up in logs and audit rows, so it is length-checked and character-restricted.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: AgentRequest, res: Response, next: NextFunction): void {
    const inbound = req.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    req.requestId =
      typeof candidate === 'string' && /^[\w-]{8,64}$/.test(candidate)
        ? candidate
        : randomUUID();

    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
