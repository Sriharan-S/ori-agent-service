import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { AGENT_TABLES } from '../db/migrations';
import { PrimaryDb, quoteIdent, type PrimaryDbStatus } from '../db/primary.db';
import { ReadDb, type ReadDbStatus, type WriteAssertionResult } from '../db/read.db';

export interface ConnectionInfo {
  role: 'primary' | 'read';
  purpose: string;
  host: string;
  port: string;
  database: string;
  user: string;
  ssl: boolean;
  /** Never the password. Rendered for display only. */
  redactedUrl: string;
  reachable: boolean;
  latencyMs: number | null;
  serverVersion: string | null;
  pool: { total: number; idle: number; waiting: number; max: number };
  error?: string;
}

export interface DatabaseReport {
  schema: string;
  connections: ConnectionInfo[];
  writeAssertion: WriteAssertionResult;
  primaryStatus: PrimaryDbStatus;
  readStatus: ReadDbStatus;
  statementTimeoutMs: number;
  /** Tables the read connection can actually see, by schema. */
  visibleTables: Array<{ schema: string; tables: number }>;
  agentTables: number;
  expectedAgentTables: number;
}

/**
 * Connection diagnostics for the console.
 *
 * There was no way to see any of this from the UI, which made "is the database
 * even connected" a question you had to answer by reading logs. Everything here
 * is derived live rather than echoed from configuration, so a stale `.env` and
 * a working connection cannot be confused for each other.
 *
 * Passwords are stripped before the URL leaves this service. The console shows
 * `postgres://user:***@host:5432/db`, which is enough to tell two environments
 * apart and useless to anyone reading over a shoulder.
 */
