import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Client, Pool, type QueryResultRow } from 'pg';
import { CONFIG, type AppConfig } from '../config/configuration';
import { explainConnectionError } from './primary.db';

export interface ReadQueryOptions {
  statementTimeoutMs?: number;
  /** Label for logs and metrics. Usually the registry function name. */
  label?: string;
}

export interface ReadQueryResult<T> {
  rows: T[];
  rowCount: number;
  durationMs: number;
  fields: string[];
}

export interface WriteAssertionResult {
  /** Whether the guard ran at all. False when explicitly disabled for dev. */
  enforced: boolean;
  passed: boolean;
  /** How the guarantee is provided: a standby, or a role without write grants. */
  basis: 'standby' | 'no-write-privileges' | 'disabled' | 'unknown';
  /** Schemas the role could create objects in. Empty is the desired state. */
  creatableSchemas: string[];
  checkedAt: Date | null;
  /** Set when the assertion failed: which tables this role can modify. */
  writableTables: string[];
}

export type ReadDbStage =
  | 'not-configured'
  | 'unreachable'
  /** Connected, but these credentials can write. Refused, not used. */
  | 'writable'
  | 'ready';

export interface ReadDbStatus {
  stage: ReadDbStage;
  error: string | null;
  detail: string | null;
  checkedAt: Date | null;
}

/**
 * The connection that executes registry functions.
 *
 * This is the single most important boundary in the service. Registry SQL is
 * written by administrators through the management API — reviewed by a human,
 * but still data rather than reviewed-and-deployed code. What makes that safe
 * to execute is not the save-time validator; it is that this connection
 * **physically cannot write**, proven before the pool opens.
 *
 * Layers, in order of authority:
 *   1. The role or replica endpoint rejects writes (the real guarantee).
 *   2. `runWriteAssertion` proves layer 1 holds for these credentials, and the
 *      pool is only created if it does.
 *   3. Every query runs in a READ ONLY transaction with a statement timeout.
 *
 * A failed assertion used to kill the process. It now refuses to open the pool
 * instead, which is the same guarantee reached a better way: no registry SQL
 * can execute either way, but the console comes up and says which tables the
 * role can write and how to fix it. A crash loop tells nobody anything.
 */
