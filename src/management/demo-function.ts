import type { FunctionInput } from './function-management.service';

export const DEMO_FUNCTION_NAME = 'demo';

/**
 * A working function that exists from the moment an application is created.
 *
 * The point is that a fresh install can be tested for real — ask the agent
 * "what tables are in the database?" and it plans, calls this, and answers from
 * live rows. Without it, a new deployment has an empty registry and nothing to
 * demonstrate that any of the machinery works.
 *
 * It reads `pg_catalog`, so it needs no seed data and behaves identically on any
 * Postgres. It is also genuinely useful: it is how you find out what the agent's
 * read connection can actually see, which is the first question when a function
 * you just wrote returns nothing.
 *
 * Deliberately not privileged: it lists only tables the read role holds SELECT
 * on, so it reveals exactly the surface the agent could ever query and nothing
 * more.
 */
export function buildDemoFunction(agentSchema: string): FunctionInput {
  return {
    name: DEMO_FUNCTION_NAME,
    category: 'demo',
    kind: 'read',
    returns: 'list',
    allowedRoles: ['*'],
    requiresConfirmation: false,
    defaultLimit: 50,
    maxLimit: 200,

    description:
      'Lists the database tables this assistant is able to read, with the schema ' +
      'each one belongs to and an estimated row count. Optionally filters to ' +
      'tables whose name contains a given word. Use it to find out what data is ' +
      'available, or to check whether a particular table exists and has rows in it.',

    whenToUse: [
      'what tables are in the database',
      'what data can you see',
      'is there a table about orders',
      'how many tables are there',
      'which tables have data in them',
    ],

    whenNotToUse: [
      'Reading the contents of a table — this returns table names, never rows from them.',
    ],

    parameters: {
      nameContains: {
        type: 'string',
        description:
          'Only list tables whose name contains this text. Leave out to list all of them.',
        maxLength: 60,
      },
      hideSchema: {
        type: 'string',
        description:
          "Schema to leave out of the results. Defaults to the assistant's own bookkeeping schema.",
        maxLength: 63,
        // Bound like any other value, so the agent's internal tables are hidden
        // without the schema name ever being spliced into the SQL.
        default: agentSchema,
      },
    },

    requiredOneOf: [],
    scopeFilters: [],

    // `reltuples` is the planner's estimate, which is -1 on a table that has
    // never been analysed. Reporting that honestly beats reporting 0 rows.
    sqlTemplate: `SELECT n.nspname                                   AS schema_name,
       c.relname                                   AS table_name,
       CASE WHEN c.reltuples < 0 THEN NULL
            ELSE round(c.reltuples)::bigint END    AS estimated_rows,
       CASE WHEN c.reltuples < 0 THEN 'never analysed'
            WHEN c.reltuples = 0 THEN 'empty'
            ELSE round(c.reltuples)::bigint || ' rows (estimated)'
       END                                         AS row_summary
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\\_%'
   AND n.nspname <> COALESCE({{param:hideSchema}}, '')
   AND has_table_privilege(c.oid, 'SELECT')
   AND (COALESCE({{param:nameContains}}, '') = ''
        OR c.relname ILIKE '%' || {{param:nameContains}} || '%')
 ORDER BY n.nspname, c.relname`,
  };
}
