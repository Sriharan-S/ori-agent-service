import { HttpFunctionRunner } from '../../src/registry/http-function.runner';
import type { PrimaryDb } from '../../src/db/primary.db';
import type { ReadDb } from '../../src/db/read.db';
import type { RequestContext } from '../../src/auth/identity';
import type {
  FunctionDefinition,
  HttpRequestSpec,
} from '../../src/registry/function.contract';
import type { ScopeFilterDefinition } from '../../src/registry/sql-template';
import { loadConfiguration } from '../../src/config/configuration';

/**
 * Asynchronous actions, scope binding, and the values that come back.
 *
 * Three things here are security properties rather than features:
 *
 *   - the URL a poll follows comes out of a *response body*, so it is
 *     attacker-adjacent input and must be re-pinned to the registered origin;
 *   - a precondition that cannot bind its scope must refuse, matching the
 *     guarantee reads have had since the beginning;
 *   - a scope token in a path must never compile to nothing, because an empty
 *     path segment silently addresses a different resource.
 */

const SERVICES = [
  {
    name: 'reports',
    base_url: 'https://reports.internal.test/',
    public_base_url: 'https://portal.example.com/',
  },
];

const db = {
  schema: 'ori',
  query: () => Promise.resolve(SERVICES),
} as unknown as PrimaryDb;

function readDb(rows: unknown[] = [{ ok: 1 }], fail = false): ReadDb {
  return {
    query: () =>
      fail
        ? Promise.reject(new Error('relation "nope" does not exist'))
        : Promise.resolve({ rows, fields: ['ok'] }),
  } as unknown as ReadDb;
}

function context(overrides: {
  scopes?: Record<string, string | number>;
  unscopedKeys?: string[];
  role?: string;
} = {}): RequestContext {
  return {
    application: { id: 1, slug: 'test', name: 'Test', endUserAuth: 'asserted', isActive: true },
    apiKey: { id: 1, applicationId: 1, name: 'k', prefix: 'ori_t', scopes: ['chat'] },
    endUser: { id: 'u1', role: overrides.role ?? 'STUDENT', scopes: overrides.scopes ?? {}, token: null },
    role: {
      id: 1,
      applicationId: 1,
      name: overrides.role ?? 'STUDENT',
      description: null,
      allowedFunctions: ['*'],
      writeScopes: ['*'],
      unscopedKeys: overrides.unscopedKeys ?? [],
    },
    runId: 'run-1',
    requestId: 'req-1',
    traceEnabled: false,
  } as unknown as RequestContext;
}