@Injectable()
export class DatabaseInfoService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly primary: PrimaryDb,
    private readonly read: ReadDb,
  ) {}

  async report(): Promise<DatabaseReport> {
    const [primaryInfo, readInfo, visibleTables, agentTables] =
      await Promise.all([
        this.describePrimary(),
        this.describeRead(),
        this.listVisibleTables(),
        this.countAgentTables(),
      ]);

    return {
      schema: this.config.db.schema,
      connections: [primaryInfo, readInfo],
      writeAssertion: this.read.getWriteAssertion(),
      primaryStatus: this.primary.getStatus(),
      readStatus: this.read.getStatus(),
      statementTimeoutMs: this.config.db.statementTimeoutMs,
      visibleTables,
      agentTables,
      expectedAgentTables: AGENT_TABLES.length,
    };
  }

  private async describePrimary(): Promise<ConnectionInfo> {
    const base = {
      ...parseUrl(this.config.db.primaryUrl),
      role: 'primary' as const,
      purpose: "The agent's own schema — registry, conversations, audit, keys",
      pool: {
        ...this.primary.getPoolStats(),
        max: this.config.db.poolMax,
      },
    };

    const startedAt = Date.now();
    try {
      const row = await this.primary.one<{ version: string }>(
        'SELECT version() AS version',
      );
      return {
        ...base,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        serverVersion: shortVersion(row?.version ?? null),
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        latencyMs: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async describeRead(): Promise<ConnectionInfo> {
    const base = {
      ...parseUrl(this.config.db.readUrl),
      role: 'read' as const,
      purpose: 'Runs registry functions. Must not be able to write',
      pool: {
        ...this.read.getPoolStats(),
        max: this.config.db.readPoolMax,
      },
    };

    const startedAt = Date.now();
    try {
      const result = await this.read.query<{ version: string }>(
        'SELECT version() AS version',
        [],
        { label: 'diagnostics' },
      );
      return {
        ...base,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        serverVersion: shortVersion(result.rows[0]?.version ?? null),
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        latencyMs: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** What the read connection can actually reach — the agent's usable surface. */
  private async listVisibleTables(): Promise<
    Array<{ schema: string; tables: number }>
  > {
    try {
      const result = await this.read.query<{ schema: string; tables: string }>(
        `SELECT n.nspname AS schema, COUNT(*)::text AS tables
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg\\_%'
            AND has_table_privilege(c.oid, 'SELECT')
          GROUP BY n.nspname
          ORDER BY n.nspname`,
        [],
        { label: 'diagnostics' },
      );

      return result.rows.map((row) => ({
        schema: row.schema,
        tables: Number(row.tables),
      }));
    } catch {
      return [];
    }
  }

  /**
   * How many of the agent's tables exist.
   *
   * Counts `agent_*` specifically rather than everything in the schema. If
   * someone points DATABASE_SCHEMA at `public`, counting the whole schema would
   * report the host application's tables as the agent's.
   */
  private async countAgentTables(): Promise<number> {
    try {
      const row = await this.primary.one<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [this.config.db.schema, [...AGENT_TABLES]],
      );
      return Number(row?.count ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Real values for a scope key, so the playground can be used without guessing.
   *
   * A scope value is a tenant identifier the *caller* supplies — the agent has
   * no way to derive one, and inventing one would be wrong. But an operator
   * testing in the console has to type something, and "which corporate account
   * ids exist" is a question they would otherwise answer by opening psql.
   *
   * Reads through the read-only connection, from the column the function itself
   * declares, so nothing here needs to know a product's schema. Operator-only:
   * it returns tenant identifiers, which is exactly what a scope value is.
   */
  async scopeSamples(
    filters: Array<{ key: string; column: string; sql?: string | null }>,
    limit = 25,
  ): Promise<Record<string, Array<{ value: string; label: string }>>> {
    const samples: Record<string, Array<{ value: string; label: string }>> = {};

    for (const filter of filters) {
      // A scope filter names `alias.column`, which is the shape the save-time
      // validator enforces. The alias is meaningful only inside that function's
      // own SQL, so resolve it there first: sampling the column name globally
      // finds whichever table happens to be biggest, which for `user_id` is an
      // answers table rather than the registrations table being scoped.
      const [maybeAlias, maybeColumn] = filter.column.includes('.')
        ? filter.column.split('.')
        : [null, filter.column];

      const column = (maybeColumn ?? filter.column).trim();
      if (!/^[a-z_][a-z0-9_]*$/i.test(column)) continue;

      const table =
        (maybeAlias && filter.sql
          ? resolveAlias(filter.sql, maybeAlias.trim())
          : null) ?? (await this.tableForColumn(column));

      if (!table) continue;

      // Identifiers cannot be bound as parameters in Postgres, so the relation
      // and column are interpolated — but only after `quoteIdent`, which throws
      // on anything that is not an identifier. The row limit *is* a value and is
      // bound, so nothing here reaches the query text as data.
      const relation = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
      const scopeColumn = quoteIdent(column);

      try {
        const result = await this.read.query<{ value: string; occurrences: string }>(
          `SELECT ${scopeColumn}::text AS value, COUNT(*)::text AS occurrences
             FROM ${relation}
            WHERE ${scopeColumn} IS NOT NULL
            GROUP BY 1
            ORDER BY COUNT(*) DESC
            LIMIT $1`,
          [Math.min(Math.max(limit, 1), 100)],
          { label: 'scope-samples' },
        );

        samples[filter.key] = result.rows.map((row) => ({
          value: row.value,
          label: `${row.value} · ${row.occurrences} row(s)`,
        }));
      } catch {
        // A scope column the read role cannot see is not an error worth
        // surfacing here — the playground simply offers no suggestions for it.
        samples[filter.key] = [];
      }
    }

    return samples;
  }

  /** The table a scope column lives on, chosen by how many rows carry it. */
  private async tableForColumn(
    column: string,
  ): Promise<{ schema: string; name: string } | null> {
    const rows = await this.read
      .query<{ table_schema: string; table_name: string }>(
        `SELECT c.table_schema, c.table_name
           FROM information_schema.columns c
           JOIN pg_class pc ON pc.relname = c.table_name
           JOIN pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema
          WHERE c.column_name = $1
            AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
            AND pc.relkind IN ('r', 'p')
            AND has_table_privilege(pc.oid, 'SELECT')
          ORDER BY pc.reltuples DESC
          LIMIT 1`,
        [column],
        { label: 'scope-samples' },
      )
      .catch(() => ({ rows: [] as Array<{ table_schema: string; table_name: string }> }));

    const first = rows.rows[0];
    return first ? { schema: first.table_schema, name: first.table_name } : null;
  }

  /** Names of the agent's own tables, for the console. */
  async agentTableNames(): Promise<
    Array<{ name: string; qualified: string; exists: boolean }>
  > {
    const rows = await this.primary
      .query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [this.config.db.schema, [...AGENT_TABLES]],
      )
      .catch(() => []);

    const present = new Set(rows.map((row) => row.table_name));
    const schema = safeIdent(this.config.db.schema);

    return AGENT_TABLES.map((name) => ({
      name,
      qualified: `${schema}.${name}`,
      exists: present.has(name),
    }));
  }
}

/**
 * The table an alias refers to, read out of the function's own SQL.
 *
 * Matches `FROM registrations r` and `JOIN assessment_sessions s ON …`, which is
 * how every registry function is written. Returns null when the alias cannot be
 * resolved, so the caller falls back to searching by column name — a wrong guess
 * here would only mean less useful sample values, never a wrong query, because
 * both the schema and table are quoted before use.
 */
function resolveAlias(
  sql: string,
  alias: string,
): { schema: string; name: string } | null {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) return null;

  const pattern = new RegExp(
    `\\b(?:FROM|JOIN)\\s+([a-z_][a-z0-9_]*)(?:\\.([a-z_][a-z0-9_]*))?\\s+(?:AS\\s+)?${alias}\\b`,
    'i',
  );

  const match = pattern.exec(sql);
  if (!match) return null;

  // `schema.table alias` or just `table alias`.
  return match[2]
    ? { schema: match[1]!, name: match[2] }
    : { schema: 'public', name: match[1]! };
}

/** Never throws — this powers a diagnostics page that must survive bad input. */
function safeIdent(value: string): string {
  try {
    return quoteIdent(value);
  } catch {
    return `"${value.replace(/"/g, '""')}"`;
  }
}

/**
 * Pull display fields out of a connection string without the password.
 *
 * Falls back to placeholders rather than throwing: a malformed URL should show
 * as malformed in the console, not take the diagnostics page down.
 */
function parseUrl(raw: string): {
  host: string;
  port: string;
  database: string;
  user: string;
  ssl: boolean;
  redactedUrl: string;
} {
  try {
    const url = new URL(raw);
    const ssl =
      url.searchParams.get('sslmode') === 'require' ||
      url.searchParams.get('ssl') === 'true';

    const redacted = `${url.protocol}//${url.username || '(no user)'}${
      url.password ? ':***' : ''
    }@${url.hostname}:${url.port || '5432'}${url.pathname}`;

    return {
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || '(default)',
      user: url.username || '(none)',
      ssl,
      redactedUrl: redacted,
    };
  } catch {
    return {
      host: '(unparseable)',
      port: '—',
      database: '(unparseable)',
      user: '—',
      ssl: false,
      redactedUrl: '(connection string could not be parsed)',
    };
  }
}

function shortVersion(full: string | null): string | null {
  if (!full) return null;
  const match = full.match(/PostgreSQL\s+([\d.]+)/i);
  return match ? `PostgreSQL ${match[1]}` : full.slice(0, 60);
}
