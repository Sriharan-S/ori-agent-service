import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { CONFIG, type AppConfig } from '../config/configuration';
import { buildMigrations } from './migrations';

/**
 * The agent's own database connection.
 *
 * Writable, and used **only** for the agent's schema: applications, keys,
 * roles, functions, models, conversations, runs, audit. It never executes a
 * registry function — that is `ReadDb`'s job and it is a different set of
 * credentials on purpose.
 */
@Injectable()
export class PrimaryDb implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrimaryDb.name);
  private pool: Pool | null = null;
  private ready = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get schema(): string {
    return this.config.db.schema;
  }

  async onModuleInit(): Promise<void> {
    const { db } = this.config;

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

    await this.pool.query('SELECT 1');
    await this.migrate();

    this.ready = true;
    this.logger.log(`Primary database ready (schema "${db.schema}")`);
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

  async query<T extends QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T[]> {
    const result = await this.pool!.query<T>(text, params as unknown[]);
    return result.rows;
  }

  async one<T extends QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Runs `handler` inside a transaction, rolling back on any throw. */
  async transaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool!.connect();
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
  private async migrate(): Promise<void> {
    const schema = this.config.db.schema;

    await this.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(schema)}.schema_migrations (
        id         TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Arbitrary but stable lock id for this service.
    await this.query('SELECT pg_advisory_lock($1)', [7264193004]);

    try {
      const applied = new Set(
        (
          await this.query<{ id: string }>(
            `SELECT id FROM ${quoteIdent(schema)}.schema_migrations`,
          )
        ).map((row) => row.id),
      );

      for (const migration of buildMigrations(quoteIdent(schema))) {
        if (applied.has(migration.id)) continue;

        this.logger.log(`Applying migration ${migration.id}`);
        await this.transaction(async (client) => {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${quoteIdent(schema)}.schema_migrations (id) VALUES ($1)`,
            [migration.id],
          );
        });
      }
    } finally {
      await this.query('SELECT pg_advisory_unlock($1)', [7264193004]);
    }
  }
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
