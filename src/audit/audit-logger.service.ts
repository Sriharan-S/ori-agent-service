import { Injectable, Logger } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RequestContext } from '../auth/identity';

export type AuditStatus =
  | 'success'
  | 'empty'
  | 'ambiguous'
  | 'denied'
  | 'invalid_params'
  | 'error';

export interface AuditRecord {
  context: RequestContext;
  conversationKey: string | null;
  functionName: string;
  functionVersion: number;
  functionKind: 'read' | 'write';
  params: Record<string, unknown>;
  scopesApplied: Record<string, string | number>;
  status: AuditStatus;
  deniedReason?: string;
  errorMessage?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  disambiguated?: boolean;
  disambiguationResolution?: string;
  rowCount?: number;
  latencyMs: number;
}

/** Parameter names whose values never reach a log line or the audit table. */
const SENSITIVE_PARAMS = new Set([
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'ssn',
  'pan',
  'aadhar',
  'card',
  'cvv',
]);

/**
 * Records every function call — succeeded, failed, denied and rejected alike.
 *
 * Writes go to the agent's own schema, and the structured log always gets the
 * record too. An audit trail that stops on a database hiccup is not an audit
 * trail, so `record()` never throws: a failure here must not take down the
 * request it was describing, but it must be loud about it.
 */
@Injectable()
export class AuditLoggerService {
  private readonly logger = new Logger('ORI-AUDIT');

  constructor(private readonly db: PrimaryDb) {}

  async record(record: AuditRecord): Promise<void> {
    const params = sanitizeParams(record.params);
    const { context } = record;

    const line = {
      type: 'FUNCTION_CALL',
      runId: context.runId,
      application: context.application.slug,
      endUserId: context.endUser.id,
      role: context.endUser.role,
      conversationKey: record.conversationKey,
      functionName: record.functionName,
      functionVersion: record.functionVersion,
      functionKind: record.functionKind,
      params,
      scopesApplied: record.scopesApplied,
      status: record.status,
      deniedReason: record.deniedReason ?? null,
      errorMessage: record.errorMessage ?? null,
      disambiguated: record.disambiguated ?? false,
      rowCount: record.rowCount ?? null,
      latencyMs: record.latencyMs,
    };

    if (record.status === 'denied' || record.status === 'error') {
      this.logger.warn(JSON.stringify(line));
    } else {
      this.logger.log(JSON.stringify(line));
    }

    try {
      await this.db.query(
        `INSERT INTO ${quoteIdent(this.db.schema)}.audit_log (
           application_id, run_key, conversation_key, end_user_id, end_user_role,
           function_name, function_version, function_kind,
           params, scopes_applied, status, denied_reason, error_message,
           before_state, after_state,
           disambiguated, disambiguation_resolution, row_count, latency_ms
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10, $11, $12, $13,
           $14, $15,
           $16, $17, $18, $19
         )`,
        [
          context.application.id,
          context.runId,
          record.conversationKey,
          context.endUser.id,
          context.endUser.role,
          record.functionName,
          record.functionVersion,
          record.functionKind,
          JSON.stringify(params),
          JSON.stringify(record.scopesApplied),
          record.status,
          record.deniedReason ?? null,
          record.errorMessage ?? null,
          record.beforeState ? JSON.stringify(record.beforeState) : null,
          record.afterState ? JSON.stringify(record.afterState) : null,
          record.disambiguated ?? false,
          record.disambiguationResolution ?? null,
          record.rowCount ?? null,
          record.latencyMs,
        ],
      );
    } catch (error) {
      this.logger.error(
        `AUDIT PERSIST FAILED for run ${context.runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** A request that never reached a function — no plan, rate limited, refused. */
  recordRejection(context: RequestContext, reason: string): void {
    this.logger.warn(
      JSON.stringify({
        type: 'REQUEST_REJECTED',
        runId: context.runId,
        application: context.application.slug,
        endUserId: context.endUser.id,
        role: context.endUser.role,
        reason,
      }),
    );
  }
}

/**
 * Mask sensitive values and truncate long free text.
 *
 * Search terms *are* recorded — knowing what was asked for is most of the value
 * of the trail — but nothing is stored at a length that would let a prompt
 * smuggle a payload into a log line.
 */
export function sanitizeParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (SENSITIVE_PARAMS.has(key.toLowerCase())) {
      output[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      output[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
      continue;
    }
    output[key] = value;
  }

  return output;
}
