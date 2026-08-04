import { Injectable, Logger } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RequestContext } from '../auth/identity';

export type Rating = 'up' | 'down';

export interface FeedbackInput {
  rating: Rating;
  conversationId?: string | null;
  runId?: string | null;
  messageId?: number | null;
  comment?: string | null;
}

export interface FeedbackRecord {
  id: number;
  rating: Rating;
  comment: string | null;
  question: string;
  answer: string;
  functionsUsed: string[];
  conversationKey: string | null;
  runKey: string | null;
  messageId: number | null;
  endUserId: string | null;
  endUserRole: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

/** A rated turn with everything needed to work out why it was wrong. */
export interface FeedbackDetail extends FeedbackRecord {
  run: {
    runKey: string;
    intent: string | null;
    responseType: string | null;
    status: string;
    functionsUsed: string[];
    latencyMs: number | null;
    error: string | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null;
  calls: Array<{
    functionName: string;
    status: string;
    params: Record<string, unknown>;
    scopesApplied: Record<string, unknown>;
    rowCount: number | null;
    latencyMs: number;
    deniedReason: string | null;
    errorMessage: string | null;
    createdAt: Date;
  }>;
  transcript: Array<{ role: string; content: string; createdAt: Date }>;
}

const FEEDBACK_COLUMNS = `
  id, rating, comment, question, answer, functions_used, conversation_key,
  run_key, message_id, end_user_id, end_user_role, reviewed_at, created_at
`;

/**
 * Thumbs up and thumbs down on an answer.
 *
 * A dislike is the cheapest signal there is about a registry that needs work —
 * far cheaper than reading transcripts — but only if it lands next to the
 * evidence. So recording one snapshots the question and the answer, and keeps
 * the `run_key`, which is what joins it to the function calls the executor
 * actually made.
 *
 * The trace is never taken from the client. It is read back out of
 * `agent_audit_log`, written by the executor as each call ran, so a rating
 * cannot misrepresent what happened — only how someone felt about it.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /**
   * Record a rating, replacing any earlier one for the same turn.
   *
   * Changing your mind is an update, not a second contradictory row — which is
   * what the unique index on (run_key, message_id) enforces.
   */
  async record(
    context: RequestContext,
    input: FeedbackInput,
  ): Promise<FeedbackRecord> {
    const { question, answer, functionsUsed } = await this.snapshot(
      context,
      input,
    );

    const [row] = await this.db.query<FeedbackRow>(
      `INSERT INTO ${this.schema}.agent_feedback
         (application_id, conversation_key, run_key, message_id, rating,
          comment, question, answer, functions_used, end_user_id, end_user_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (run_key, message_id) WHERE run_key IS NOT NULL AND message_id IS NOT NULL
       DO UPDATE SET rating = EXCLUDED.rating,
                     comment = EXCLUDED.comment,
                     reviewed_at = NULL,
                     created_at = now()
       RETURNING ${FEEDBACK_COLUMNS}`,
      [
        context.application.id,
        input.conversationId ?? null,
        input.runId ?? null,
        input.messageId ?? null,
        input.rating,
        input.comment?.trim() ? input.comment.trim().slice(0, 2000) : null,
        question,
        answer,
        functionsUsed,
        context.endUser.id,
        context.endUser.role,
      ],
    );

    this.logger.log(
      `Feedback ${input.rating} on run ${input.runId ?? 'unknown'} ` +
        `(app ${context.application.slug})`,
    );

    return toRecord(row!);
  }

  /**
   * The question, the answer and the functions, as the service recorded them.
   *
   * Read from the agent's own tables rather than accepted from the caller: a
   * rating that came with its own idea of what was asked would be evidence of
   * nothing.
   */
  private async snapshot(
    context: RequestContext,
    input: FeedbackInput,
  ): Promise<{ question: string; answer: string; functionsUsed: string[] }> {
    const run = input.runId
      ? await this.db.one<{ functions_used: string[] }>(
          `SELECT functions_used FROM ${this.schema}.agent_runs
            WHERE run_key = $1 AND application_id = $2`,
          [input.runId, context.application.id],
        )
      : null;

    // The rated assistant turn, and the user turn immediately before it.
    const turns = input.messageId
      ? await this.db.query<{ role: string; content: string }>(
          `SELECT m.role, m.content
             FROM ${this.schema}.agent_messages m
             JOIN ${this.schema}.agent_conversations c ON c.id = m.conversation_id
            WHERE c.application_id = $2
              AND m.conversation_id = (
                    SELECT conversation_id FROM ${this.schema}.agent_messages
                     WHERE id = $1
                  )
              AND m.id <= $1
            ORDER BY m.id DESC
            LIMIT 2`,
          [input.messageId, context.application.id],
        )
      : [];

    const answer = turns.find((turn) => turn.role === 'assistant')?.content ?? '';
    const question = turns.find((turn) => turn.role === 'user')?.content ?? '';

    return { question, answer, functionsUsed: run?.functions_used ?? [] };
  }

