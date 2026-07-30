import { SetupService } from '../../src/setup/setup.service';
import { AGENT_TABLES } from '../../src/db/migrations';
import { loadConfiguration, type AppConfig } from '../../src/config/configuration';
import type { PrimaryDb, PrimaryDbStatus } from '../../src/db/primary.db';
import type { ReadDb, ReadDbStatus } from '../../src/db/read.db';
import type { AdminAuthService } from '../../src/admin/admin-auth.service';
import type { ModelRegistryService } from '../../src/llm/model-registry.service';

/**
 * The onboarding state machine.
 *
 * Worth testing rather than clicking through, because most of these states are
 * hard to reach on purpose — a database that will not let you create a table, a
 * database that was working and has stopped — and each of them is a different
 * screen that has to say the right thing.
 */

function config(overrides: Partial<AppConfig['db']> = {}): AppConfig {
  const base = loadConfiguration();
  return {
    ...base,
    db: {
      ...base.db,
      primaryUrl: 'postgres://user:pw@db.example.com:5432/app',
      readUrl: 'postgres://reader:pw@db.example.com:5432/app',
      schema: 'ori',
      allowWritableReadPool: false,
      ...overrides,
    },
    security: {
      ...base.security,
      // A valid 32-byte key, so ENCRYPTION_KEY never shows up as a problem
      // unless a test is specifically about it.
      encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    },
  };
}

function primaryDb(status: Partial<PrimaryDbStatus>): PrimaryDb {
  const full: PrimaryDbStatus = {
    stage: 'ready',
    schema: 'ori',
    error: null,
    detail: null,
    existingTables: [...AGENT_TABLES],
    missingTables: [],
    checkedAt: new Date(),
    ...status,
  };

  return {
    getStatus: () => full,
    isReady: () => full.stage === 'ready',
    connect: jest.fn(),
  } as unknown as PrimaryDb;
}

function readDb(status: Partial<ReadDbStatus> = {}): ReadDb {
  const full: ReadDbStatus = {
    stage: 'ready',
    error: null,
    detail: null,
    checkedAt: new Date(),
    ...status,
  };

  return {
    getStatus: () => full,
    isReady: () => full.stage === 'ready',
    connect: jest.fn(),
  } as unknown as ReadDb;
}

function admins(count: number | Error): AdminAuthService {
  return {
    countAdmins: () =>
      count instanceof Error ? Promise.reject(count) : Promise.resolve(count),
    ensureBootstrapAccount: jest.fn(),
    createFirstAdmin: jest.fn(),
  } as unknown as AdminAuthService;
}

const models = { seedIfEmpty: jest.fn() } as unknown as ModelRegistryService;

function service(
  primary: PrimaryDb,
  read: ReadDb,
  auth: AdminAuthService,
  cfg = config(),
): SetupService {
  return new SetupService(cfg, primary, read, auth, models);
}

const step = (status: Awaited<ReturnType<SetupService['status']>>, id: string) =>
  status.steps.find((entry) => entry.id === id)!;

/**
 * A working deployment whose dependencies can be broken afterwards.
 *
 * `SetupService` remembers, per instance, that it has seen an operator account,
 * so anything about a database going away has to be tested on one instance
 * rather than by constructing a second.
 */
function liveDeployment() {
  const state = {
    primaryStatus: {
      stage: 'ready',
      schema: 'ori',
      error: null,
      detail: null,
      existingTables: [...AGENT_TABLES],
      missingTables: [],
      checkedAt: new Date(),
    } as PrimaryDbStatus,
    readStatus: {
      stage: 'ready',
      error: null,
      detail: null,
      checkedAt: new Date(),
    } as ReadDbStatus,
    adminCount: 1 as number | Error,
    setup: null as unknown as SetupService,
  };

  const primary = {
    getStatus: () => state.primaryStatus,
    isReady: () => state.primaryStatus.stage === 'ready',
    connect: jest.fn(),
  } as unknown as PrimaryDb;

  const read = {
    getStatus: () => state.readStatus,
    isReady: () => state.readStatus.stage === 'ready',
    connect: jest.fn(),
  } as unknown as ReadDb;

  const auth = {
    countAdmins: () =>
      state.adminCount instanceof Error
        ? Promise.reject(state.adminCount)
        : Promise.resolve(state.adminCount),
    ensureBootstrapAccount: jest.fn(),
    createFirstAdmin: jest.fn(),
  } as unknown as AdminAuthService;

  state.setup = new SetupService(config(), primary, read, auth, models);
  return state;
}

