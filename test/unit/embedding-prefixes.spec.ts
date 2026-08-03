import {
  defaultPrefixesFor,
  resolvePrefixes,
  NO_PREFIXES,
} from '../../src/llm/embedding-prefixes';
import { EmbeddingService } from '../../src/knowledge/embedding.service';
import { ModelRegistryService } from '../../src/llm/model-registry.service';

/*
 * Why this file exists.
 *
 * Getting a prefix wrong produces no error and no warning. The vectors are
 * valid, the search runs, results come back — they are just quieter than the
 * model can manage, and nothing downstream can tell. That makes it exactly the
 * kind of thing that has to be pinned by tests rather than noticed in use.
 */

describe('defaultPrefixesFor', () => {
  it('gives BGE English models the query instruction and a bare passage', () => {
    // The asymmetry is the design, not an oversight: BAAI trained the query
    // side with an instruction and the passage side without one.
    const prefixes = defaultPrefixesFor('bge-large-en-v1.5');
    expect(prefixes.query).toBe(
      'Represent this sentence for searching relevant passages: ',
    );
    expect(prefixes.passage).toBe('');
  });

  it('matches a provider-namespaced model id', () => {
    // Cloudflare Workers AI serves it as @cf/baai/bge-large-en-v1.5, and the
    // prefix has to survive that naming.
    expect(defaultPrefixesFor('@cf/baai/bge-large-en-v1.5')).toEqual(
      defaultPrefixesFor('bge-large-en-v1.5'),
    );
  });

  it('is case-insensitive', () => {
    expect(defaultPrefixesFor('@CF/BAAI/BGE-Large-EN-v1.5').query).toContain(
      'Represent this sentence',
    );
  });

  it('does not give BGE-M3 the v1.5 instruction', () => {
    // A later generation that dropped the prefix. Applying the old one here
    // would be actively wrong rather than merely absent.
    expect(defaultPrefixesFor('@cf/baai/bge-m3')).toEqual(NO_PREFIXES);
  });

  it('prefixes both sides for E5', () => {
    expect(defaultPrefixesFor('multilingual-e5-large')).toEqual({
      query: 'query: ',
      passage: 'passage: ',
    });
  });

  it('uses distinct verbs for nomic', () => {
    expect(defaultPrefixesFor('nomic-embed-text-v1.5')).toEqual({
      query: 'search_query: ',
      passage: 'search_document: ',
    });
  });

  it('uses the structured task prompt for EmbeddingGemma', () => {
    const prefixes = defaultPrefixesFor('embeddinggemma-300m');
    expect(prefixes.query).toContain('task: search result');
    expect(prefixes.passage).toContain('title: none');
  });

  it('returns none for a model it does not recognise', () => {
    // Safer than guessing: a missing prefix costs a little accuracy, a wrong
    // one actively misleads the model.
    expect(defaultPrefixesFor('some-model-nobody-has-heard-of')).toEqual(
      NO_PREFIXES,
    );
    expect(defaultPrefixesFor('')).toEqual(NO_PREFIXES);
  });

  it('returns none for symmetric models', () => {
    expect(defaultPrefixesFor('text-embedding-3-small')).toEqual(NO_PREFIXES);
    expect(defaultPrefixesFor('gte-large')).toEqual(NO_PREFIXES);
  });
});

describe('resolvePrefixes', () => {
  it('falls back to the family default when nothing is stored', () => {
    expect(resolvePrefixes('bge-large-en-v1.5', null, null).query).toContain(
      'Represent this sentence',
    );
  });

  it('treats an empty string as "deliberately none", not as unset', () => {
    // The distinction matters: a provider that already applies the prefix
    // server-side would otherwise receive it twice.
    expect(resolvePrefixes('bge-large-en-v1.5', '', '')).toEqual({
      query: '',
      passage: '',
    });
  });

  it('lets an override win over the default', () => {
    expect(resolvePrefixes('bge-large-en-v1.5', 'custom: ', null)).toEqual({
      query: 'custom: ',
      passage: '',
    });
  });

  it('resolves each side independently', () => {
    expect(resolvePrefixes('multilingual-e5-large', '', null)).toEqual({
      query: '',
      passage: 'passage: ',
    });
  });
});

