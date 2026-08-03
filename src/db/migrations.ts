/**
 * Schema for the agent's own tables.
 *
 * This service has no database of its own. It is pointed at an existing
 * Postgres — usually the host application's — and creates its own tables
 * inside it. Every one of them is named `agent_*` and lives in one schema
 * (default `ori`), so which tables belong to the agent is obvious from the
 * name alone even if someone later moves them into `public`. Nothing here
 * touches a host table.
 *
 * Indexes and check constraints carry the same prefix. Those names are
 * schema-scoped rather than table-scoped in Postgres, so an unprefixed
 * `functions_live_idx` would collide with a host application's index the
 * moment these tables share a schema with anything else.
 *
 * Migrations are ordered, idempotent, and recorded in `agent_schema_migrations`.
 * Kept as plain SQL rather than an ORM's migration tool because the service
 * already has a first-class relationship with raw SQL and adding a second
 * mechanism would be one more thing to keep honest.
 */

export interface Migration {
  id: string;
  sql: string;
}

/**
 * Every table the service creates, in dependency order.
 *
 * The setup flow uses this to report which tables exist, which are missing,
 * and — when the connected role may not create them — exactly what to hand to
 * a DBA. It is deliberately a plain list rather than something derived by
 * parsing the SQL above: a parser that silently misses a table would make the
 * setup screen lie.
 */
export const AGENT_TABLES = [
  'agent_schema_migrations',
  'agent_applications',
  'agent_api_keys',
  'agent_roles',
  'agent_services',
  'agent_functions',
  'agent_function_versions',
  'agent_models',
  'agent_admin_users',
  'agent_admin_sessions',
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_audit_log',
] as const;