  async list(
    applicationId: number,
    options: { rating?: Rating; onlyOpen?: boolean; limit?: number } = {},
  ): Promise<FeedbackRecord[]> {
    const rows = await this.db.query<FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM ${this.schema}.agent_feedback
        WHERE application_id = $1
          AND ($2::text IS NULL OR rating = $2)
          AND ($3::boolean IS NOT TRUE OR reviewed_at IS NULL)
        ORDER BY created_at DESC
        LIMIT $4`,
      [
        applicationId,
        options.rating ?? null,
        options.onlyOpen ?? false,
        Math.min(options.limit ?? 100, 500),
      ],
    );
    return rows.map(toRecord);
  }

  async summary(applicationId: number): Promise<{
    up: number;
    down: number;
    openDown: number;
  }> {
    const [row] = await this.db.query<{
      up: string;
      down: string;
      open_down: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE rating = 'up')   AS up,
         count(*) FILTER (WHERE rating = 'down') AS down,
         count(*) FILTER (WHERE rating = 'down' AND reviewed_at IS NULL) AS open_down
       FROM ${this.schema}.agent_feedback WHERE application_id = $1`,
      [applicationId],
    );

    return {
      up: Number(row?.up ?? 0),
      down: Number(row?.down ?? 0),
      openDown: Number(row?.open_down ?? 0),
    };
  }

  /** One rating with the run that produced it, for the console. */
  async get(
    applicationId: number,
    id: number,
  ): Promise<FeedbackDetail | null> {
    const row = await this.db.one<FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM ${this.schema}.agent_feedback
        WHERE application_id = $1 AND id = $2`,
      [applicationId, id],
    );
    if (!row) return null;

    const record = toRecord(row);

    const run = record.runKey
      ? await this.db.one<{
          run_key: string;
          intent: string | null;
          response_type: string | null;
          status: string;
          functions_used: string[];
          latency_ms: number | null;
          error: string | null;
          started_at: Date;
          completed_at: Date | null;
        }>(
          `SELECT run_key, intent, response_type, status, functions_used,
                  latency_ms, error, started_at, completed_at
             FROM ${this.schema}.agent_runs
            WHERE run_key = $1 AND application_id = $2`,
          [record.runKey, applicationId],
        )
      : null;

    // What actually ran, from the executor's own audit rows.
    const calls = record.runKey
      ? await this.db.query<AuditRow>(
          `SELECT function_name, status, params, scopes_applied, row_count,
                  latency_ms, denied_reason, error_message, created_at
             FROM ${this.schema}.agent_audit_log
            WHERE run_key = $1 AND application_id = $2
            ORDER BY created_at`,
          [record.runKey, applicationId],
        )
      : [];

    const transcript = record.conversationKey
      ? await this.db.query<{ role: string; content: string; created_at: Date }>(
          `SELECT m.role, m.content, m.created_at
             FROM ${this.schema}.agent_messages m
             JOIN ${this.schema}.agent_conversations c ON c.id = m.conversation_id
            WHERE c.conversation_key = $1
              AND c.application_id = $2
              AND m.superseded_at IS NULL
            ORDER BY m.created_at`,
          [record.conversationKey, applicationId],
        )
      : [];

    return {
      ...record,
      run: run
        ? {
            runKey: run.run_key,
            intent: run.intent,
            responseType: run.response_type,
            status: run.status,
            functionsUsed: run.functions_used ?? [],
            latencyMs: run.latency_ms,
            error: run.error,
            startedAt: run.started_at,
            completedAt: run.completed_at,
          }
        : null,
      calls: calls.map((call) => ({
        functionName: call.function_name,
        status: call.status,
        params: call.params ?? {},
        scopesApplied: call.scopes_applied ?? {},
        rowCount: call.row_count,
        latencyMs: call.latency_ms,
        deniedReason: call.denied_reason,
        errorMessage: call.error_message,
        createdAt: call.created_at,
      })),
      transcript: transcript.map((turn) => ({
        role: turn.role,
        content: turn.content,
        createdAt: turn.created_at,
      })),
    };
  }

  async setReviewed(
    applicationId: number,
    id: number,
    reviewed: boolean,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE ${this.schema}.agent_feedback
          SET reviewed_at = $3
        WHERE application_id = $1 AND id = $2
        RETURNING id`,
      [applicationId, id, reviewed ? new Date() : null],
    );
    return rows.length > 0;
  }

  async remove(applicationId: number, id: number): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.schema}.agent_feedback
        WHERE application_id = $1 AND id = $2 RETURNING id`,
      [applicationId, id],
    );
    return rows.length > 0;
  }
}

interface FeedbackRow {
  id: string;
  rating: string;
  comment: string | null;
  question: string;
  answer: string;
  functions_used: string[];
  conversation_key: string | null;
  run_key: string | null;
  message_id: string | null;
  end_user_id: string | null;
  end_user_role: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

interface AuditRow {
  function_name: string;
  status: string;
  params: Record<string, unknown>;
  scopes_applied: Record<string, unknown>;
  row_count: number | null;
  latency_ms: number;
  denied_reason: string | null;
  error_message: string | null;
  created_at: Date;
}

function toRecord(row: FeedbackRow): FeedbackRecord {
  return {
    id: Number(row.id),
    rating: row.rating === 'down' ? 'down' : 'up',
    comment: row.comment,
    question: row.question,
    answer: row.answer,
    functionsUsed: row.functions_used ?? [],
    conversationKey: row.conversation_key,
    runKey: row.run_key,
    messageId: row.message_id === null ? null : Number(row.message_id),
    endUserId: row.end_user_id,
    endUserRole: row.end_user_role,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}
