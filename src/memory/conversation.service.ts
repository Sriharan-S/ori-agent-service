import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RequestContext } from '../auth/identity';
import type { Candidate } from '../registry/function.contract';

export interface PendingDisambiguation {
  functionName: string;
  /** Parameter the chosen candidate id is written into. */
  resolveInto: string;
  /** The original call's parameters, minus the identifier being resolved. */
  originalParams: Record<string, unknown>;
  candidates: Candidate[];
  searchedBy: string;
  askedAt: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationSummary {
  conversationKey: string;
  endUserId: string;
  endUserRole: string;
  title: string | null;
  messageCount: number;
  updatedAt: Date;
}

/** A clarification the user never answered stops being relevant. */
const PENDING_TTL_MS = 15 * 60 * 1000;
const HISTORY_TURNS = 8;

/**
 * Multi-turn state, including the pending disambiguation that makes the
 * clarification round-trip work.
 *
 * Conversations belong to (application, end user). A conversation key the
 * caller does not own is treated as absent rather than as an error — the agent
 * starts a fresh one instead of leaking a transcript or failing the request.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async resolve(
    conversationKey: string | null,
    context: RequestContext,
  ): Promise<string> {
    if (conversationKey) {
      const owned = await this.db.one<{ id: string }>(
        `SELECT id FROM ${this.schema}.agent_conversations
          WHERE conversation_key = $1 AND application_id = $2 AND end_user_id = $3
          LIMIT 1`,
        [conversationKey, context.application.id, context.endUser.id],
      );
      if (owned) return conversationKey;

      this.logger.warn(
        `Conversation ${conversationKey} is not accessible to ${context.endUser.id} — starting a new one`,
      );
    }

    const key = randomUUID();
    await this.db.query(
      `INSERT INTO ${this.schema}.agent_conversations
         (application_id, conversation_key, end_user_id, end_user_role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_key) DO NOTHING`,
      [
        context.application.id,
        key,
        context.endUser.id,
        context.endUser.role,
      ],
    );

    return key;
  }

  /** Returns the new message's id, so a client can later address this turn. */
  async appendTurn(
    conversationKey: string,
    role: 'user' | 'assistant',
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<number | null> {
    const inserted = await this.db.one<{ id: string | number }>(
      `INSERT INTO ${this.schema}.agent_messages (conversation_id, role, content, metadata)
       SELECT id, $2, $3, $4::jsonb FROM ${this.schema}.agent_conversations
        WHERE conversation_key = $1
       RETURNING id`,
      [conversationKey, role, content, JSON.stringify(metadata)],
    );

    await this.db.query(
      `UPDATE ${this.schema}.agent_conversations
          SET updated_at = now(),
              message_count = message_count + 1,
              -- First user turn names the conversation, so the dashboard has
              -- something readable without a summarisation call.
              title = COALESCE(title, CASE WHEN $2 = 'user' THEN left($3, 120) END)
        WHERE conversation_key = $1`,
      [conversationKey, role, content],
    );

    return inserted ? Number(inserted.id) : null;
  }

  /**
   * Discard a turn and everything after it.
   *
   * This is what "edit that message and continue from there" means on the
   * server. The rows are marked rather than removed — see migration
   * `0007_message_supersede` — so the agent stops reading them while an
   * operator can still see the branch that was abandoned.
   *
   * Ownership is checked the same way `resolve` checks it, and for the same
   * reason: a message id is a small integer, and without the join on
   * (application, end user) anyone could rewind anyone's conversation.
   *
   * The pending disambiguation is cleared unconditionally. It belongs to the
   * discarded branch, and a "the second one" answered against a question that
   * no longer exists is worse than no pending state at all.
   */
  async supersedeFrom(
    conversationKey: string,
    messageId: number,
    context: RequestContext,
  ): Promise<{ removed: number }> {
    const rows = await this.db.query<{ id: string | number }>(
      `UPDATE ${this.schema}.agent_messages m
          SET superseded_at = now()
         FROM ${this.schema}.agent_conversations c
        WHERE m.conversation_id = c.id
          AND c.conversation_key = $1
          AND c.application_id   = $2
          AND c.end_user_id      = $3
          AND m.superseded_at IS NULL
          -- Ordered by (created_at, id) everywhere else, so "at or after" is
          -- expressed the same way here rather than by id alone.
          AND (m.created_at, m.id) >= (
                SELECT m2.created_at, m2.id
                  FROM ${this.schema}.agent_messages m2
                 WHERE m2.id = $4 AND m2.conversation_id = c.id)
        RETURNING m.id`,
      [
        conversationKey,
        context.application.id,
        context.endUser.id,
        messageId,
      ],
    );

    if (rows.length === 0) {
      // Either the message is not in this conversation, the conversation is not
      // this caller's, or it was already superseded. None of those is worth
      // distinguishing to the caller — the turn is simply not theirs to rewind.
      this.logger.warn(
        `Rewind of ${conversationKey} to message ${messageId} by ${context.endUser.id} matched nothing`,
      );
      return { removed: 0 };
    }

    await this.db.query(
      `UPDATE ${this.schema}.agent_conversations
          SET message_count = GREATEST(message_count - $2, 0),
              pending_state = NULL,
              updated_at = now()
        WHERE conversation_key = $1`,
      [conversationKey, rows.length],
    );

    this.logger.log(
      `Rewound ${conversationKey} to message ${messageId}: ${rows.length} turn(s) superseded`,
    );

    return { removed: rows.length };
  }

  /** Recent live turns, oldest first, for the planner and synthesizer prompts. */
  async getHistory(conversationKey: string): Promise<ConversationTurn[]> {
    const rows = await this.db.query<{ role: string; content: string }>(
      `SELECT m.role, m.content
         FROM ${this.schema}.agent_messages m
         JOIN ${this.schema}.agent_conversations c ON c.id = m.conversation_id
        WHERE c.conversation_key = $1
          AND m.superseded_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $2`,
      [conversationKey, HISTORY_TURNS],
    );

    return rows.reverse().map((row) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
    }));
  }

  async setPending(
    conversationKey: string,
    pending: PendingDisambiguation,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ${this.schema}.agent_conversations
          SET pending_state = $2::jsonb, updated_at = now()
        WHERE conversation_key = $1`,
      [conversationKey, JSON.stringify(pending)],
    );
  }

  async getPending(
    conversationKey: string,
  ): Promise<PendingDisambiguation | null> {
    const row = await this.db.one<{
      pending_state: PendingDisambiguation | null;
    }>(
      `SELECT pending_state FROM ${this.schema}.agent_conversations
        WHERE conversation_key = $1`,
      [conversationKey],
    );

    const pending = row?.pending_state ?? null;
    if (!pending) return null;

    if (Date.now() - pending.askedAt > PENDING_TTL_MS) {
      await this.clearPending(conversationKey);
      return null;
    }

    return pending;
  }

  async clearPending(conversationKey: string): Promise<void> {
    await this.db.query(
      `UPDATE ${this.schema}.agent_conversations SET pending_state = NULL
        WHERE conversation_key = $1`,
      [conversationKey],
    );
  }

  /** For the dashboard. */
  async list(
    applicationId: number,
    limit = 50,
    offset = 0,
  ): Promise<ConversationSummary[]> {
    const rows = await this.db.query<{
      conversation_key: string;
      end_user_id: string;
      end_user_role: string;
      title: string | null;
      message_count: number;
      updated_at: Date;
    }>(
      `SELECT conversation_key, end_user_id, end_user_role, title, message_count, updated_at
         FROM ${this.schema}.agent_conversations
        WHERE application_id = $1
        ORDER BY updated_at DESC
        LIMIT $2 OFFSET $3`,
      [applicationId, Math.min(limit, 200), offset],
    );

    return rows.map((row) => ({
      conversationKey: row.conversation_key,
      endUserId: row.end_user_id,
      endUserRole: row.end_user_role,
      title: row.title,
      messageCount: row.message_count,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * The whole conversation, superseded turns included and marked as such.
   *
   * The console is the one place that wants the abandoned branch: "why did the
   * agent answer that" is often answered by a question the user withdrew.
   */
  async getTranscript(
    conversationKey: string,
  ): Promise<
    Array<
      ConversationTurn & {
        id: number;
        createdAt: Date;
        metadata: unknown;
        supersededAt: Date | null;
      }
    >
  > {
    const rows = await this.db.query<{
      id: string | number;
      role: string;
      content: string;
      metadata: unknown;
      created_at: Date;
      superseded_at: Date | null;
    }>(
      `SELECT m.id, m.role, m.content, m.metadata, m.created_at, m.superseded_at
         FROM ${this.schema}.agent_messages m
         JOIN ${this.schema}.agent_conversations c ON c.id = m.conversation_id
        WHERE c.conversation_key = $1
        ORDER BY m.created_at, m.id`,
      [conversationKey],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
      metadata: row.metadata,
      createdAt: row.created_at,
      supersededAt: row.superseded_at,
    }));
  }
}