describe('EmbeddingService prefixing', () => {
  function makeService(model: Record<string, unknown>) {
    const candidatesFor = jest.fn(async () => [
      {
        id: 1,
        name: 'test',
        baseUrl: 'https://gateway.test/v1',
        modelId: 'bge-large-en-v1.5',
        apiKey: 'secret',
        timeoutMs: 5000,
        embeddingQueryPrefix: null,
        embeddingPassagePrefix: null,
        extraHeaders: {},
        ...model,
      },
    ]);

    return {
      service: new EmbeddingService({
        candidatesFor,
        recordOutcome: jest.fn(async () => undefined),
      } as never),
    };
  }

  function stubFetch(captured: { body?: unknown; headers?: unknown }) {
    return jest.fn(async (_url: string, init: { body: string; headers: unknown }) => {
      captured.body = JSON.parse(init.body);
      captured.headers = init.headers;
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
      };
    });
  }

  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('prefixes a query but not a passage, for BGE', async () => {
    const captured: { body?: unknown } = {};
    global.fetch = stubFetch(captured) as never;

    const { service } = makeService({});

    await service.embed(['how much does it cost'], 1, 'query');
    expect((captured.body as { input: string[] }).input[0]).toBe(
      'Represent this sentence for searching relevant passages: how much does it cost',
    );

    await service.embed(['Credits are consumed at start.'], 1, 'passage');
    expect((captured.body as { input: string[] }).input[0]).toBe(
      'Credits are consumed at start.',
    );
  });

  it('applies an operator override instead of the default', async () => {
    const captured: { body?: unknown } = {};
    global.fetch = stubFetch(captured) as never;

    const { service } = makeService({ embeddingQueryPrefix: 'ask: ' });
    await service.embed(['q'], 1, 'query');

    expect((captured.body as { input: string[] }).input[0]).toBe('ask: q');
  });

  it('honours an explicit empty override', async () => {
    const captured: { body?: unknown } = {};
    global.fetch = stubFetch(captured) as never;

    const { service } = makeService({ embeddingQueryPrefix: '' });
    await service.embed(['q'], 1, 'query');

    expect((captured.body as { input: string[] }).input[0]).toBe('q');
  });

  it('sends operator headers, and never lets them replace authorization', async () => {
    const captured: { headers?: unknown } = {};
    global.fetch = stubFetch(captured) as never;

    const { service } = makeService({
      extraHeaders: {
        'cf-aig-authorization': 'Bearer gateway-token',
        authorization: 'Bearer this-should-not-win',
      },
    });

    await service.embed(['q'], 1, 'query');

    const headers = captured.headers as Record<string, string>;
    expect(headers['cf-aig-authorization']).toBe('Bearer gateway-token');
    // The model's own key wins: a typo in the headers box must not be able to
    // silently strip authentication.
    expect(headers.authorization).toBe('Bearer secret');
  });
});

describe('header validation', () => {
  // Reached through upsert, which is the only way headers get stored. Kept
  // deliberately close to the prefix tests: both are "configuration that is
  // wrong in a way the request itself will not explain".
  function makeRegistry() {
    return new ModelRegistryService(
      {
        security: { encryptionKey: Buffer.alloc(32).toString('base64') },
        llm: {
          defaultTimeoutMs: 30_000,
          defaultMaxOutputTokens: 1024,
          defaultTemperature: 0.1,
        },
      } as never,
      { one: jest.fn(async () => null), query: jest.fn(async () => []), schema: 'ori' } as never,
    );
  }

  const base = {
    applicationId: null,
    name: 'm',
    baseUrl: 'https://x/v1',
    modelId: 'm',
    purpose: 'embedding' as const,
    priority: 100,
    isEnabled: true,
    supportsStreaming: false,
  };

  it('refuses a line break in a header value', async () => {
    // Header injection in its classic form. fetch would refuse it too, but
    // failing at save time names the problem instead of producing a model that
    // throws on every request.
    await expect(
      makeRegistry().upsert({
        ...base,
        extraHeaders: { 'x-test': 'a\r\nx-injected: b' },
      }),
    ).rejects.toThrow(/must not contain a line break/);
  });

  it('refuses a header name that is not a token', async () => {
    await expect(
      makeRegistry().upsert({ ...base, extraHeaders: { 'bad name': 'v' } }),
    ).rejects.toThrow(/not a valid HTTP header name/);
  });

  it('refuses a non-string value', async () => {
    await expect(
      makeRegistry().upsert({
        ...base,
        extraHeaders: { 'x-test': 42 as unknown as string },
      }),
    ).rejects.toThrow(/must have a string value/);
  });
});
