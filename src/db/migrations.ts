/**
 * Schema for the agent's own tables.
 *
 * Everything lives in one schema (default `ori`) inside the database named by
 * `DATABASE_URL`, so the service adds one namespace to a host application's
 * database rather than requiring its own. Nothing here touches host tables.
 *
 * Migrations are ordered, idempotent, and recorded in `schema_migrations`. Kept
 * as plain SQL rather than an ORM's migration tool because the service already
 * has a first-class relationship with raw SQL and adding a second mechanism
 * would be one more thing to keep honest.
 */

export interface Migration {
  id: string;
  sql: string;
}

export function buildMigrations(schema: string): Migration[] {
  const s = schema;

  return [
    {
      id: '0001_core',
      sql: `
        CREATE SCHEMA IF NOT EXISTS ${s};

        -- Tenants. One row per host application calling this service.
        CREATE TABLE IF NOT EXISTS ${s}.applications (
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
          CONSTRAINT applications_end_user_auth_check
            CHECK (end_user_auth IN ('jwt', 'asserted'))
        );

        CREATE TABLE IF NOT EXISTS ${s}.api_keys (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
          name           TEXT        NOT NULL,
          -- Lookup handle. The secret itself is only ever stored hashed.
          prefix         TEXT        NOT NULL UNIQUE,
          key_hash       TEXT        NOT NULL,
          scopes         TEXT[]      NOT NULL DEFAULT ARRAY['chat'],
          last_used_at   TIMESTAMPTZ,
          revoked_at     TIMESTAMPTZ,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS api_keys_application_idx
          ON ${s}.api_keys (application_id) WHERE revoked_at IS NULL;

        -- Data-driven RBAC. A role is a row, not a class.
        CREATE TABLE IF NOT EXISTS ${s}.roles (
          id                BIGSERIAL PRIMARY KEY,
          application_id    BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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
        CREATE TABLE IF NOT EXISTS ${s}.services (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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
        CREATE TABLE IF NOT EXISTS ${s}.functions (
          id                    BIGSERIAL PRIMARY KEY,
          application_id        BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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
          CONSTRAINT functions_kind_check   CHECK (kind IN ('read', 'write')),
          CONSTRAINT functions_status_check CHECK (status IN ('draft', 'approved', 'live', 'disabled')),
          CONSTRAINT functions_returns_check
            CHECK (returns IN ('single', 'list', 'single-or-ambiguous', 'confirmation')),
          -- A read function needs SQL; a write function needs an HTTP action.
          CONSTRAINT functions_body_check CHECK (
            (kind = 'read'  AND sql_template IS NOT NULL) OR
            (kind = 'write' AND http_request IS NOT NULL)
          )
        );

        CREATE INDEX IF NOT EXISTS functions_live_idx
          ON ${s}.functions (application_id) WHERE status = 'live';

        CREATE TABLE IF NOT EXISTS ${s}.function_versions (
          id          BIGSERIAL PRIMARY KEY,
          function_id BIGINT      NOT NULL REFERENCES ${s}.functions(id) ON DELETE CASCADE,
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
        CREATE TABLE IF NOT EXISTS ${s}.models (
          id                 BIGSERIAL PRIMARY KEY,
          -- NULL means available to every application.
          application_id     BIGINT      REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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
          CONSTRAINT models_purpose_check
            CHECK (purpose IN ('any', 'planner', 'synthesizer', 'router'))
        );

        CREATE INDEX IF NOT EXISTS models_selection_idx
          ON ${s}.models (purpose, priority) WHERE is_enabled;
      `,
    },

    {
      id: '0004_admin',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.admin_users (
          id            BIGSERIAL PRIMARY KEY,
          email         TEXT        NOT NULL UNIQUE,
          name          TEXT,
          password_hash TEXT        NOT NULL,
          role          TEXT        NOT NULL DEFAULT 'admin',
          is_active     BOOLEAN     NOT NULL DEFAULT true,
          last_login_at TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'admin', 'viewer'))
        );

        CREATE TABLE IF NOT EXISTS ${s}.admin_sessions (
          id            BIGSERIAL PRIMARY KEY,
          admin_user_id BIGINT      NOT NULL REFERENCES ${s}.admin_users(id) ON DELETE CASCADE,
          token_hash    TEXT        NOT NULL UNIQUE,
          expires_at    TIMESTAMPTZ NOT NULL,
          ip            TEXT,
          user_agent    TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
          ON ${s}.admin_sessions (expires_at);
      `,
    },

    {
      id: '0005_conversations',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.conversations (
          id               BIGSERIAL PRIMARY KEY,
          application_id   BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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

        CREATE INDEX IF NOT EXISTS conversations_user_idx
          ON ${s}.conversations (application_id, end_user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS ${s}.messages (
          id              BIGSERIAL PRIMARY KEY,
          conversation_id BIGINT      NOT NULL REFERENCES ${s}.conversations(id) ON DELETE CASCADE,
          role            TEXT        NOT NULL,
          content         TEXT        NOT NULL,
          metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS messages_conversation_idx
          ON ${s}.messages (conversation_id, created_at);

        -- One row per agent run. Powers the live activity view and is what the
        -- trace stream is recorded against.
        CREATE TABLE IF NOT EXISTS ${s}.runs (
          id              BIGSERIAL PRIMARY KEY,
          application_id  BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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
          CONSTRAINT runs_status_check CHECK (status IN ('running', 'completed', 'failed'))
        );

        CREATE INDEX IF NOT EXISTS runs_recent_idx
          ON ${s}.runs (application_id, started_at DESC);
      `,
    },

    {
      id: '0006_audit',
      sql: `
        CREATE TABLE IF NOT EXISTS ${s}.audit_log (
          id                        BIGSERIAL PRIMARY KEY,
          application_id            BIGINT      NOT NULL REFERENCES ${s}.applications(id) ON DELETE CASCADE,
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

        CREATE INDEX IF NOT EXISTS audit_run_idx  ON ${s}.audit_log (run_key);
        CREATE INDEX IF NOT EXISTS audit_time_idx ON ${s}.audit_log (application_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS audit_fn_idx   ON ${s}.audit_log (function_name, created_at DESC);
      `,
    },
  ];
}