export function buildMigrations(schema: string): Migration[] {
  const s = schema;

  return [
    {
      // Earlier versions created these tables without the `agent_` prefix.
      // Renaming rather than recreating means a deployment that already exists
      // keeps its applications, keys, functions and audit history instead of
      // coming back up empty.
      //
      // Safe anywhere: it only touches the agent's own schema, where an
      // unprefixed `applications` table can only be this service's, and it
      // skips any name whose prefixed form already exists. Indexes are renamed
      // too — a table rename does not carry them, so the CREATE INDEX
      // statements below would otherwise build a second copy of each.
      //
      // A no-op on a fresh install, which is the common case.
      id: '0000_prefix_legacy_tables',
      sql: `
        DO $rename$
        DECLARE
          legacy TEXT;
          target TEXT;
        BEGIN
          FOREACH legacy IN ARRAY ARRAY[
            'applications', 'api_keys', 'roles', 'services',
            'functions', 'function_versions', 'models',
            'admin_users', 'admin_sessions',
            'conversations', 'messages', 'runs', 'audit_log'
          ] LOOP
            target := 'agent_' || legacy;

            IF to_regclass('${s}.' || quote_ident(legacy)) IS NOT NULL
               AND to_regclass('${s}.' || quote_ident(target)) IS NULL THEN
              EXECUTE format('ALTER TABLE %s.%I RENAME TO %I', '${s}', legacy, target);
              RAISE NOTICE 'Renamed %.% to %', '${s}', legacy, target;
            END IF;
          END LOOP;

          FOR legacy IN
            SELECT c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = trim(both '"' from '${s}')
               AND c.relkind = 'i'
               AND c.relname NOT LIKE 'agent\\_%'
          LOOP
            IF to_regclass('${s}.' || quote_ident('agent_' || legacy)) IS NULL THEN
              EXECUTE format('ALTER INDEX %s.%I RENAME TO %I', '${s}', legacy, 'agent_' || legacy);
            END IF;
          END LOOP;
        END
        $rename$;
      `,
    },
    {
      id: '0001_core',
      sql: `
        CREATE SCHEMA IF NOT EXISTS ${s};

        -- Tenants. One row per host application calling this service.
        CREATE TABLE IF NOT EXISTS ${s}.agent_applications (
          id                BIGSERIAL PRIMARY KEY,
          slug              TEXT        NOT NULL UNIQUE,
          name              TEXT        NOT NULL,
          description       TEXT,
          -- 'jwt': the agent verifies an end-user token against the issuer below.
          -- 'asserted': the application states who the user is over the
          -- API-key-authenticated channel. See docs/SECURITY.md.
          end_user_auth     TEXT        NOT NULL DEFAULT 'asserted',
          jwt_issuer        TEXT,
          jwt_jwks_url      TEXT,
          jwt_audience      TEXT,
          jwt_subject_claim TEXT        NOT NULL DEFAULT 'sub',
          jwt_role_claim    TEXT,
          jwt_scope_claims  JSONB       NOT NULL DEFAULT '{}'::jsonb,
          is_active         BOOLEAN     NOT NULL DEFAULT true,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT agent_applications_end_user_auth_check
            CHECK (end_user_auth IN ('jwt', 'asserted'))
        );

        CREATE TABLE IF NOT EXISTS ${s}.agent_api_keys (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          name           TEXT        NOT NULL,
          -- Lookup handle. The secret itself is only ever stored hashed.
          prefix         TEXT        NOT NULL UNIQUE,
          key_hash       TEXT        NOT NULL,
          scopes         TEXT[]      NOT NULL DEFAULT ARRAY['chat'],
          last_used_at   TIMESTAMPTZ,
          revoked_at     TIMESTAMPTZ,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS agent_api_keys_application_idx
          ON ${s}.agent_api_keys (application_id) WHERE revoked_at IS NULL;

        -- Data-driven RBAC. A role is a row, not a class.
        CREATE TABLE IF NOT EXISTS ${s}.agent_roles (
          id                BIGSERIAL PRIMARY KEY,
          application_id    BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          name              TEXT        NOT NULL,
          description       TEXT,
          -- Function names this role may call, or ARRAY['*'].
          allowed_functions TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
          write_scopes      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
          -- Scope keys this role is exempt from, e.g. an admin exempt from
          -- 'org_id'. Any scope key NOT listed here must be supplied by the
          -- caller or the function is refused.
          unscoped_keys     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (application_id, name)
        );

        -- Base URLs that HTTP action functions may target. An action cannot
        -- name an arbitrary host; it names a service registered here.
        CREATE TABLE IF NOT EXISTS ${s}.agent_services (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          name           TEXT        NOT NULL,
          base_url       TEXT        NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (application_id, name)
        );
      `,
    },

    {
      id: '0002_registry',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.agent_functions (
          id                    BIGSERIAL PRIMARY KEY,
          application_id        BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          name                  TEXT        NOT NULL,
          category              TEXT        NOT NULL DEFAULT 'general',
          kind                  TEXT        NOT NULL,
          description           TEXT        NOT NULL,
          when_to_use           JSONB       NOT NULL DEFAULT '[]'::jsonb,
          when_not_to_use       JSONB       NOT NULL DEFAULT '[]'::jsonb,
          parameters            JSONB       NOT NULL DEFAULT '{}'::jsonb,
          required_one_of       JSONB       NOT NULL DEFAULT '[]'::jsonb,
          returns               TEXT        NOT NULL,
          ambiguity_resolves_to TEXT,
          allowed_roles         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
          -- [{ "key": "org_id", "column": "r.org_id" }] — each must appear as a
          -- {{scope:key}} token in sql_template.
          scope_filters         JSONB       NOT NULL DEFAULT '[]'::jsonb,
          -- Read body: a template in the {{param:x}} / {{scope:k}} language.
          -- Never raw $n, never string interpolation. See sql-template.ts.
          sql_template          TEXT,
          -- Write body: a declarative HTTP call back into the host application.
          http_request          JSONB,
          write_scope           TEXT,
          requires_confirmation BOOLEAN     NOT NULL DEFAULT false,
          default_limit         INTEGER,
          max_limit             INTEGER,
          status                TEXT        NOT NULL DEFAULT 'draft',
          version               INTEGER     NOT NULL DEFAULT 1,
          created_by            BIGINT,
          approved_by           BIGINT,
          approved_at           TIMESTAMPTZ,
          last_validated_at     TIMESTAMPTZ,
          validation_error      TEXT,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (application_id, name),
          CONSTRAINT agent_functions_kind_check   CHECK (kind IN ('read', 'write')),
          CONSTRAINT agent_functions_status_check CHECK (status IN ('draft', 'approved', 'live', 'disabled')),
          CONSTRAINT agent_functions_returns_check
            CHECK (returns IN ('single', 'list', 'single-or-ambiguous', 'confirmation')),
          -- A read function needs SQL; a write function needs an HTTP action.
          CONSTRAINT agent_functions_body_check CHECK (
            (kind = 'read'  AND sql_template IS NOT NULL) OR
            (kind = 'write' AND http_request IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS agent_functions_live_idx
          ON ${s}.agent_functions (application_id) WHERE status = 'live';

        CREATE TABLE IF NOT EXISTS ${s}.agent_function_versions (
          id          BIGSERIAL PRIMARY KEY,
          function_id BIGINT      NOT NULL REFERENCES ${s}.agent_functions(id) ON DELETE CASCADE,
          version     INTEGER     NOT NULL,
          snapshot    JSONB       NOT NULL,
          note        TEXT,
          changed_by  BIGINT,
          changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (function_id, version)
        );
      `,
    },

    {
      id: '0003_models',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.agent_models (
          id                 BIGSERIAL PRIMARY KEY,
          -- NULL means available to every application.
          application_id     BIGINT      REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          name               TEXT        NOT NULL,
          provider           TEXT        NOT NULL DEFAULT 'openai-compatible',
          base_url           TEXT        NOT NULL,
          model_id           TEXT        NOT NULL,
          -- AES-256-GCM, key from ENCRYPTION_KEY. Never returned by the API.
          api_key_encrypted  TEXT,
          purpose            TEXT        NOT NULL DEFAULT 'any',
          -- Lower runs first; the next enabled model of the same purpose is the
          -- fallback. This is how failover is configured, not code.
          priority           INTEGER     NOT NULL DEFAULT 100,
          is_enabled         BOOLEAN     NOT NULL DEFAULT true,
          supports_streaming BOOLEAN     NOT NULL DEFAULT true,
          timeout_ms         INTEGER,
          max_output_tokens  INTEGER,
          temperature        NUMERIC(4,2),
          last_ok_at         TIMESTAMPTZ,
          last_error         TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT agent_models_purpose_check
            CHECK (purpose IN ('any', 'planner', 'synthesizer', 'router'))
        );

        CREATE INDEX IF NOT EXISTS agent_models_selection_idx
          ON ${s}.agent_models (purpose, priority) WHERE is_enabled;
      `,
    },

    {
      id: '0004_admin',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.agent_admin_users (
          id            BIGSERIAL PRIMARY KEY,
          email         TEXT        NOT NULL UNIQUE,
          name          TEXT,
          password_hash TEXT        NOT NULL,
          role          TEXT        NOT NULL DEFAULT 'admin',
          is_active     BOOLEAN     NOT NULL DEFAULT true,
          last_login_at TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT agent_admin_users_role_check CHECK (role IN ('owner', 'admin', 'viewer'))
        );

        CREATE TABLE IF NOT EXISTS ${s}.agent_admin_sessions (
          id            BIGSERIAL PRIMARY KEY,
          admin_user_id BIGINT      NOT NULL REFERENCES ${s}.agent_admin_users(id) ON DELETE CASCADE,
          token_hash    TEXT        NOT NULL UNIQUE,
          expires_at    TIMESTAMPTZ NOT NULL,
          ip            TEXT,
          user_agent    TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS agent_admin_sessions_expiry_idx
          ON ${s}.agent_admin_sessions (expires_at);
      `,
    },

    {
      id: '0005_conversations',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.agent_conversations (
          id               BIGSERIAL PRIMARY KEY,
          application_id   BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          conversation_key TEXT        NOT NULL UNIQUE,
          -- The host application's user identifier, as a string: this service
          -- does not assume numeric ids or any particular user model.
          end_user_id      TEXT        NOT NULL,
          end_user_role    TEXT        NOT NULL,
          title            TEXT,
          pending_state    JSONB,
          message_count    INTEGER     NOT NULL DEFAULT 0,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS agent_conversations_user_idx
          ON ${s}.agent_conversations (application_id, end_user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ${s}.agent_messages (
          id              BIGSERIAL PRIMARY KEY,
          conversation_id BIGINT      NOT NULL REFERENCES ${s}.agent_conversations(id) ON DELETE CASCADE,
          role            TEXT        NOT NULL,
          content         TEXT        NOT NULL,
          metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx
          ON ${s}.agent_messages (conversation_id, created_at);

        -- One row per agent run. Powers the live activity view and is what the
        -- trace stream is recorded against.
        CREATE TABLE IF NOT EXISTS ${s}.agent_runs (
          id              BIGSERIAL PRIMARY KEY,
          application_id  BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          run_key         TEXT        NOT NULL UNIQUE,
          conversation_key TEXT,
          end_user_id     TEXT        NOT NULL,
          end_user_role   TEXT        NOT NULL,
          intent          TEXT,
          status          TEXT        NOT NULL DEFAULT 'running',
          response_type   TEXT,
          functions_used  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
          streamed        BOOLEAN     NOT NULL DEFAULT false,
          error           TEXT,
          latency_ms      INTEGER,
          started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at    TIMESTAMPTZ,
          CONSTRAINT agent_runs_status_check CHECK (status IN ('running', 'completed', 'failed'))
        );

        CREATE INDEX IF NOT EXISTS agent_runs_recent_idx
          ON ${s}.agent_runs (application_id, started_at DESC);
      `,
    },

    {
      id: '0006_audit',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.agent_audit_log (
          id                        BIGSERIAL PRIMARY KEY,
          application_id            BIGINT      NOT NULL REFERENCES ${s}.agent_applications(id) ON DELETE CASCADE,
          run_key                   TEXT        NOT NULL,
          conversation_key          TEXT,
          end_user_id               TEXT        NOT NULL,
          end_user_role             TEXT        NOT NULL,
          function_name             TEXT        NOT NULL,
          function_version          INTEGER     NOT NULL DEFAULT 0,
          function_kind             TEXT        NOT NULL DEFAULT 'read',
          params                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
          scopes_applied            JSONB       NOT NULL DEFAULT '{}'::jsonb,
          status                    TEXT        NOT NULL,
          denied_reason             TEXT,
          error_message             TEXT,
          before_state              JSONB,
          after_state               JSONB,
          disambiguated             BOOLEAN     NOT NULL DEFAULT false,
          disambiguation_resolution TEXT,
          row_count                 INTEGER,
          latency_ms                INTEGER     NOT NULL DEFAULT 0,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS agent_audit_run_idx  ON ${s}.agent_audit_log (run_key);
        CREATE INDEX IF NOT EXISTS agent_audit_time_idx ON ${s}.agent_audit_log (application_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS agent_audit_fn_idx   ON ${s}.agent_audit_log (function_name, created_at DESC);
      `,
    },

    {
      // Editing a turn discards the ones after it. They are marked, never
      // deleted: the agent must not read them again, but an operator looking at
      // a transcript should still see what was asked and withdrawn — otherwise
      // the console shows a conversation that never happened. Runs and audit
      // rows are untouched by this; they remain the record of what actually ran.
      id: '0007_message_supersede',
      sql: `
        ALTER TABLE ${s}.agent_messages
          ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

        -- History reads are always "the live turns of one conversation, in
        -- order", so the partial index is the whole access pattern.
        CREATE INDEX IF NOT EXISTS agent_messages_live_idx
          ON ${s}.agent_messages (conversation_id, created_at)
          WHERE superseded_at IS NULL;
      `,
    },

    {
      // The URL the agent calls a service on is not always a URL a person can
      // open: an internal hostname, a container name, a port only reachable
      // inside the network. When an action hands back a link, the link has to
      // work in a browser — so a service may declare a second, public base URL
      // that outbound links are rebuilt against. Null means they are the same.
      id: '0008_service_public_url',
      sql: `
        ALTER TABLE ${s}.agent_services
          ADD COLUMN IF NOT EXISTS public_base_url TEXT;
      `,
    },
  ];
}

/** The bookkeeping table, created before any migration can be recorded. */
export function buildMigrationsTableSql(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${schema}.agent_schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;
}

/**
 * The entire schema as one copy-pasteable script.
 *
 * Plenty of Postgres deployments hand out a login that can read and write rows
 * but not create tables — managed databases especially. When that happens the
 * service cannot install itself, and the useful thing to do is not to crash
 * with a permission error but to hand the operator exactly what to give their
 * DBA.
 *
 * The script is pure DDL. It deliberately does not write the migration
 * bookkeeping rows: the service does that itself when it next connects and
 * finds every table already present (see `PrimaryDb.migrate`). That keeps this
 * function free of any statement built by interpolation, which is the property
 * `test/security/no-sql-interpolation.spec.ts` exists to hold — and it means an
 * operator cannot half-run the script and leave the service believing a
 * migration was applied.
 *
 * `CREATE … IF NOT EXISTS` checks permissions before existence, so a role that
 * cannot create objects fails on these statements even when the object is
 * already there. That is why the service skips the DDL entirely rather than
 * relying on it being a no-op.
 */
export function buildSetupSql(schema: string): string {
  const s = `"${schema}"`;

  const parts: string[] = [
    '-- Ori agent service — table setup',
    '--',
    '-- Run this as a role that may create objects in this database. Afterwards,',
    '-- return to the setup screen and choose "I have run it — check now".',
    '--',
    '-- Every object is named agent_* and nothing here touches an existing table.',
    '',
    `CREATE SCHEMA IF NOT EXISTS ${s};`,
    '',
    buildMigrationsTableSql(s),
  ];

  for (const migration of buildMigrations(s)) {
    parts.push('', sectionRule(migration.id), dedent(migration.sql));
  }

  parts.push(
    '',
    sectionRule('grants'),
    '-- If the service connects as a different role from the one running this,',
    '-- give it access to what was just created:',
    '--',
    `--   GRANT USAGE ON SCHEMA ${s} TO your_service_role;`,
    '--   GRANT SELECT, INSERT, UPDATE, DELETE',
    `--     ON ALL TABLES IN SCHEMA ${s} TO your_service_role;`,
    `--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO your_service_role;`,
  );

  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function sectionRule(label: string): string {
  return `-- ${'─'.repeat(3)} ${label} ${'─'.repeat(Math.max(3, 66 - label.length))}`;
}

/** Strips the common indentation the migration literals carry. */
function dedent(sql: string): string {
  const lines = sql.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^ */)![0].length),
  );
  return lines.map((line) => line.slice(indent)).join('\n');
}
