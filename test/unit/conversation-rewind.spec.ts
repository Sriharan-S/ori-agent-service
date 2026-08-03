import { ConversationService } from '../../src/memory/conversation.service';
import type { PrimaryDb } from '../../src/db/primary.db';
import type { RequestContext } from '../../src/auth/identity';

/**
 * Editing an earlier message.
 *
 * The interesting part is not that turns disappear — it is *which* turns, and
 * whose. A message id is a small integer a client hands us, so the statement
 * that acts on it has to be joined to the caller's own conversation or the
 * feature is a way to rewind someone else's transcript.
 *
 * These tests assert the SQL that is issued rather than its effect, because the
 * guarantee lives in the statement: the WHERE clause is the security boundary.
 */

interface Issued {
  sql: string;
  params: readonly unknown[];
}

function db(results: unknown[][] = []): { db: PrimaryDb; issued: Issued[] } {
  const issued: Issued[] = [];
  let call = 0;

  const stub = {
    schema: 'ori',
    query: jest.fn((sql: string, params: readonly unknown[] = []) => {
      issued.push({ sql, params });
      return Promise.resolve(results[call++] ?? []);
    }),
    one: jest.fn((sql: string, params: readonly unknown[] = []) => {
      issued.push({ sql, params });
      const rows = results[call++] ?? [];
      return Promise.resolve(rows[0] ?? null);
    }),
  };

  return { db: stub as unknown as PrimaryDb, issued };
}

function context(overrides: { applicationId?: number; endUserId?: string } = {}): RequestContext {
  return {
    application: { id: overrides.applicationId ?? 7 },
    endUser: { id: overrides.endUserId ?? 'user-42' },
  } as unknown as RequestContext;
}

/** Collapses whitespace so assertions are about the clause, not the layout. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ');

describe('rewinding a conversation', () => {
  it('confines the update to the caller\'s own conversation', async () => {
    const { db: stub, issued } = db([[{ id: 5 }, { id: 6 }], []]);
    const service = new ConversationService(stub);

    await service.supersedeFrom('conv-key', 5, context({ applicationId: 7, endUserId: 'user-42' }));

    const update = flat(issued[0]!.sql);
    expect(update).toContain('c.application_id = $2');
    expect(update).toContain('c.end_user_id = $3');
    expect(issued[0]!.params).toEqual(['conv-key', 7, 'user-42', 5]);
  });

  it('marks turns rather than deleting them', async () => {
    const { db: stub, issued } = db([[{ id: 5 }], []]);
    const service = new ConversationService(stub);

    await service.supersedeFrom('conv-key', 5, context());

    expect(flat(issued[0]!.sql)).toContain('SET superseded_at = now()');
    expect(issued.some((entry) => /DELETE\s+FROM/i.test(entry.sql))).toBe(false);
  });

  it('clears the pending clarification, which belonged to the discarded branch', async () => {
    const { db: stub, issued } = db([[{ id: 5 }, { id: 6 }], []]);
    const service = new ConversationService(stub);

    await service.supersedeFrom('conv-key', 5, context());

    const followUp = flat(issued[1]!.sql);
    expect(followUp).toContain('pending_state = NULL');
    expect(followUp).toContain('message_count = GREATEST(message_count - $2, 0)');
    expect(issued[1]!.params).toEqual(['conv-key', 2]);
  });

  it('does nothing further when the message is not the caller\'s to rewind', async () => {
    const { db: stub, issued } = db([[]]);
    const service = new ConversationService(stub);

    const outcome = await service.supersedeFrom('conv-key', 5, context());

    expect(outcome).toEqual({ removed: 0 });
    // No count adjustment, no pending clear — a miss must not touch the
    // conversation at all.
    expect(issued).toHaveLength(1);
  });

  it('hides superseded turns from the history the agent reads', async () => {
    const { db: stub, issued } = db([[]]);
    const service = new ConversationService(stub);

    await service.getHistory('conv-key');

    expect(flat(issued[0]!.sql)).toContain('m.superseded_at IS NULL');
  });

  it('keeps superseded turns in the transcript an operator reads', async () => {
    const { db: stub, issued } = db([[]]);
    const service = new ConversationService(stub);

    await service.getTranscript('conv-key');

    expect(flat(issued[0]!.sql)).toContain('m.superseded_at');
    expect(flat(issued[0]!.sql)).not.toContain('superseded_at IS NULL');
  });
});

describe('recording a turn', () => {
  it('returns the id the turn was stored under', async () => {
    const { db: stub } = db([[{ id: '918' }], []]);
    const service = new ConversationService(stub);

    await expect(service.appendTurn('conv-key', 'user', 'hello')).resolves.toBe(918);
  });

  it('reports null when the conversation does not exist, rather than throwing', async () => {
    const { db: stub } = db([[], []]);
    const service = new ConversationService(stub);

    await expect(service.appendTurn('missing', 'user', 'hello')).resolves.toBeNull();
  });
});
