// Loaded here rather than relying on ConfigModule: `loadConfiguration()` is
// called while this module is being imported, which happens before Nest has
// initialised anything. dotenv does not override variables that are already
// set, so a real environment (Docker, CI, production) still wins.
import 'dotenv/config';

/**
 * Typed configuration loaded once at boot.
 *
 * This service is product-agnostic: nothing here names a domain concept. What
 * the agent can *do* lives in the database (functions, roles, models,
 * applications), not in the environment. The environment describes where the
 * database is, who may administer the service, and how to bootstrap.
 */

export interface AppConfig {
  service: {
    port: number;
    nodeEnv: string;
    logLevel: string;
    isProduction: boolean;
    publicUrl: string;
  };
  db: {
    /** Primary. Used only for the agent's own schema. */
    primaryUrl: string;
    /**
     * Read-only role or replica endpoint. The only connection that executes
     * registry functions. Asserted non-writable at boot.
     */
    readUrl: string;
    schema: string;
    poolMax: number;
    readPoolMax: number;
    statementTimeoutMs: number;
    connectTimeoutMs: number;
    /** Local development only; refused in production. */
    allowWritableReadPool: boolean;
  };
  security: {
    /** 32-byte key, base64 or hex. Encrypts model credentials at rest. */
    encryptionKey: string;
    /** Bootstrap admin, created on first boot if no admin exists. */
    bootstrapAdminEmail: string;
    bootstrapAdminPassword: string;
    sessionTtlHours: number;
  };
  llm: {
    /** Seed model, written to the models table on first boot if it is empty. */
    seedBaseUrl: string;
    seedModel: string;
    seedApiKey: string;
    defaultTimeoutMs: number;
    defaultMaxOutputTokens: number;
    defaultTemperature: number;
    breakerThreshold: number;
    breakerCooldownMs: number;
    /**
     * Attempts per model for a non-streaming call, before falling over to the
     * next one. 2 means one retry. Raise it only for an endpoint whose failures
     * are genuinely transient — every extra attempt is another timeout's worth
     * of latency in the worst case.
     */
    maxAttemptsPerModel: number;
  };
  behaviour: {
    disambiguationGapThreshold: number;
    disambiguationMinConfidentScore: number;
    disambiguationShortTermLength: number;
    disambiguationShortTermMinScore: number;
    defaultRowLimit: number;
    maxRowLimit: number;
    maxCandidatesReturned: number;
    registryCacheTtlMs: number;
    maxPlannedCalls: number;
    /**
     * Turns of the agent loop before it gives up. Each turn is one model call
     * plus at most `maxPlannedCalls` function calls, so this bounds both the
     * latency and the token cost of a single question. Four covers
     * lookup → act → check, with one spare for a corrected retry.
     */
    maxAgentSteps: number;
    /** Upper bound on a single agent run, streaming included. */
    runTimeoutMs: number;
  };
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  outbound: {
    /** Timeout for HTTP action functions calling back into a host app. */
    timeoutMs: number;
    /** Extra hostnames allowed as action targets beyond registered services. */
    allowedHosts: string[];
    /**
     * Ceiling on waiting for a host application's background job, whatever a
     * function's own interval and attempt count add up to. A caller is waiting
     * on the other end of this, and a job that has not finished by now is
     * better reported as still running than held open.
     */
    pollMaxMs: number;
    /** Floor on a function's poll interval, so a tight loop cannot be authored. */
    pollMinIntervalMs: number;
  };
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined && value !== ''
    ? parsed
    : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function str(value: string | undefined, fallback = ''): string {
  return value === undefined || value === '' ? fallback : value;
}

/**
 * A pino level, or the default.
 *
 * pino throws on an unknown level, and that throw happens inside the logger
 * factory during module initialisation — so `LOG_LEVEL=log` took the whole
 * service down with "default level:log must be included in custom levels".
 * Nothing about a log level is worth refusing to start over.
 */
function level(value: string | undefined): string {
  const allowed = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  const chosen = str(value, 'info').toLowerCase();
  return allowed.includes(chosen) ? chosen : 'info';
}

function list(value: string | undefined): string[] {
  return str(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfiguration(): AppConfig {
  const env = process.env;
  const nodeEnv = str(env.NODE_ENV, 'development');
  const port = num(env.PORT, 3200);

  return {
    service: {
      port,
      nodeEnv,
      logLevel: level(env.LOG_LEVEL),
      isProduction: nodeEnv === 'production',
      publicUrl: str(env.PUBLIC_URL, `http://localhost:${port}`),
    },
    db: {
      primaryUrl: str(env.DATABASE_URL),
      readUrl: str(env.DATABASE_READ_URL),
      schema: str(env.DATABASE_SCHEMA, 'ori'),
      poolMax: num(env.DB_POOL_MAX, 10),
      readPoolMax: num(env.DB_READ_POOL_MAX, 10),
      statementTimeoutMs: num(env.DB_STATEMENT_TIMEOUT_MS, 5000),
      connectTimeoutMs: num(env.DB_CONNECT_TIMEOUT_MS, 10000),
      allowWritableReadPool: bool(env.DB_ALLOW_WRITABLE_READ_POOL, false),
    },
    security: {
      encryptionKey: str(env.ENCRYPTION_KEY),
      bootstrapAdminEmail: str(env.BOOTSTRAP_ADMIN_EMAIL),
      bootstrapAdminPassword: str(env.BOOTSTRAP_ADMIN_PASSWORD),
      sessionTtlHours: num(env.ADMIN_SESSION_TTL_HOURS, 12),
    },
    llm: {
      seedBaseUrl: str(env.LLM_SEED_BASE_URL),
      seedModel: str(env.LLM_SEED_MODEL),
      seedApiKey: str(env.LLM_SEED_API_KEY),
      defaultTimeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
      defaultMaxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 1024),
      defaultTemperature: num(env.LLM_TEMPERATURE, 0.1),
      maxAttemptsPerModel: num(env.LLM_MAX_ATTEMPTS_PER_MODEL, 2),
      breakerThreshold: num(env.LLM_BREAKER_THRESHOLD, 5),
      breakerCooldownMs: num(env.LLM_BREAKER_COOLDOWN_MS, 30000),
    },
    behaviour: {
      disambiguationGapThreshold: num(env.DISAMBIGUATION_GAP_THRESHOLD, 6),
      disambiguationMinConfidentScore: num(
        env.DISAMBIGUATION_MIN_CONFIDENT_SCORE,
        90,
      ),
      disambiguationShortTermLength: num(
        env.DISAMBIGUATION_SHORT_TERM_LENGTH,
        3,
      ),
      disambiguationShortTermMinScore: num(
        env.DISAMBIGUATION_SHORT_TERM_MIN_SCORE,
        95,
      ),
      defaultRowLimit: num(env.DEFAULT_ROW_LIMIT, 50),
      maxRowLimit: num(env.MAX_ROW_LIMIT, 200),
      maxCandidatesReturned: num(env.MAX_CANDIDATES_RETURNED, 8),
      registryCacheTtlMs: num(env.REGISTRY_CACHE_TTL_MS, 30000),
      maxPlannedCalls: num(env.MAX_PLANNED_CALLS, 3),
      maxAgentSteps: num(env.MAX_AGENT_STEPS, 4),
      runTimeoutMs: num(env.RUN_TIMEOUT_MS, 120000),
    },
    rateLimit: {
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60000),
      maxRequests: num(env.RATE_LIMIT_MAX_REQUESTS, 30),
    },
    outbound: {
      timeoutMs: num(env.OUTBOUND_TIMEOUT_MS, 10000),
      allowedHosts: list(env.OUTBOUND_ALLOWED_HOSTS),
      pollMaxMs: num(env.OUTBOUND_POLL_MAX_MS, 60000),
      pollMinIntervalMs: num(env.OUTBOUND_POLL_MIN_INTERVAL_MS, 500),
    },
  };
}

export interface ConfigProblem {
  variable: string;
  /** `blocking` means the service cannot do its job until it is fixed. */
  severity: 'blocking' | 'warning';
  message: string;
  fix: string;
}

/**
 * Everything wrong with the environment, as data.
 *
 * This used to throw, which meant a first deployment with a typo in
 * `DATABASE_URL` exited before it could serve anything — including the page
 * that would have explained the typo. Configuration problems are now reported
 * to the setup screen instead, so the fix is visible in the place you are
 * already looking.
 *
 * `validateConfig` still exists for the one class of problem where continuing
 * is worse than stopping: an explicitly disabled security guarantee in
 * production.
 */
export function inspectConfiguration(config: AppConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];

