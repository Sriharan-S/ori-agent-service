import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { ReadDb } from '../db/read.db';
import type { RequestContext } from '../auth/identity';
import type {
  FunctionDefinition,
  FunctionResult,
  HttpRequestSpec,
  ResultArtifact,
} from './function.contract';
import {
  applyRowBounds,
  compileSqlTemplate,
  SqlTemplateError,
} from './sql-template';

interface ServiceRow {
  name: string;
  base_url: string;
  public_base_url: string | null;
}

interface ResolvedService {
  baseUrl: string;
  /** Where a link handed to a person should point. Falls back to `baseUrl`. */
  publicBaseUrl: string;
}

/** Raised when a value a token needs is absent. Always a refusal, never a 500. */
class ActionRefused extends Error {}

const PARAM_TOKEN = /\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SCOPE_TOKEN = /\{\{\s*scope\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** Only valid in a poll path, where the first response's fields are in hand. */
const RESULT_TOKEN = /\{\{\s*result\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/**
 * Executes a write function as an HTTP call back into the host application.
 *
 * Writes never touch the database. They go out through the application's own
 * API so its validation, business rules and side effects stay in force — the
 * agent is a caller of that API, not a second writer behind it.
 *
 * The target is a **registered service name**, never a URL from the function
 * body. That is deliberate: a saved function is data, and if it could name its
 * own host then anyone who could author a function could make the service issue
 * requests to internal addresses. Resolving through a service registry means
 * the set of reachable hosts is configuration an operator controls.
 */
@Injectable()
export class HttpFunctionRunner {
  private readonly logger = new Logger(HttpFunctionRunner.name);
  private readonly services = new Map<
    number,
    { entries: Map<string, ResolvedService>; expiresAt: number }
  >();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
    private readonly readDb: ReadDb,
  ) {}

  async run(
    definition: FunctionDefinition,
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{
    result: FunctionResult;
    afterState?: Record<string, unknown>;
    artifacts?: ResultArtifact[];
    scopesApplied?: Record<string, string | number>;
  }> {
    const spec = definition.httpRequest;
    if (!spec) {
      return {
        result: {
          status: 'error',
          message: 'This action has no request configured.',
          retryable: false,
        },
      };
    }

    // Prove the target is inside the caller's scope before anything leaves this
    // process. An action that has already run cannot be un-run by a later check.
    let scopesApplied: Record<string, string | number> = {};
    if (spec.precondition) {
      const guard = await this.checkPrecondition(definition, params, context);
      if (guard.result) return { result: guard.result, scopesApplied: guard.scopesApplied };
      scopesApplied = guard.scopesApplied;
    }

    let service: ResolvedService;
    let url: URL;
    try {
      service = await this.resolveService(context.application.id, spec.service);
      url = this.buildUrl(service.baseUrl, spec.path, params, context);
    } catch (error) {
      if (error instanceof ActionRefused) {
        this.logger.warn(`${definition.name} refused: ${error.message}`);
        return {
          result: { status: 'denied', reason: error.message },
          scopesApplied,
        };
      }
      this.logger.error(
        `${definition.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        result: {
          status: 'error',
          message: 'That action is not configured correctly.',
          retryable: false,
        },
        scopesApplied,
      };
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...normaliseHeaders(spec.headers ?? {}),
    };

    if (spec.forwardEndUserToken && context.endUser.token) {
      // The host API applies its own permissions to the *user*, not to the
      // agent. Without this a write would run with whatever the service
      // credential can do, which is exactly the escalation to avoid.
      headers.authorization = context.endUser.token.startsWith('Bearer ')
        ? context.endUser.token
        : `Bearer ${context.endUser.token}`;
    }

    if (spec.idempotent) {
      headers['idempotency-key'] = context.runId;
    }

    let body: string | undefined;
    try {
      body =
        spec.method === 'GET' || spec.body === undefined || spec.body === null
          ? undefined
          : JSON.stringify(substituteDeep(spec.body, params, context));
    } catch (error) {
      if (error instanceof ActionRefused) {
        return { result: { status: 'denied', reason: error.message }, scopesApplied };
      }
      throw error;
    }

    if (body !== undefined) headers['content-type'] = 'application/json';

    let parsed: unknown;
    try {
      const first = await this.send(url, {
        method: spec.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      if (first.failure) {
        this.logger.warn(
          `${definition.name} → ${spec.method} ${url.pathname} returned ${first.status}`,
        );
        return { result: first.failure, scopesApplied };
      }

      parsed = first.payload;

      // The host accepted the work but has not done it yet. Follow the job it
      // named until it settles, and answer with the finished thing.
      if (spec.poll) {
        const settled = await this.awaitJob(definition, spec, service, parsed);
        if (settled.result) return { result: settled.result, scopesApplied };
        parsed = settled.payload;
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      this.logger.error(
        `${definition.name} → ${spec.method} ${url.pathname} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        result: {
          status: 'error',
          message: aborted
            ? 'That action timed out. It may or may not have been applied — check before retrying.'
            : 'That action could not be completed.',
          retryable: false,
        },
        scopesApplied,
      };
    }

    const after = isRecord(parsed) ? parsed : { response: parsed };
    const artifacts = this.collectArtifacts(definition, spec, service, after);

    return {
      result: { status: 'single', data: after, confidence: 1 },
      afterState: after,
      ...(artifacts.length > 0 ? { artifacts } : {}),
      scopesApplied,
    };
  }

  /**
   * One outbound request, with the service-wide timeout applied.
   *
   * `redirect: 'error'` rather than following: a redirect is a host telling us
   * to go somewhere the origin check never saw.
   */
  private async send(
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ payload: unknown; status: number; failure?: FunctionResult }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.outbound.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
      });

      const payload = safeJson(await response.text());
      if (response.ok) return { payload, status: response.status };

      if (response.status === 401 || response.status === 403) {
        return {
          payload,
          status: response.status,
          failure: {
            status: 'denied',
            reason: "You don't have permission to make that change.",
          },
        };
      }

      return {
        payload,
        status: response.status,
        failure: {
          status: 'error',
          message: extractMessage(payload, response.status),
          // Writes are never retried automatically. Without an idempotency
          // guarantee from the target, a retry after a timeout can duplicate
          // the change.
          retryable: false,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Follow a background job to its conclusion.
   *
   * Two bounds, both of which must hold: the function's own attempt count, and
   * the service-wide ceiling on how long any caller is made to wait. Neither is
   * the author's to exceed.
   */
  private async awaitJob(
    definition: FunctionDefinition,
    spec: HttpRequestSpec,
    service: ResolvedService,
    accepted: unknown,
  ): Promise<{ payload?: unknown; result?: FunctionResult }> {
    const poll = spec.poll!;
    const interval = Math.max(
      poll.intervalMs ?? 2000,
      this.config.outbound.pollMinIntervalMs,
    );
    const maxAttempts = Math.max(1, poll.maxAttempts ?? 20);
    const deadline = Date.now() + this.config.outbound.pollMaxMs;

    let url: URL;
    try {
      url = this.pollUrl(service, poll, accepted);
    } catch (error) {
      this.logger.error(
        `${definition.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        result: {
          status: 'error',
          message:
            'That action was started but the service did not say where to follow it up.',
          retryable: false,
        },
      };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (Date.now() >= deadline) break;

      const polled = await this.send(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });

      if (polled.failure) {
        this.logger.warn(
          `${definition.name} poll ${attempt}/${maxAttempts} → ${polled.status}`,
        );
        return { result: polled.failure };
      }

      // `scalar` rather than String(): a host that answers with an object here
      // would otherwise compare as "[object Object]" and never match anything,
      // turning a misconfiguration into a silent timeout.
      const status = scalar(
        isRecord(polled.payload) ? polled.payload[poll.statusField] : null,
      );

      if (poll.successWhen.includes(status)) {
        this.logger.log(
          `${definition.name} job finished after ${attempt} poll(s)`,
        );
        return { payload: polled.payload };
      }

      if ((poll.failureWhen ?? []).includes(status)) {
        return {
          result: {
            status: 'error',
            message: extractMessage(polled.payload, 500),
            retryable: true,
          },
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining));
    }

    // Not a failure: the work is very likely still running. Saying so is more
    // useful, and more honest, than reporting an error the host never gave.
    this.logger.warn(`${definition.name} job did not finish within the wait`);
    return {
      result: {
        status: 'error',
        message:
          'That is still being prepared — it is taking longer than usual. Ask me again shortly.',
        retryable: true,
      },
    };
  }

  /** Where to follow the job up, checked against the service's own origin. */
  private pollUrl(
    service: ResolvedService,
    poll: NonNullable<HttpRequestSpec['poll']>,
    accepted: unknown,
  ): URL {
    const record = isRecord(accepted) ? accepted : {};

    if (poll.urlFrom) {
      const raw = record[poll.urlFrom];
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(
          `Response holds no usable "${poll.urlFrom}" to poll (got ${JSON.stringify(raw)}).`,
        );
      }
      // The value came out of a response body, so it is not trusted to name its
      // own host: it is resolved against the registered base and rejected if it
      // lands anywhere else.
      return pinToOrigin(service.baseUrl, raw);
    }

    if (poll.path) {
      const path = poll.path.replace(RESULT_TOKEN, (_match, field: string) =>
        encodeURIComponent(scalar(readPath(record, field))),
      );
      return pinToOrigin(service.baseUrl, path);
    }

    throw new Error('Poll configuration names neither urlFrom nor path.');
  }

  /**
   * The values that must reach the user unaltered.
   *
   * Deliberately not merged into the data the model sees: a link goes out
   * verbatim or not at all.
   */
  private collectArtifacts(
    definition: FunctionDefinition,
    spec: HttpRequestSpec,
    service: ResolvedService,
    payload: Record<string, unknown>,
  ): ResultArtifact[] {
    const artifacts: ResultArtifact[] = [];
    const result = spec.result;
    if (!result) return artifacts;

    if (result.link) {
      const raw = readPath(payload, result.link.from);
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          artifacts.push({
            label: result.link.label ?? 'Open',
            // Rebuilt against the public base URL: the host may have answered
            // with a path, or with an address only reachable from inside.
            url: pinToOrigin(service.publicBaseUrl, raw).toString(),
          });
        } catch (error) {
          this.logger.warn(
            `${definition.name}: discarding link "${raw}" — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    for (const field of result.expose ?? []) {
      const raw = readPath(payload, field.from);
      if (raw === null || raw === undefined || raw === '') continue;
      artifacts.push({ label: field.label ?? field.from, value: scalar(raw) });
    }

    return artifacts;
  }

  /**
   * Run the scope guard.
   *
   * Compiled by the same engine as every read function and against the same
   * declared `scopeFilters`, so "refusing to run unscoped" means here exactly
   * what it means there.
   */
  private async checkPrecondition(
    definition: FunctionDefinition,
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{
    result?: FunctionResult;
    scopesApplied: Record<string, string | number>;
  }> {
    const precondition = definition.httpRequest!.precondition!;

    let compiled;
    try {
      compiled = compileSqlTemplate({
        template: precondition.sqlTemplate,
        params,
        scopeFilters: definition.scopeFilters,
        scopeValues: context.endUser.scopes,
        unscopedKeys: context.role.unscopedKeys,
      });
    } catch (error) {
      if (error instanceof SqlTemplateError) {
        this.logger.warn(
          `${definition.name} refused for role ${context.role.name}: ${error.message}`,
        );
        return {
          result: {
            status: 'denied',
            reason: precondition.denyMessage ?? 'You do not have access to that.',
          },
          scopesApplied: {},
        };
      }
      throw error;
    }

    const bounded = applyRowBounds(compiled, 1, 0);

    try {
      const probe = await this.readDb.query<Record<string, unknown>>(
        bounded.sql,
        bounded.values,
        { label: `precondition:${definition.name}` },
      );

      if (probe.rows.length === 0) {
        this.logger.warn(
          `${definition.name} refused: precondition matched no row for ${context.endUser.id}`,
        );
        return {
          result: {
            status: 'denied',
            reason: precondition.denyMessage ?? 'You do not have access to that.',
          },
          scopesApplied: compiled.scopesApplied,
        };
      }
    } catch (error) {
      this.logger.error(
        `${definition.name} precondition failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // A guard that could not run has not passed.
      return {
        result: {
          status: 'error',
          message: 'That action could not be checked, so it was not attempted.',
          retryable: true,
        },
        scopesApplied: {},
      };
    }

    return { scopesApplied: compiled.scopesApplied };
  }

  /** Applies the path template to the registered base URL. */
  private buildUrl(
    baseUrl: string,
    template: string,
    params: Record<string, unknown>,
    context: RequestContext,
  ): URL {
    // Values are URL-encoded, so one cannot introduce a new path segment or a
    // query string.
    const path = template
      .replace(PARAM_TOKEN, (_match, name: string) =>
        encodeURIComponent(scalar(params[name])),
      )
      .replace(SCOPE_TOKEN, (_match, key: string) =>
        encodeURIComponent(scalar(readScope(key, context))),
      );

    return pinToOrigin(baseUrl, path);
  }

  private async resolveService(
    applicationId: number,
    name: string,
  ): Promise<ResolvedService> {
    const services = await this.getServices(applicationId);
    const service = services.get(name);

    if (!service) {
      throw new Error(
        `Action names service "${name}", which is not registered for this application.`,
      );
    }

    return service;
  }

  private async getServices(
    applicationId: number,
  ): Promise<Map<string, ResolvedService>> {
    const cached = this.services.get(applicationId);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;

    const rows = await this.db.query<ServiceRow>(
      `SELECT name, base_url, public_base_url
         FROM ${quoteIdent(this.db.schema)}.agent_services
        WHERE application_id = $1`,
      [applicationId],
    );

    const entries = new Map(
      rows.map((row): [string, ResolvedService] => [
        row.name,
        {
          baseUrl: row.base_url,
          publicBaseUrl: row.public_base_url || row.base_url,
        },
      ]),
    );

    this.services.set(applicationId, {
      entries,
      expiresAt: Date.now() + 30_000,
    });

    return entries;
  }

  invalidate(): void {
    this.services.clear();
  }
}

/**
 * Resolve a path or URL against a base, and refuse anything that leaves it.
 *
 * Used for the outbound path, for the follow-up URL a host names in its own
 * response, and for the link handed back to the user. The second of those is
 * why this exists as a shared function rather than a check done once: a URL out
 * of a response body is attacker-adjacent input, and resolving it without
 * re-pinning would turn any host that can be made to echo a URL into a request
 * forgery primitive.
 */
function pinToOrigin(baseUrl: string, candidate: string): URL {
  const base = new URL(baseUrl);
  const url = new URL(
    candidate.startsWith('/') ? candidate.slice(1) : candidate,
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
  );

  if (url.origin !== base.origin) {
    throw new Error(
      `Resolved URL ${url.origin} escapes the registered service origin ${base.origin}.`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Refusing protocol ${url.protocol}.`);
  }

  return url;
}

/**
 * A scope value for a token in a path or body.
 *
 * Exemption is not an answer here. A role exempt from `user_id` sees every
 * user's rows, which is a coherent thing to say about a filter and an incoherent
 * one about an identifier an action must act *on* — there is no "every user" to
 * put in a URL. So an exempt role is refused rather than sent an empty segment,
 * which would otherwise silently address the wrong resource.
 */
function readScope(key: string, context: RequestContext): string | number {
  if (context.role.unscopedKeys.includes(key)) {
    throw new ActionRefused(
      `This action acts on a specific ${key.replace(/_/g, ' ')}, and the ${context.role.name} ` +
        'role supplies none. Look the record up first and use the action that takes its id.',
    );
  }

  const value = context.endUser.scopes[key];
  if (value === undefined || value === null || value === '') {
    throw new ActionRefused(
      `This action needs a ${key.replace(/_/g, ' ')} and none was supplied.`,
    );
  }

  return value;
}

/** `a.b.c` against a parsed payload. Absent at any step yields undefined. */
function readPath(payload: unknown, path: string): unknown {
  let cursor: unknown = payload;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function substituteDeep(
  value: unknown,
  params: Record<string, unknown>,
  context: RequestContext,
): unknown {
  if (typeof value === 'string') {
    // A leaf that is exactly one token keeps the value's own type, so a number
    // stays a number rather than becoming "42".
    const exactParam = value.match(
      /^\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/,
    );
    if (exactParam?.[1]) return params[exactParam[1]] ?? null;

    const exactScope = value.match(
      /^\{\{\s*scope\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/,
    );
    if (exactScope?.[1]) return readScope(exactScope[1], context);

    return value
      .replace(PARAM_TOKEN, (_match, name: string) => scalar(params[name]))
      .replace(SCOPE_TOKEN, (_match, key: string) =>
        scalar(readScope(key, context)),
      );
  }

  if (Array.isArray(value)) {
    return value.map((entry) => substituteDeep(entry, params, context));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = substituteDeep(entry, params, context);
    }
    return output;
  }

  return value;
}

function normaliseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    // Authorization is set by the engine from the end user's token, never from
    // a stored function body — a saved header must not be able to smuggle a
    // credential in.
    if (lower === 'authorization' || lower === 'cookie') continue;
    output[lower] = value;
  }
  return output;
}

function safeJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Render a parameter for interpolation into a path or a string body leaf.
 *
 * Parameters are validated to scalars before they reach here, so this is
 * defence in depth — but `String(…)` on an object yields "[object Object]",
 * which would silently send nonsense to a host API rather than failing loudly.
 */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    const message = payload.message ?? payload.error;
    if (typeof message === 'string' && message.length < 300) return message;
  }
  return `That action was rejected (HTTP ${status}).`;
}
