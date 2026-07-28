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
      logLevel: str(env.LOG_LEVEL, 'info'),
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
      runTimeoutMs: num(env.RUN_TIMEOUT_MS, 120000),
    },
    rateLimit: {
      windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60000),
      maxRequests: num(env.RATE_LIMIT_MAX_REQUESTS, 30),
    },
    outbound: {
      timeoutMs: num(env.OUTBOUND_TIMEOUT_MS, 10000),
      allowedHosts: list(env.OUTBOUND_ALLOWED_HOSTS),
    },
  };
}

/** Fail fast on misconfiguration rather than 500-ing on the first request. */
export function validateConfig(config: AppConfig): void {
  const missing: string[] = [];

  if (!config.db.primaryUrl) missing.push('DATABASE_URL');
  if (!config.db.readUrl) missing.push('DATABASE_READ_URL');
  if (!config.security.encryptionKey) missing.push('ENCRYPTION_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. See .env.example.`,
    );
  }

  if (decodeEncryptionKey(config.security.encryptionKey).length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex). ' +
        'Generate one with: openssl rand -base64 32',
    );
  }

  if (config.service.isProduction && config.db.allowWritableReadPool) {
    throw new Error(
      'DB_ALLOW_WRITABLE_READ_POOL must never be true in production. It disables ' +
        'the guarantee that admin-authored SQL cannot write.',
    );
  }

  if (
    config.db.primaryUrl === config.db.readUrl &&
    !config.db.allowWritableReadPool
  ) {
    // Not fatal — the boot assertion is the real check, and it will fail if
    // these credentials can write. Named here because it is nearly always a
    // copy-paste error rather than an intentional read-only primary.
    throw new Error(
      'DATABASE_URL and DATABASE_READ_URL are identical. DATABASE_READ_URL must ' +
        'use a read-only role or a replica endpoint — it is the only thing ' +
        'preventing an admin-authored function from writing.',
    );
  }

  if (
    config.behaviour.defaultRowLimit > config.behaviour.maxRowLimit ||
    config.behaviour.maxRowLimit <= 0
  ) {
    throw new Error(
      `Invalid row limits: DEFAULT_ROW_LIMIT (${config.behaviour.defaultRowLimit}) ` +
        `must be <= MAX_ROW_LIMIT (${config.behaviour.maxRowLimit}), and MAX_ROW_LIMIT > 0.`,
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
