import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RequestContext } from '../auth/identity';
import type {
  FunctionDefinition,
  FunctionResult,
  HttpRequestSpec,
} from './function.contract';

interface ServiceRow {
  name: string;
  base_url: string;
}

const PARAM_TOKEN = /\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

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
    { entries: Map<string, string>; expiresAt: number }
  >();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
  ) {}

  async run(
    definition: FunctionDefinition,
    params: Record<string, unknown>,
    context: RequestContext,
  ): Promise<{ result: FunctionResult; afterState?: Record<string, unknown> }> {
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

    let url: URL;
    try {
      url = await this.resolveUrl(context.application.id, spec, params);
    } catch (error) {
      this.logger.error(
        `${definition.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        result: {
          status: 'error',
          message: 'That action is not configured correctly.',
          retryable: false,
        },
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

    const body =
      spec.method === 'GET' || spec.body === undefined || spec.body === null
        ? undefined
        : JSON.stringify(substituteDeep(spec.body, params));

    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.outbound.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: spec.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
        redirect: 'error',
      });

      const text = await response.text();
      const parsed = safeJson(text);

      if (!response.ok) {
        this.logger.warn(
          `${definition.name} → ${spec.method} ${url.pathname} returned ${response.status}`,
        );

        if (response.status === 401 || response.status === 403) {
          return {
            result: {
              status: 'denied',
              reason: "You don't have permission to make that change.",
            },
          };
        }

        return {
          result: {
            status: 'error',
            message: extractMessage(parsed, response.status),
            // Writes are never retried automatically. Without an idempotency
            // guarantee from the target, a retry after a timeout can duplicate
            // the change.
            retryable: false,
          },
        };
      }

      const after = isRecord(parsed) ? parsed : { response: parsed };

      return {
        result: { status: 'single', data: after, confidence: 1 },
        afterState: after,
      };
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
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves the service name to a registered base URL and applies the path. */
  private async resolveUrl(
    applicationId: number,
    spec: HttpRequestSpec,
    params: Record<string, unknown>,
  ): Promise<URL> {
    const services = await this.getServices(applicationId);
    const baseUrl = services.get(spec.service);

    if (!baseUrl) {
      throw new Error(
        `Action names service "${spec.service}", which is not registered for this application.`,
      );
    }

    // Path parameters are URL-encoded, so a value cannot introduce a new path
    // segment or a query string.
    const path = spec.path.replace(PARAM_TOKEN, (_match, name: string) =>
      encodeURIComponent(scalar(params[name])),
    );

    const url = new URL(
      path.startsWith('/') ? path.slice(1) : path,
      baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    );

    const base = new URL(baseUrl);
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

  private async getServices(
    applicationId: number,
  ): Promise<Map<string, string>> {
    const cached = this.services.get(applicationId);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;

    const rows = await this.db.query<ServiceRow>(
      `SELECT name, base_url FROM ${quoteIdent(this.db.schema)}.agent_services
        WHERE application_id = $1`,
      [applicationId],
    );

    const entries = new Map(rows.map((row) => [row.name, row.base_url]));
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

function substituteDeep(value: unknown, params: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    // A leaf that is exactly one token keeps the parameter's own type, so a
    // number stays a number rather than becoming "42".
    const exact = value.match(
      /^\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/,
    );
    if (exact?.[1]) return params[exact[1]] ?? null;

    return value.replace(PARAM_TOKEN, (_match, name: string) =>
      scalar(params[name]),
    );
  }

  if (Array.isArray(value)) {
    return value.map((entry) => substituteDeep(entry, params));
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = substituteDeep(entry, params);
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
