import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Client, Pool, type QueryResultRow } from 'pg';
import { CONFIG, type AppConfig } from '../config/configuration';

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

/**
 * The connection that executes registry functions.
 *
 * This is the single most important boundary in the service. Registry SQL is
 * written by administrators through the management API — reviewed by a human,
 * but still data rather than reviewed-and-deployed code. What makes that safe
 * to execute is not the save-time validator; it is that this connection
 * **physically cannot write**, proven at boot.
 *
 * Layers, in order of authority:
 *   1. The role or replica endpoint rejects writes (the real guarantee).
 *   2. `assertCannotWrite` proves layer 1 holds for these credentials.
 *   3. Every query runs in a READ ONLY transaction with a statement timeout.
 */
@Injectable()
export class ReadDb implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReadDb.name);
  private pool: Pool | null = null;
  private ready = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const { db } = this.config;

    await this.assertCannotWrite(db.readUrl);

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

    const probe = await this.pool.connect();
    try {
      await probe.query('SELECT 1');
    } finally {
      probe.release();
    }

    this.ready = true;
    this.logger.log(
      `Read connection ready (max=${db.readPoolMax}, statement_timeout=${db.statementTimeoutMs}ms)`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
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
    if (!this.pool) throw new Error('Read connection is not initialised');

    const timeoutMs = Math.min(
      options.statementTimeoutMs ?? this.config.db.statementTimeoutMs,
      this.config.db.statementTimeoutMs,
    );

    const startedAt = Date.now();
    const client = await this.pool.connect();

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
    if (!this.pool) throw new Error('Read connection is not initialised');

    const client = await this.pool.connect();
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
   * Boot-time proof that these credentials cannot write.
   *
   * Runs on a dedicated client so the pool's own READ ONLY transactions cannot
   * mask a writable connection, and explicitly promotes the transaction to READ
   * WRITE first — we are testing the server's capability, not our settings.
   */
  private async assertCannotWrite(connectionString: string): Promise<void> {
    if (this.config.db.allowWritableReadPool) {
      this.logger.warn(
        'DB_ALLOW_WRITABLE_READ_POOL=true — the write-assertion guard is DISABLED. ' +
          'Admin-authored SQL is no longer contained. Local development only.',
      );
      return;
    }

    const client = new Client({
      connectionString,
      connectionTimeoutMillis: this.config.db.connectTimeoutMs,
      application_name: 'ori-agent:write-assertion',
    });

    await client.connect();

    let inRecovery: boolean | null = null;
    try {
      const recovery = await client.query<{ in_recovery: boolean }>(
        'SELECT pg_is_in_recovery() AS in_recovery',
      );
      inRecovery = recovery.rows[0]?.in_recovery ?? null;
    } catch {
      // Not fatal — the write attempt is the authoritative test.
    }

    let writeSucceeded = false;
    let rejection = '';

    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION READ WRITE');
      await client.query(
        'CREATE TEMP TABLE ori_write_assertion_probe (id int) ON COMMIT DROP',
      );
      writeSucceeded = true;
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }

    if (writeSucceeded) {
      throw new Error(
        'FATAL: DATABASE_READ_URL accepted a write. This connection executes ' +
          'administrator-authored SQL, and a read-only role or replica endpoint is ' +
          'what stops that SQL from modifying data. Refusing to start. ' +
          `(pg_is_in_recovery=${String(inRecovery)})`,
      );
    }

    this.logger.log(
      `Read connection write assertion passed (in_recovery=${String(inRecovery)}): ${rejection}`,
    );
  }
}
