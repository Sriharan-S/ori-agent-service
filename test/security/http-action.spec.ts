import { HttpFunctionRunner } from '../../src/registry/http-function.runner';
import type { PrimaryDb } from '../../src/db/primary.db';
import type { ReadDb } from '../../src/db/read.db';
import type { RequestContext } from '../../src/auth/identity';
import type {
  FunctionDefinition,
  HttpRequestSpec,
} from '../../src/registry/function.contract';
import { loadConfiguration } from '../../src/config/configuration';

const services = [
  {
    name: 'core',
    base_url: 'https://api.internal.test/v1/',
    public_base_url: null,
  },
];

const db = {
  schema: 'ori',
  query: () => Promise.resolve(services),
} as unknown as PrimaryDb;

/** Only reached by functions that declare a precondition. */
const readDb = {
  query: () => Promise.resolve({ rows: [{ ok: 1 }], fields: ['ok'] }),
} as unknown as ReadDb;

function context(): RequestContext {
  return {
    application: {
      id: 1,
      slug: 'test',
      name: 'Test',
      endUserAuth: 'asserted',
      jwtIssuer: null,
      jwtJwksUrl: null,
      jwtAudience: null,
      jwtSubjectClaim: 'sub',
      jwtRoleClaim: null,
      jwtScopeClaims: {},
      isActive: true,
    },
    apiKey: {
      id: 1,
      applicationId: 1,
      name: 'test',
      prefix: 'ori_test',
      scopes: ['chat'],
    },
    endUser: { id: 'u1', role: 'admin', scopes: {}, token: 'user-token' },
    role: {
      id: 1,
      applicationId: 1,
      name: 'admin',
      description: null,
      allowedFunctions: ['*'],
      writeScopes: ['*'],
      unscopedKeys: [],
    },
    runId: 'run-1',
    requestId: 'req-1',
    traceEnabled: false,
  };
}

function definition(httpRequest: HttpRequestSpec): FunctionDefinition {
  return {
    id: 1,
    applicationId: 1,
    name: 'do_thing',
    category: 'general',
    kind: 'write',
    description: 'test',
    whenToUse: [],
    whenNotToUse: [],
    parameters: {},
    requiredOneOf: [],
    returns: 'confirmation',
    ambiguityResolvesTo: null,
    allowedRoles: ['*'],
    scopeFilters: [],
    sqlTemplate: null,
    httpRequest,
    writeScope: 'thing.update',
    requiresConfirmation: false,
    defaultLimit: null,
    maxLimit: null,
    status: 'live',
    version: 1,
    lastValidatedAt: null,
    validationError: null,
  };
}

describe('HTTP action targeting', () => {
  const runner = new HttpFunctionRunner(loadConfiguration(), db, readDb);
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('resolves a path against the registered service base URL', async () => {
    await runner.run(
      definition({
        service: 'core',
        method: 'PATCH',
        path: '/records/{{param:recordId}}',
      }),
      { recordId: 42 },
      context(),
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe('https://api.internal.test/v1/records/42');
  });

  it('refuses a service that is not registered', async () => {
    // Without this, anyone who can author a function can make the service issue
    // requests to an address of their choosing.
    const outcome = await runner.run(
      definition({ service: 'unregistered', method: 'POST', path: '/x' }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot be escaped by a traversal in a path parameter', async () => {
    await runner.run(
      definition({
        service: 'core',
        method: 'GET',
        path: '/records/{{param:recordId}}',
      }),
      { recordId: '../../../latest/meta-data/' },
      context(),
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.origin).toBe('https://api.internal.test');
    expect(url.pathname).toContain('%2F');
    expect(url.pathname).not.toContain('meta-data/');
  });

  it('cannot be escaped by a query string in a path parameter', async () => {
    await runner.run(
      definition({
        service: 'core',
        method: 'GET',
        path: '/records/{{param:recordId}}',
      }),
      { recordId: '1?admin=true' },
      context(),
    );

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.search).toBe('');
  });

  it('forwards the end user token when the action asks for it', async () => {
    await runner.run(
      definition({
        service: 'core',
        method: 'POST',
        path: '/records',
        forwardEndUserToken: true,
      }),
      {},
      context(),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer user-token',
    );
  });

  it('ignores an Authorization header set in the stored function body', async () => {
    // A saved header must not be able to smuggle a credential of its own.
    await runner.run(
      definition({
        service: 'core',
        method: 'POST',
        path: '/records',
        headers: { Authorization: 'Bearer smuggled-service-token' },
      }),
      {},
      context(),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('does not follow redirects', async () => {
    // A redirect is another way to reach an origin that was never registered.
    await runner.run(
      definition({ service: 'core', method: 'POST', path: '/records' }),
      {},
      context(),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.redirect).toBe('error');
  });

  it('substitutes body parameters while keeping their type', async () => {
    await runner.run(
      definition({
        service: 'core',
        method: 'PATCH',
        path: '/records/1',
        body: { name: '{{param:name}}', count: '{{param:count}}' },
      }),
      { name: 'Priya', count: 7 },
      context(),
    );

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Priya',
      count: 7,
    });
  });

  it('reports a permission failure from the target as denied, not as an error', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));

    const outcome = await runner.run(
      definition({ service: 'core', method: 'POST', path: '/records' }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('denied');
  });

  it('never marks a failed write retryable', async () => {
    // Without an idempotency guarantee from the target, an automatic retry can
    // duplicate the change.
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));

    const outcome = await runner.run(
      definition({ service: 'core', method: 'POST', path: '/records' }),
      {},
      context(),
    );

    expect(outcome.result.status).toBe('error');
    if (outcome.result.status === 'error') {
      expect(outcome.result.retryable).toBe(false);
    }
  });
});
