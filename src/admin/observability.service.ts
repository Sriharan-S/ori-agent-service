import { Injectable } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';

export interface LiveRun {
  runKey: string;
  applicationSlug: string;
  endUserId: string;
  endUserRole: string;
  intent: string | null;
  streamed: boolean;
  startedAt: Date;
  ageMs: number;
}

export interface RecentRun extends Omit<LiveRun, 'ageMs'> {
  status: string;
  responseType: string | null;
  functionsUsed: string[];
  latencyMs: number | null;
  error: string | null;
}

export interface Overview {
  runsLastHour: number;
  runsLast24h: number;
  failuresLast24h: number;
  activeRuns: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  clarificationRate: number;
  deniedLast24h: number;
  topFunctions: Array<{ name: string; calls: number; errorRate: number }>;
}

/**
 * Read models for the dashboard.
 *
 * Everything is derived from the `runs` and `audit_log` tables — the same rows
 * the audit trail is built from, so what an operator sees on screen and what is
 * on record cannot drift apart.
 */
const AUDIT_COLUMNS = `
  l.id, l.run_key, l.conversation_key, l.end_user_id, l.end_user_role,
  l.function_name, l.function_version, l.function_kind, l.params,
  l.scopes_applied, l.status, l.denied_reason, l.error_message,
  l.disambiguated, l.disambiguation_resolution, l.row_count,
  l.latency_ms, l.created_at, a.slug AS application_slug
`;

@Injectable()
export class ObservabilityService {
  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /**
   * Runs still in flight.
   *
   * A run older than the run timeout is almost certainly a client that
   * disconnected mid-stream rather than work still happening, so the age is
   * surfaced instead of being hidden.
   */
  async activeRuns(): Promise<LiveRun[]> {
    const rows = await this.db.query<{
      run_key: string;
      slug: string;
      end_user_id: string;
      end_user_role: string;
      intent: string | null;
      streamed: boolean;
      started_at: Date;
    }>(
      `SELECT r.run_key, a.slug, r.end_user_id, r.end_user_role,
              r.intent, r.streamed, r.started_at
         FROM ${this.schema}.agent_runs r
         JOIN ${this.schema}.agent_applications a ON a.id = r.application_id
        WHERE r.status = 'running'
        ORDER BY r.started_at DESC
        LIMIT 100`,
    );

    const now = Date.now();
    return rows.map((row) => ({
      runKey: row.run_key,
      applicationSlug: row.slug,
      endUserId: row.end_user_id,
      endUserRole: row.end_user_role,
      intent: row.intent,
      streamed: row.streamed,
      startedAt: row.started_at,
      ageMs: now - new Date(row.started_at).getTime(),
    }));
  }

  async recentRuns(limit = 50): Promise<RecentRun[]> {
    const rows = await this.db.query<{
      run_key: string;
      slug: string;
      end_user_id: string;
      end_user_role: string;
      intent: string | null;
      status: string;
      response_type: string | null;
      functions_used: string[];
      streamed: boolean;
      latency_ms: number | null;
      error: string | null;
      started_at: Date;
    }>(
      `SELECT r.run_key, a.slug, r.end_user_id, r.end_user_role, r.intent,
              r.status, r.response_type, r.functions_used, r.streamed,
              r.latency_ms, r.error, r.started_at
         FROM ${this.schema}.agent_runs r
         JOIN ${this.schema}.agent_applications a ON a.id = r.application_id
        ORDER BY r.started_at DESC
        LIMIT $1`,
      [Math.min(limit, 200)],
    );

    return rows.map((row) => ({
      runKey: row.run_key,
      applicationSlug: row.slug,
      endUserId: row.end_user_id,
      endUserRole: row.end_user_role,
      intent: row.intent,
      status: row.status,
      responseType: row.response_type,
      functionsUsed: row.functions_used,
      streamed: row.streamed,
      latencyMs: row.latency_ms,
      error: row.error,
      startedAt: row.started_at,
    }));
  }

