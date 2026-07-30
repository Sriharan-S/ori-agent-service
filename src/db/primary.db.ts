import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { CONFIG, type AppConfig } from '../config/configuration';
import { AGENT_TABLES, buildMigrations, buildMigrationsTableSql } from './migrations';

/**
 * How far the service got in installing itself.
 *
 * Each value is a distinct thing an operator has to do something about, which
 * is why they are separate: "no database configured" and "database refused the
 * connection" and "database will not let me create tables" have three different
 * fixes, and collapsing them into one "database error" is how a setup screen
 * becomes useless.
 */
export type PrimaryDbStage =
  | 'not-configured'
  | 'unreachable'
  | 'tables-missing'
  | 'ready';

export interface PrimaryDbStatus {
  stage: PrimaryDbStage;
  schema: string;
  /** Why it is not ready, phrased for someone who has to fix it. */
  error: string | null;
  /** Raw driver message, when there was one. */
  detail: string | null;
  existingTables: string[];
  missingTables: string[];
  checkedAt: Date | null;
}

/**
 * The agent's own database connection.
 *
 * Writable, and used **only** for the agent's tables: applications, keys,
 * roles, functions, models, conversations, runs, audit. It never executes a
 * registry function — that is `ReadDb`'s job and it is a different set of
 * credentials on purpose.
 *
 * The service has no database of its own. It is pointed at one that already
 * exists and creates its `agent_*` tables inside it. That means the first boot
 * on a new deployment is a setup problem rather than a runtime one, so nothing
 * here throws on failure: connecting, migrating and probing all record a stage
 * that the setup screen reads. A process that exits cannot tell anyone why.
 */