  if (!config.db.primaryUrl) {
    problems.push({
      variable: 'DATABASE_URL',
      severity: 'blocking',
      message:
        'No database is configured. This service keeps its own tables inside a ' +
        'Postgres database you already run; it does not have one of its own.',
      fix: 'DATABASE_URL=postgres://user:password@host:5432/your_database',
    });
  }

  if (!config.db.readUrl) {
    problems.push({
      variable: 'DATABASE_READ_URL',
      severity: 'blocking',
      message:
        'No read-only connection is configured. Registry functions run on it, and ' +
        'the fact that it cannot write is what makes running them safe.',
      fix: 'DATABASE_READ_URL=postgres://readonly_user:password@host:5432/your_database',
    });
  }

  if (
    config.db.primaryUrl &&
    config.db.primaryUrl === config.db.readUrl &&
    !config.db.allowWritableReadPool
  ) {
    problems.push({
      variable: 'DATABASE_READ_URL',
      severity: 'blocking',
      message:
        'DATABASE_URL and DATABASE_READ_URL are identical, so the read connection ' +
        'can write. This is nearly always a copy-paste error.',
      fix: 'Point DATABASE_READ_URL at a SELECT-only role or a read replica.',
    });
  }

  if (!config.security.encryptionKey) {
    problems.push({
      variable: 'ENCRYPTION_KEY',
      severity: 'blocking',
      message:
        'No encryption key is set. Model provider credentials are encrypted at ' +
        'rest with it, so no model can be saved without one.',
      fix: 'Generate one with: openssl rand -base64 32',
    });
  } else if (decodeEncryptionKey(config.security.encryptionKey).length !== 32) {
    problems.push({
      variable: 'ENCRYPTION_KEY',
      severity: 'blocking',
      message:
        'ENCRYPTION_KEY must decode to exactly 32 bytes, as base64 or hex. ' +
        `This one decodes to ${decodeEncryptionKey(config.security.encryptionKey).length}.`,
      fix: 'Generate one with: openssl rand -base64 32',
    });
  }