@Injectable()
export class ReadDb implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReadDb.name);
  private pool: Pool | null = null;
  private ready = false;
  private assertion: WriteAssertionResult = {
    enforced: true,
    passed: false,
    basis: 'unknown',
    creatableSchemas: [],
    checkedAt: null,
    writableTables: [],
  };
  private status: ReadDbStatus = {
    stage: 'not-configured',
    error: null,
    detail: null,
    checkedAt: null,
  };

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /** What the write guard concluded. Surfaced in the console. */
  getWriteAssertion(): WriteAssertionResult {
    return this.assertion;
  }

  getStatus(): ReadDbStatus {
    return this.status;
  }

  /** Live pool usage, for the console's database view. */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool?.totalCount ?? 0,
      idle: this.pool?.idleCount ?? 0,
      waiting: this.pool?.waitingCount ?? 0,
    };
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  /** Re-runs the guard and reopens the pool. Called by the setup screen. */
  async connect(): Promise<ReadDbStatus> {
    const { db } = this.config;

    await this.closePool();
    this.ready = false;

    if (!db.readUrl) {
      return this.record({
        stage: 'not-configured',
        error:
          'No read connection is configured. Set DATABASE_READ_URL to a role that ' +
          'holds SELECT and nothing else, or to a read replica. Registry functions ' +
          'run on it, and its inability to write is what makes them safe to run.',
        detail: null,
      });
    }

    const assertion = await this.runWriteAssertion(db.readUrl);

    if (assertion.kind === 'unreachable') {
      return this.record({
        stage: 'unreachable',
        error: explainConnectionError(assertion.error, 'DATABASE_READ_URL'),
        detail: message(assertion.error),
      });
    }

    if (assertion.kind === 'writable') {
      return this.record({
        stage: 'writable',
        error:
          'DATABASE_READ_URL can modify data, so the read connection has not been ' +
          'opened. This connection executes administrator-authored SQL, and a role ' +
          'without write privileges is the only thing stopping that SQL from ' +
          'changing anything. Point it at a SELECT-only role or a read replica.',
        detail: `Writable tables include: ${assertion.tables.join(', ')}`,
      });
    }

    this.pool = new Pool({
      connectionString: db.readUrl,
      max: db.readPoolMax,
      connectionTimeoutMillis: db.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      statement_timeout: db.statementTimeoutMs,
      application_name: 'ori-agent:read',
    });

    this.pool.on('error', (error) => {
      this.logger.error(`Idle read client error: ${error.message}`);
    });

    try {
      const probe = await this.pool.connect();
      try {
        await probe.query('SELECT 1');
      } finally {
        probe.release();
      }
    } catch (error) {
      await this.closePool();
      return this.record({
        stage: 'unreachable',
        error: explainConnectionError(error, 'DATABASE_READ_URL'),
        detail: message(error),
      });
    }

    this.ready = true;
    this.logger.log(
      `Read connection ready (max=${db.readPoolMax}, statement_timeout=${db.statementTimeoutMs}ms)`,
    );

    return this.record({ stage: 'ready', error: null, detail: null });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closePool();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  private record(patch: Omit<ReadDbStatus, 'checkedAt'>): ReadDbStatus {
    this.status = { ...patch, checkedAt: new Date() };
    if (patch.error) this.logger.warn(patch.error);
    return this.status;
  }

  private async closePool(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.end().catch(() => undefined);
  }

  /**
   * The pool, or the reason there isn't one.
   *
   * Every path that could execute registry SQL goes through here, so a failed
   * write assertion is not something a caller can route around.
   */
  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error(
        this.status.error ??
          'The read connection is not available. Open /admin to see why.',
      );
    }
    return this.pool;
  }

  /**
   * Run a compiled registry query.
   *
   * `text` always comes from `compileSqlTemplate`, which emits `$n` placeholders
   * and nothing else — there is no path by which a parameter value reaches this
   * string.
   */
  async query<T extends QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown>,
    options: ReadQueryOptions = {},
  ): Promise<ReadQueryResult<T>> {
    const pool = this.requirePool();

    const timeoutMs = Math.min(
      options.statementTimeoutMs ?? this.config.db.statementTimeoutMs,
      this.config.db.statementTimeoutMs,
    );

    const startedAt = Date.now();
    const client = await pool.connect();

    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT set_config($1, $2, true)', [
        'statement_timeout',
        String(timeoutMs),
      ]);

      const result = await client.query<T>(text, params as unknown[]);
      await client.query('COMMIT');

      const durationMs = Date.now() - startedAt;
      this.logger.debug(
        `read[${options.label ?? 'unlabelled'}] ${result.rowCount ?? 0} rows in ${durationMs}ms`,
      );

      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
        durationMs,
        fields: result.fields.map((field) => field.name),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ask Postgres to parse and plan a statement without running it.
   *
   * This is how a saved function is validated. The lesson from the predecessor
   * was that a regex cannot parse SQL — so this does not try. It hands the
   * statement to the actual parser, inside a READ ONLY transaction, which also
   * means anything that is not a read is rejected by the server rather than by
   * a keyword blocklist.
   */
  async explain(
    text: string,
    params: ReadonlyArray<unknown>,
    timeoutMs = 3000,
  ): Promise<{ ok: true; plan: string } | { ok: false; error: string }> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT set_config($1, $2, true)', [
        'statement_timeout',
        String(timeoutMs),
      ]);

      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (VERBOSE false, COSTS false) ${text}`,
        params as unknown[],
      );
      await client.query('ROLLBACK');

      return {
        ok: true,
        plan: result.rows.map((row) => row['QUERY PLAN']).join('\n'),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Boot-time proof that these credentials cannot modify data.
   *
   * What this deliberately does **not** do is attempt `CREATE TEMP TABLE`.
   * Postgres grants `TEMP` on a database to `PUBLIC` by default, so a correctly
   * configured read-only role creates temp tables happily — the probe would
   * reject every valid deployment while proving nothing about user data.
   *
   * Nor does it trust `default_transaction_read_only`. That is a session
   * default, and any client can undo it with `SET TRANSACTION READ WRITE`. It
   * is a convenience, not a guarantee.
   *
   * What actually matters is whether this role holds a write privilege on any
   * table. `has_table_privilege` is the authoritative answer: it resolves role
   * inheritance and grants made to `PUBLIC`, which is exactly where an
   * unintended privilege tends to hide.
   */
  private async runWriteAssertion(connectionString: string): Promise<
    | { kind: 'passed' }
    | { kind: 'writable'; tables: string[] }
    | { kind: 'unreachable'; error: unknown }
  > {
    if (this.config.db.allowWritableReadPool) {
      this.logger.warn(
        'DB_ALLOW_WRITABLE_READ_POOL=true — the write-assertion guard is DISABLED. ' +
          'Administrator-authored SQL is no longer contained. Local development only.',
      );
      this.assertion = {
        enforced: false,
        passed: false,
        basis: 'disabled',
        creatableSchemas: [],
        checkedAt: new Date(),
        writableTables: [],
      };
      return { kind: 'passed' };
    }

    const client = new Client({
      connectionString,
      connectionTimeoutMillis: this.config.db.connectTimeoutMs,
      application_name: 'ori-agent:write-assertion',
    });

    try {
      await client.connect();
    } catch (error) {
      this.assertion = {
        enforced: true,
        passed: false,
        basis: 'unknown',
        creatableSchemas: [],
        checkedAt: new Date(),
        writableTables: [],
      };
      return { kind: 'unreachable', error };
    }

    try {
      // A physical standby cannot accept a write at all, whatever the grants.
      const recovery = await client.query<{ in_recovery: boolean }>(
        'SELECT pg_is_in_recovery() AS in_recovery',
      );

      if (recovery.rows[0]?.in_recovery === true) {
        this.logger.log(
          'Read connection write assertion passed: the server is a standby in recovery.',
        );
        this.assertion = {
          enforced: true,
          passed: true,
          basis: 'standby',
          creatableSchemas: [],
          checkedAt: new Date(),
          writableTables: [],
        };
        return { kind: 'passed' };
      }

      const writable = await client.query<{
        relation: string;
        privileges: string;
      }>(
        `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS relation,
                array_to_string(ARRAY(
                  SELECT p FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) AS p
                   WHERE has_table_privilege(c.oid, p)
                ), ', ') AS privileges
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
            AND n.nspname NOT LIKE 'pg_temp%'
            AND (has_table_privilege(c.oid, 'INSERT')
              OR has_table_privilege(c.oid, 'UPDATE')
              OR has_table_privilege(c.oid, 'DELETE')
              OR has_table_privilege(c.oid, 'TRUNCATE'))
          ORDER BY 1
          LIMIT 10`,
      );

      if (writable.rowCount && writable.rowCount > 0) {
        const tables = writable.rows.map(
          (row) => `${row.relation} (${row.privileges})`,
        );

        this.assertion = {
          enforced: true,
          passed: false,
          basis: 'unknown',
          creatableSchemas: [],
          checkedAt: new Date(),
          writableTables: tables,
        };

        this.logger.error(
          'DATABASE_READ_URL can modify data. The read pool has NOT been opened, so ' +
            'no registry function can run. Writable tables include: ' +
            tables.join(', '),
        );

        return { kind: 'writable', tables };
      }

      // Not fatal on its own — creating a table modifies no existing row — but
      // a genuinely read-only role has no business holding it.
      const creatable = await client.query<{ nspname: string }>(
        `SELECT n.nspname
           FROM pg_namespace n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_%'
            AND has_schema_privilege(n.oid, 'CREATE')
          ORDER BY 1
          LIMIT 5`,
      );

      const creatableSchemas = creatable.rows.map((row) => row.nspname);

      if (creatableSchemas.length > 0) {
        this.logger.warn(
          `The read connection holds CREATE on schema(s): ${creatableSchemas.join(', ')}. ` +
            'It cannot alter existing data, but a read-only role should not be able ' +
            'to create objects either. Consider revoking it.',
        );
      }

      this.assertion = {
        enforced: true,
        passed: true,
        basis: 'no-write-privileges',
        creatableSchemas,
        checkedAt: new Date(),
        writableTables: [],
      };

      this.logger.log(
        'Read connection write assertion passed: no write privilege on any user table.',
      );

      return { kind: 'passed' };
    } catch (error) {
      this.assertion = {
        enforced: true,
        passed: false,
        basis: 'unknown',
        creatableSchemas: [],
        checkedAt: new Date(),
        writableTables: [],
      };
      return { kind: 'unreachable', error };
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