function definition(
  httpRequest: HttpRequestSpec,
  scopeFilters: ScopeFilterDefinition[] = [],
): FunctionDefinition {
  return {
    id: 1,
    applicationId: 1,
    name: 'generate_report',
    category: 'reports',
    kind: 'write',
    description: 'test',
    whenToUse: [],
    whenNotToUse: [],
    parameters: {},
    requiredOneOf: [],
    returns: 'confirmation',
    ambiguityResolvesTo: null,
    allowedRoles: ['*'],
    scopeFilters,
    sqlTemplate: null,
    httpRequest,
    writeScope: 'reports.generate',
    requiresConfirmation: false,
    defaultLimit: null,
    maxLimit: null,
    status: 'live',
    version: 1,
    lastValidatedAt: null,
    validationError: null,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A fresh Response per call. A Response body can only be read once, so reusing
 * one across a poll loop fails on the second read for reasons that have nothing
 * to do with what is being tested.
 */
const always = (body: unknown, status = 200) => () =>
  Promise.resolve(json(body, status));

/** The interval floor is asserted on its own; elsewhere it only slows tests. */
function fastConfig(): ReturnType<typeof loadConfiguration> {
  const base = loadConfiguration();
  return { ...base, outbound: { ...base.outbound, pollMinIntervalMs: 1 } };
}

const POLL: HttpRequestSpec['poll'] = {
  urlFrom: 'statusUrl',
  statusField: 'status',
  successWhen: ['COMPLETED'],
  failureWhen: ['ERROR'],
  intervalMs: 1,
  maxAttempts: 5,
};

describe('asynchronous HTTP actions', () => {
  const runner = () =>
    new HttpFunctionRunner(fastConfig(), db, readDb());
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('waits for the job and answers with the finished payload', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ jobId: 'j1', statusUrl: '/status/j1' }))
      .mockResolvedValueOnce(json({ status: 'PROCESSING' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED', downloadUrl: '/files/j1.pdf' }));

    const outcome = await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('single');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The answer is the finished job, not the acceptance.
    expect(outcome.afterState).toMatchObject({ status: 'COMPLETED' });
  });

  it('re-pins the follow-up URL to the registered origin', async () => {
    // The host named somewhere else. It is not followed — a response body that
    // can name its own next host turns any echo into request forgery.
    fetchMock.mockResolvedValueOnce(
      json({ statusUrl: 'http://169.254.169.254/latest/meta-data/' }),
    );

    const outcome = await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a relative follow-up URL, which is the normal case', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusUrl: '/status/j1?json=true' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED' }));

    await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    const [pollUrl] = fetchMock.mock.calls[1] as [URL];
    expect(pollUrl.toString()).toBe('https://reports.internal.test/status/j1?json=true');
  });

  it('stops at maxAttempts rather than polling forever', async () => {
    fetchMock.mockImplementation(always({ statusUrl: '/status/j1', status: 'PROCESSING' }));

    const outcome = await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    // One acceptance plus five polls, and no more.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    if (outcome.result.status === 'error') {
      expect(outcome.result.message).toMatch(/still being prepared/i);
      // Still running is not a failure to retry blindly, but it is worth asking
      // again — unlike a write that may have half-applied.
      expect(outcome.result.retryable).toBe(true);
    }
  });

  it('surfaces a declared failure status as a failure, not a timeout', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusUrl: '/status/j1' }))
      .mockResolvedValueOnce(json({ status: 'ERROR', error: 'no completed assessment' }));

    const outcome = await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    if (outcome.result.status === 'error') {
      expect(outcome.result.message).toContain('no completed assessment');
    }
  });

  it('refuses when the response names nothing to poll', async () => {
    fetchMock.mockResolvedValueOnce(json({ jobId: 'j1' }));

    const outcome = await runner().run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('holds a tight interval to the service-wide floor', async () => {
    // The function above asks for 1ms. An author cannot turn a poll into a
    // hot loop against someone else's API.
    fetchMock.mockImplementation(always({ statusUrl: '/status/j1', status: 'PROCESSING' }));

    const config = loadConfiguration();
    const started = Date.now();
    await new HttpFunctionRunner(config, db, readDb()).run(
      definition({
        service: 'reports',
        method: 'GET',
        path: '/generate',
        poll: { ...POLL, maxAttempts: 2 },
      }),
      {},
      context(),
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(config.outbound.pollMinIntervalMs);
  });

  it('stops at the service-wide ceiling even when the function asks for longer', async () => {
    fetchMock.mockImplementation(always({ statusUrl: '/status/j1', status: 'PROCESSING' }));

    const base = loadConfiguration();
    const config = {
      ...base,
      outbound: { ...base.outbound, pollMinIntervalMs: 1, pollMaxMs: 30 },
    };

    const outcome = await new HttpFunctionRunner(config, db, readDb()).run(
      definition({
        service: 'reports',
        method: 'GET',
        path: '/generate',
        poll: { ...POLL, intervalMs: 10, maxAttempts: 1000 },
      }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    // Nowhere near a thousand: the ceiling ended it, not the attempt count.
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });
});

describe('artifacts handed back to the user', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const withResult: HttpRequestSpec = {
    service: 'reports',
    method: 'GET',
    path: '/generate',
    poll: POLL,
    result: {
      link: { from: 'downloadUrl', label: 'Download report' },
      expose: [{ from: 'password', label: 'Password' }],
    },
  };

  it('rebuilds the link against the public base URL, not the internal one', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusUrl: '/status/j1' }))
      .mockResolvedValueOnce(
        json({ status: 'COMPLETED', downloadUrl: '/download/j1?d=true', password: 'hunter2' }),
      );

    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      definition(withResult),
      {},
      context(),
    );

    expect(outcome.artifacts).toEqual([
      { label: 'Download report', url: 'https://portal.example.com/download/j1?d=true' },
      { label: 'Password', value: 'hunter2' },
    ]);
  });

  it('discards a link that points off the service rather than handing it over', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusUrl: '/status/j1' }))
      .mockResolvedValueOnce(
        json({ status: 'COMPLETED', downloadUrl: 'https://evil.test/steal' }),
      );

    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      definition(withResult),
      {},
      context(),
    );

    expect(outcome.artifacts).toBeUndefined();
  });

  it('exposes nothing unless the function declared it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ statusUrl: '/status/j1' }))
      .mockResolvedValueOnce(json({ status: 'COMPLETED', password: 'hunter2' }));

    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      definition({ service: 'reports', method: 'GET', path: '/generate', poll: POLL }),
      {},
      context(),
    );

    expect(outcome.artifacts).toBeUndefined();
  });
});