  if (
    config.service.logLevel !== (process.env.LOG_LEVEL ?? 'info').toLowerCase() &&
    process.env.LOG_LEVEL
  ) {
    problems.push({
      variable: 'LOG_LEVEL',
      severity: 'warning',
      message: `"${process.env.LOG_LEVEL}" is not a log level, so "info" is being used instead.`,
      fix: 'One of: trace, debug, info, warn, error, fatal, silent.',
    });
  }

  if (config.db.allowWritableReadPool) {
    problems.push({
      variable: 'DB_ALLOW_WRITABLE_READ_POOL',
      severity: 'warning',
      message:
        'The write guard is disabled, so a registry function could modify or ' +
        'delete data. Intended for local development against a throwaway database.',
      fix: 'Unset it, and give DATABASE_READ_URL a SELECT-only role.',
    });
  }

  if (
    config.behaviour.defaultRowLimit > config.behaviour.maxRowLimit ||
    config.behaviour.maxRowLimit <= 0
  ) {
    problems.push({
      variable: 'MAX_ROW_LIMIT',
      severity: 'blocking',
      message:
        `DEFAULT_ROW_LIMIT (${config.behaviour.defaultRowLimit}) must be less than ` +
        `or equal to MAX_ROW_LIMIT (${config.behaviour.maxRowLimit}), which must be above zero.`,
      fix: 'Set DEFAULT_ROW_LIMIT=50 and MAX_ROW_LIMIT=200, or values of your own.',
    });
  }

  return problems;
}

/**
 * The only configuration that still stops the process.
 *
 * Booting into a setup screen is the right answer for a missing variable. It is
 * the wrong answer for an operator who has deliberately switched off the guard
 * that contains administrator-authored SQL, in production, where there is real
 * data to lose.
 */
export function validateConfig(config: AppConfig): void {
  if (config.service.isProduction && config.db.allowWritableReadPool) {
    throw new Error(
      'DB_ALLOW_WRITABLE_READ_POOL must never be true in production. It disables ' +
        'the guarantee that admin-authored SQL cannot write.',
    );
  }
}

/** Accepts base64 or hex. Exported so validation and crypto agree on the rule. */
export function decodeEncryptionKey(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

export const CONFIG = 'ORI_APP_CONFIG';