  async overview(): Promise<Overview> {
    const [runs, functions] = await Promise.all([
      this.db.one<{
        last_hour: string;
        last_24h: string;
        failures: string;
        active: string;
        median: string | null;
        p95: string | null;
        clarifications: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE started_at > now() - interval '1 hour')::text  AS last_hour,
           COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours')::text AS last_24h,
           COUNT(*) FILTER (WHERE status = 'failed'
                              AND started_at > now() - interval '24 hours')::text AS failures,
           COUNT(*) FILTER (WHERE status = 'running')::text                       AS active,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::text          AS median,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::text         AS p95,
           COUNT(*) FILTER (WHERE response_type = 'clarification'
                              AND started_at > now() - interval '24 hours')::text AS clarifications
         FROM ${this.schema}.agent_runs
        WHERE started_at > now() - interval '24 hours' OR status = 'running'`,
      ),
      this.db.query<{ name: string; calls: string; errors: string }>(
        `SELECT function_name AS name,
                COUNT(*)::text AS calls,
                COUNT(*) FILTER (WHERE status IN ('error','denied'))::text AS errors
           FROM ${this.schema}.agent_audit_log
          WHERE created_at > now() - interval '24 hours'
          GROUP BY function_name
          ORDER BY COUNT(*) DESC
          LIMIT 10`,
      ),
    ]);

    const denied = await this.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.schema}.agent_audit_log
        WHERE status = 'denied' AND created_at > now() - interval '24 hours'`,
    );

    const last24h = Number(runs?.last_24h ?? 0);

    return {
      runsLastHour: Number(runs?.last_hour ?? 0),
      runsLast24h: last24h,
      failuresLast24h: Number(runs?.failures ?? 0),
      activeRuns: Number(runs?.active ?? 0),
      medianLatencyMs: runs?.median ? Math.round(Number(runs.median)) : null,
      p95LatencyMs: runs?.p95 ? Math.round(Number(runs.p95)) : null,
      clarificationRate:
        last24h > 0 ? Number(runs?.clarifications ?? 0) / last24h : 0,
      deniedLast24h: Number(denied?.count ?? 0),
      topFunctions: functions.map((row) => ({
        name: row.name,
        calls: Number(row.calls),
        errorRate:
          Number(row.calls) > 0 ? Number(row.errors) / Number(row.calls) : 0,
      })),
    };
  }

  async auditLog(
    limit = 100,
    functionName?: string,
  ): Promise<Array<Record<string, unknown>>> {
    // Explicit column lists here too. Before/after state can hold whatever a
    // host API returned, and the console renders these rows verbatim — so the
    // dashboard reads only the columns it means to display.
    return this.db.query(
      functionName
        ? `SELECT ${AUDIT_COLUMNS}
             FROM ${this.schema}.agent_audit_log l
             JOIN ${this.schema}.agent_applications a ON a.id = l.application_id
            WHERE l.function_name = $2
            ORDER BY l.created_at DESC LIMIT $1`
        : `SELECT ${AUDIT_COLUMNS}
             FROM ${this.schema}.agent_audit_log l
             JOIN ${this.schema}.agent_applications a ON a.id = l.application_id
            ORDER BY l.created_at DESC LIMIT $1`,
      functionName
        ? [Math.min(limit, 500), functionName]
        : [Math.min(limit, 500)],
    );
  }

  /** Trace for one run, reconstructed from its audit rows. */
  async runDetail(runKey: string): Promise<{
    run: Record<string, unknown> | null;
    calls: Array<Record<string, unknown>>;
  }> {
    const [run, calls] = await Promise.all([
      this.db.one<Record<string, unknown>>(
        `SELECT r.run_key, r.conversation_key, r.end_user_id, r.end_user_role,
                r.intent, r.status, r.response_type, r.functions_used,
                r.streamed, r.error, r.latency_ms, r.started_at, r.completed_at,
                a.slug AS application_slug
           FROM ${this.schema}.agent_runs r
           JOIN ${this.schema}.agent_applications a ON a.id = r.application_id
          WHERE r.run_key = $1`,
        [runKey],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT id, function_name, function_version, function_kind, params,
                scopes_applied, status, denied_reason, error_message,
                disambiguated, disambiguation_resolution, row_count,
                latency_ms, created_at
           FROM ${this.schema}.agent_audit_log
          WHERE run_key = $1 ORDER BY created_at`,
        [runKey],
      ),
    ]);

    return { run, calls };
  }

  /**
   * Marks runs abandoned once they exceed the timeout.
   *
   * A client that disconnects mid-stream leaves its row `running` forever
   * otherwise, which quietly inflates the active count until nobody trusts it.
   */
  async reapStaleRuns(timeoutMs: number): Promise<number> {
    const rows = await this.db.query<{ run_key: string }>(
      `UPDATE ${this.schema}.agent_runs
          SET status = 'failed',
              error = 'Abandoned: no completion recorded before the run timeout',
              completed_at = now()
        WHERE status = 'running'
          AND started_at < now() - make_interval(secs => $1)
      RETURNING run_key`,
      [Math.ceil(timeoutMs / 1000)],
    );
    return rows.length;
  }
}