@Injectable()
export class PrimaryDb implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrimaryDb.name);
  private pool: Pool | null = null;
  private ready = false;
  private status: PrimaryDbStatus = {
    stage: 'not-configured',
    schema: '',
    error: null,
    detail: null,
    existingTables: [],
    missingTables: [...AGENT_TABLES],
    checkedAt: null,
  };

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get schema(): string {
    return this.config.db.schema;
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  /**
   * Establish the connection and install the schema, reporting rather than
   * throwing.
   *
   * Safe to call again: the setup screen's "check now" button runs exactly this
   * after an operator has fixed whatever was wrong, so a restart is not part of
   * the onboarding loop.
   */
  async connect(): Promise<PrimaryDbStatus> {
    const { db } = this.config;

    await this.closePool();
    this.ready = false;

    if (!db.primaryUrl) {
      return this.record({
        stage: 'not-configured',
        error:
          'No database is configured. Set DATABASE_URL to a Postgres connection ' +
          'string — this service stores its own tables inside a database you ' +
          'already run, and cannot start without one.',
        detail: null,
      });
    }

    let schema: string;
    try {
      schema = quoteIdent(db.schema);
    } catch (error) {
      return this.record({
        stage: 'not-configured',
        error: `DATABASE_SCHEMA is not a usable schema name: ${message(error)}`,
        detail: null,
      });
    }

    this.pool = new Pool({
      connectionString: db.primaryUrl,
      max: db.poolMax,
      connectionTimeoutMillis: db.connectTimeoutMs,
      idleTimeoutMillis: 30_000,
      application_name: 'ori-agent:primary',
    });

    this.pool.on('error', (error) => {
      this.logger.error(`Idle primary client error: ${error.message}`);
    });

    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      await this.closePool();
      return this.record({
        stage: 'unreachable',
        error: explainConnectionError(error),
        detail: message(error),
      });
    }

    try {
      await this.migrate(schema);
    } catch (error) {
      // Almost always a permission problem: a role that can read and write rows
      // but not create objects. The setup screen turns this into a script to
      // hand to whoever does hold that privilege.
      const tables = await this.inspectTables().catch(() => null);
      return this.record({
        stage: 'tables-missing',
        error:
          'Connected to the database, but the agent tables could not be created. ' +
          'This is usually because the role may not create objects in the ' +
          `"${db.schema}" schema. Run the setup SQL as a role that can, then check again.`,
        detail: message(error),
        existingTables: tables?.existing,
        missingTables: tables?.missing,
      });
    }

    const tables = await this.inspectTables().catch(() => null);

    if (tables && tables.missing.length > 0) {
      return this.record({
        stage: 'tables-missing',
        error:
          `Migrations reported success but ${tables.missing.length} table(s) are ` +
          'still missing. Run the setup SQL manually and check again.',
        detail: null,
        existingTables: tables.existing,
        missingTables: tables.missing,
      });
    }

    this.ready = true;
    this.logger.log(
      `Primary database ready (schema "${db.schema}", ${AGENT_TABLES.length} agent tables)`,
    );

    return this.record({
      stage: 'ready',
      error: null,
      detail: null,
      existingTables: tables?.existing ?? [...AGENT_TABLES],
      missingTables: [],
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closePool();
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  getStatus(): PrimaryDbStatus {
    return this.status;
  }

  private record(
    patch: Partial<PrimaryDbStatus> & { stage: PrimaryDbStage },
  ): PrimaryDbStatus {
    this.status = {
      schema: this.config.db.schema,
      error: null,
      detail: null,
      existingTables: [],
      missingTables: patch.stage === 'ready' ? [] : [...AGENT_TABLES],
      ...patch,
      checkedAt: new Date(),
    };

    if (this.status.error) this.logger.warn(this.status.error);
    return this.status;
  }

  private async closePool(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    await pool.end().catch(() => undefined);
  }

  /** Which of the agent's tables actually exist right now. */
  private async inspectTables(): Promise<{
    existing: string[];
    missing: string[];
  }> {
    const rows = await this.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
      [this.config.db.schema, [...AGENT_TABLES]],
    );

    const existing = new Set(rows.map((row) => row.table_name));
    return {
      existing: AGENT_TABLES.filter((name) => existing.has(name)),
      missing: AGENT_TABLES.filter((name) => !existing.has(name)),
    };
  }

  /** Live pool usage, for the console's database view. */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool?.totalCount ?? 0,
      idle: this.pool?.idleCount ?? 0,
      waiting: this.pool?.waitingCount ?? 0,
    };
  }

  async query<T extends QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T[]> {
    const result = await this.requirePool().query<T>(text, params as unknown[]);
    return result.rows;
  }

  async one<T extends QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * The pool, or a message an operator can act on.
   *
   * Before, every caller dereferenced `this.pool!` and a service that had not
   * connected produced "Cannot read properties of null" from somewhere deep in
   * a query. Saying which of the two connections is down, and that setup is
   * where you fix it, costs one method.
   */
  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error(
        `The agent database is not connected (${this.status.stage}). ` +
          'Open /admin to see what setup step is outstanding.',
      );
    }
    return this.pool;
  }

  /** Runs `handler` inside a transaction, rolling back on any throw. */
  async transaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection already gone.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Applies pending migrations under an advisory lock, so several instances
   * starting at once cannot race each other into a half-applied schema.
   */
  private async migrate(schema: string): Promise<void> {
    // A schema installed by hand from the setup script is complete but has no
    // bookkeeping rows. Adopt it instead of issuing DDL, because `CREATE …
    // IF NOT EXISTS` checks permissions *before* existence — a role that may
    // not create objects fails on those statements even though every object is
    // already there, which is precisely the situation the script exists for.
    if (await this.adoptExistingSchema(schema)) return;

    await this.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await this.adoptLegacyBookkeeping(schema);
    await this.query(buildMigrationsTableSql(schema));

    // Arbitrary but stable lock id for this service.
    await this.query('SELECT pg_advisory_lock($1)', [7264193004]);

    try {
      const applied = new Set(
        (
          await this.query<{ id: string }>(
            `SELECT id FROM ${schema}.agent_schema_migrations`,
          )
        ).map((row) => row.id),
      );

      for (const migration of buildMigrations(schema)) {
        if (applied.has(migration.id)) continue;

        this.logger.log(`Applying migration ${migration.id}`);
        await this.transaction(async (client) => {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${schema}.agent_schema_migrations (id) VALUES ($1)`,
            [migration.id],
          );
        });
      }
    } finally {
      await this.query('SELECT pg_advisory_unlock($1)', [7264193004]);
    }
  }

  /**
   * Carry forward the migration history from before the `agent_` prefix.
   *
   * Has to happen before the bookkeeping table is created, not in a migration:
   * once an empty `agent_schema_migrations` exists, every migration looks
   * pending and `0000_prefix_legacy_tables` would run behind the CREATE
   * statements that had already made empty replacements.
   */
  private async adoptLegacyBookkeeping(schema: string): Promise<void> {
    const renamed = await this.query<{ renamed: boolean }>(
      `SELECT CASE
                WHEN to_regclass($1) IS NOT NULL AND to_regclass($2) IS NULL
                THEN true ELSE false
              END AS renamed`,
      [`${schema}.schema_migrations`, `${schema}.agent_schema_migrations`],
    ).catch(() => []);

    if (renamed[0]?.renamed !== true) return;

    this.logger.log(
      'Found a schema from before the agent_ prefix — carrying its migration ' +
        'history forward rather than recreating the tables.',
    );
    await this.query(
      `ALTER TABLE ${schema}.schema_migrations RENAME TO agent_schema_migrations`,
    );
  }

  /**
   * Recognise a schema someone installed with the setup script.
   *
   * Only adopts when every current table exists *and* no migration has ever
   * been recorded — a fresh manual install. Once bookkeeping exists the service
   * is on the normal incremental path, and a pending migration must really run
   * rather than be assumed. Marking a migration applied on the strength of a
   * table name would be a quiet way to skip one that adds a column.
   *
   * Returns false if the tables are not all there, so the caller falls through
   * to the ordinary DDL path.
   */
  private async adoptExistingSchema(schema: string): Promise<boolean> {
    const tables = await this.inspectTables().catch(() => null);
    if (!tables || tables.missing.length > 0) return false;

    const recorded = await this.query<{ id: string }>(
      `SELECT id FROM ${schema}.agent_schema_migrations LIMIT 1`,
    ).catch(() => null);

    if (recorded === null) return false;
    if (recorded.length > 0) return true;

    this.logger.log(
      'Found a complete set of agent tables with no migration history — ' +
        'adopting a schema that was installed from the setup script.',
    );

    for (const migration of buildMigrations(schema)) {
      await this.query(
        `INSERT INTO ${schema}.agent_schema_migrations (id) VALUES ($1)
           ON CONFLICT (id) DO NOTHING`,
        [migration.id],
      );
    }

    return true;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a driver failure into the thing to go and check.
 *
 * `ECONNREFUSED 127.0.0.1:5432` is accurate and tells a first-time operator
 * nothing. Each of these has a different fix, and naming it is the difference
 * between a setup screen and an error log.
 */
export function explainConnectionError(
  error: unknown,
  variable = 'DATABASE_URL',
): string {
  const raw = message(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';

  if (code === 'ECONNREFUSED' || raw.includes('ECONNREFUSED')) {
    return (
      'Nothing accepted a connection at that host and port. Check that Postgres ' +
      `is running and that the host and port in ${variable} are right.`
    );
  }
  if (code === 'ENOTFOUND' || raw.includes('ENOTFOUND')) {
    return `That database hostname did not resolve. Check the host part of ${variable}.`;
  }
  if (code === 'ETIMEDOUT' || raw.includes('ETIMEDOUT') || raw.includes('timeout')) {
    return (
      'The connection timed out. The host is usually reachable but a firewall or ' +
      'security group is dropping the connection.'
    );
  }
  if (code === '28P01' || raw.includes('password authentication failed')) {
    return `The database rejected those credentials. Check the user and password in ${variable}.`;
  }
  if (code === '3D000' || raw.includes('does not exist')) {
    return (
      'That database does not exist on the server. Create it first — this service ' +
      'creates its own tables but not the database itself.'
    );
  }
  if (raw.includes('self signed certificate') || raw.includes('SSL')) {
    return (
      'The TLS handshake failed. Managed Postgres usually needs ?sslmode=require ' +
      'on the connection string.'
    );
  }
  return `The database connection failed: ${raw}`;
}

/**
 * Quote a Postgres identifier.
 *
 * The schema name comes from configuration, not from a request, but it is the
 * one identifier in this service that is not a compile-time constant — so it
 * gets quoted properly rather than trusted.
 */
export function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error(
      `Invalid schema name "${identifier}". Use letters, digits and underscores only.`,
    );
  }
  return `"${identifier}"`;
}