describe('scope binding on an action', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const selfService = definition(
    { service: 'reports', method: 'GET', path: '/generate/{{scope:user_id}}' },
    [{ key: 'user_id', column: 'r.user_id' }],
  );

  it('puts the caller\'s own scope value in the path', async () => {
    await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      selfService,
      {},
      context({ scopes: { user_id: 1219 } }),
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('https://reports.internal.test/generate/1219');
  });

  it('refuses rather than calling out when the scope value is missing', async () => {
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      selfService,
      {},
      context({ scopes: {} }),
    );

    expect(outcome.result.status).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an exempt role, because "every user" is not an id', async () => {
    // Exemption is a sensible thing to say about a filter and a meaningless one
    // about an identifier an action must act on. Compiling it away would send
    // an empty path segment and address the wrong resource.
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      selfService,
      {},
      context({ scopes: {}, unscopedKeys: ['user_id'], role: 'ADMIN' }),
    );

    expect(outcome.result.status).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the precondition guard', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const guarded = definition(
    {
      service: 'reports',
      method: 'GET',
      path: '/generate/{{param:registration_id}}',
      precondition: {
        sqlTemplate:
          'SELECT 1 FROM registrations r WHERE r.id = {{param:registration_id}} AND {{scope:corporate_account_id}}',
        denyMessage: 'That candidate is not in your account.',
      },
    },
    [{ key: 'corporate_account_id', column: 'r.corporate_account_id' }],
  );

  it('calls out when the guard returns a row', async () => {
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb([{ ok: 1 }])).run(
      guarded,
      { registration_id: 1184 },
      context({ scopes: { corporate_account_id: 16 }, role: 'CORPORATE' }),
    );

    expect(outcome.result.status).toBe('single');
    expect(outcome.scopesApplied).toEqual({ corporate_account_id: 16 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses, without calling out, when the guard returns nothing', async () => {
    // The candidate exists; it is simply not this tenant's. The action must not
    // happen — checking after the fact cannot un-generate a report.
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb([])).run(
      guarded,
      { registration_id: 1184 },
      context({ scopes: { corporate_account_id: 99 }, role: 'CORPORATE' }),
    );

    expect(outcome.result.status).toBe('denied');
    if (outcome.result.status === 'denied') {
      expect(outcome.result.reason).toBe('That candidate is not in your account.');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when the caller supplies no scope value and is not exempt', async () => {
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb()).run(
      guarded,
      { registration_id: 1184 },
      context({ scopes: {}, role: 'CORPORATE' }),
    );

    expect(outcome.result.status).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an exempt role through, with the filter compiled to TRUE', async () => {
    const outcome = await new HttpFunctionRunner(fastConfig(), db, readDb([{ ok: 1 }])).run(
      guarded,
      { registration_id: 1184 },
      context({ scopes: {}, unscopedKeys: ['corporate_account_id'], role: 'ADMIN' }),
    );

    expect(outcome.result.status).toBe('single');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not act when the guard itself fails to run', async () => {
    // A guard that could not run has not passed.
    const outcome = await new HttpFunctionRunner(
      loadConfiguration(),
      db,
      readDb([], true),
    ).run(
      guarded,
      { registration_id: 1184 },
      context({ scopes: { corporate_account_id: 16 }, role: 'CORPORATE' }),
    );

    expect(outcome.result.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