describe('SetupService', () => {
  it('asks for a database first when none is configured', async () => {
    const status = await service(
      primaryDb({ stage: 'not-configured', existingTables: [], missingTables: [...AGENT_TABLES] }),
      readDb({ stage: 'not-configured' }),
      admins(0),
      config({ primaryUrl: '', readUrl: '' }),
    ).status();

    expect(status.complete).toBe(false);
    expect(status.stage).toBe('database');
    expect(step(status, 'tables').state).toBe('pending');
    expect(status.problems.map((problem) => problem.variable)).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'DATABASE_READ_URL']),
    );
  });

  it('hands over the DDL when the tables cannot be created', async () => {
    const status = await service(
      primaryDb({
        stage: 'tables-missing',
        error: 'could not create',
        detail: 'permission denied for database app',
        existingTables: [],
        missingTables: [...AGENT_TABLES],
      }),
      readDb(),
      admins(0),
    ).status();

    expect(status.stage).toBe('tables');
    expect(step(status, 'database').state).toBe('done');
    expect(status.tables.every((table) => !table.exists)).toBe(true);

    // The script has to actually contain every table, or the screen sends
    // someone away with SQL that leaves the service still broken.
    for (const table of AGENT_TABLES) {
      expect(status.sql).toContain(table);
    }
    // And no bookkeeping rows: the service records those itself afterwards.
    expect(status.sql).not.toContain('INSERT INTO');
  });

  it('walks through the read connection without blocking on it', async () => {
    const status = await service(
      primaryDb({}),
      readDb({ stage: 'writable', error: 'DATABASE_READ_URL can modify data' }),
      admins(0),
    ).status();

    // It is the next thing to show...
    expect(status.stage).toBe('read');
    expect(step(status, 'read').state).toBe('blocked');
    // ...but it is not what is holding the console shut.
    expect(step(status, 'read').blocking).toBe(false);
    expect(status.readRoleSql).toContain('CREATE ROLE ori_reader');
  });

  it('is complete once an account exists, even with the read connection down', async () => {
    const status = await service(
      primaryDb({}),
      readDb({ stage: 'unreachable', error: 'nothing accepted a connection' }),
      admins(1),
    ).status();

    expect(status.complete).toBe(true);
    expect(status.stage).toBe('ready');
  });

  it('reveals driver detail during setup, so a bad host can be seen', async () => {
    const unreachable = {
      stage: 'unreachable' as const,
      detail: 'connect ECONNREFUSED 10.0.0.5:5432',
    };

    const status = await service(
      primaryDb(unreachable),
      readDb(unreachable),
      admins(0),
    ).status();

    expect(step(status, 'database').detail).toContain('10.0.0.5');
  });

  it('withholds driver detail once an account has been seen', async () => {
    // One long-lived instance, as a running service is, with a database that
    // works and then stops.
    const live = liveDeployment();

    expect((await live.setup.status()).complete).toBe(true);

    live.primaryStatus.stage = 'unreachable';
    live.primaryStatus.detail = 'connect ECONNREFUSED 10.0.0.5:5432';
    live.readStatus.stage = 'unreachable';
    live.readStatus.detail = 'connect ECONNREFUSED 10.0.0.5:5432';
    live.adminCount = new Error('Connection terminated unexpectedly');

    const down = await live.setup.status();
    expect(down.steps.filter((entry) => entry.detail !== null)).toEqual([]);
  });

  it('reports a database that has gone away, rather than a fresh install', async () => {
    const live = liveDeployment();
    await live.setup.status();

    // The recorded stage is still `ready` because it connected at start-up.
    // Counting accounts is also the liveness probe, and it now fails.
    live.adminCount = new Error('Connection terminated unexpectedly');
    const status = await live.setup.status();

    expect(step(status, 'database').state).toBe('blocked');
    expect(step(status, 'database').summary).toContain('stopped responding');

    // And it must not offer to create an account: that would fail anyway, and
    // it tells whoever is looking that the deployment is empty when it is not.
    expect(step(status, 'account').state).toBe('pending');
    expect(step(status, 'account').summary).not.toContain('No operator account');
  });

  it('names a writable read connection as a problem to fix', async () => {
    const status = await service(
      primaryDb({}),
      readDb(),
      admins(1),
      config({ primaryUrl: 'postgres://u:p@h:5432/db', readUrl: 'postgres://u:p@h:5432/db' }),
    ).status();

    expect(status.problems.map((problem) => problem.variable)).toContain(
      'DATABASE_READ_URL',
    );
  });
});
