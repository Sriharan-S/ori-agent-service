import { EmbeddingService } from '../../src/knowledge/embedding.service';

/*
 * The Cloudflare Workers AI shape, end to end.
 *
 * Written against the documented contract rather than a mock of our own
 * assumptions: the gateway base URL, `@cf/`-namespaced model ids, bearer auth,
 * an array `input`, and a `data[].embedding` response. If any of those stops
 * matching, the failure at runtime is an ingestion that dies half way through a
 * document, so it is worth asserting the request we actually put on the wire.
 */

const GATEWAY =
  'https://gateway.ai.cloudflare.com/v1/acct123/my-gateway/workers-ai/v1';

interface Captured {
  url?: string;
  headers?: Record<string, string>;
  body?: { model: string; input: string[] };
}

function makeService(
  captured: Captured,
  overrides: Record<string, unknown> = {},
  respond?: (input: string[]) => unknown,
) {
  global.fetch = jest.fn(
    async (url: string, init: { body: string; headers: Record<string, string> }) => {
      captured.url = url;
      captured.headers = init.headers;
      captured.body = JSON.parse(init.body) as Captured['body'];

      const input = captured.body!.input;
      return {
        ok: true,
        json: async () =>
          respond?.(input) ?? {
            // Cloudflare returns OpenAI's shape: a data array of objects each
            // holding an `embedding` and its `index`.
            data: input.map((_text, index) => ({
              embedding: Array.from({ length: 1024 }, () => 0.01),
              index,
            })),
          },
      };
    },
  ) as never;

  return new EmbeddingService({
    candidatesFor: jest.fn(async () => [
      {
        id: 1,
        name: 'Cloudflare · bge-large',
        baseUrl: GATEWAY,
        modelId: '@cf/baai/bge-large-en-v1.5',
        apiKey: 'cf-token',
        timeoutMs: 30_000,
        embeddingQueryPrefix: null,
        embeddingPassagePrefix: null,
        extraHeaders: {},
        ...overrides,
      },
    ]),
    recordOutcome: jest.fn(async () => undefined),
  } as never);
}

describe('Cloudflare Workers AI embeddings', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to {base}/embeddings with the namespaced model id', async () => {
    const captured: Captured = {};
    const service = makeService(captured);

    await service.embed(['what are credits'], 1, 'query');

    expect(captured.url).toBe(`${GATEWAY}/embeddings`);
    expect(captured.body?.model).toBe('@cf/baai/bge-large-en-v1.5');
    expect(captured.headers?.authorization).toBe('Bearer cf-token');
    expect(captured.headers?.['content-type']).toBe('application/json');
  });

  it('applies the BGE query instruction to a @cf/-namespaced id', async () => {
    // The prefix table has to see through the provider namespace, or the one
    // model Cloudflare actually offers for embeddings gets no prefix at all.
    const captured: Captured = {};
    const service = makeService(captured);

    await service.embed(['what are credits'], 1, 'query');

    expect(captured.body?.input[0]).toBe(
      'Represent this sentence for searching relevant passages: what are credits',
    );
  });

  it('batches passages as an array in one request', async () => {
    const captured: Captured = {};
    const service = makeService(captured);

    const batch = await service.embed(['one', 'two', 'three'], 1, 'passage');

    expect(Array.isArray(captured.body?.input)).toBe(true);
    expect(captured.body?.input).toEqual(['one', 'two', 'three']);
    expect(batch?.vectors).toHaveLength(3);
    expect(batch?.dimensions).toBe(1024);
  });

  it('sends cf-aig-authorization alongside the provider token', async () => {
    // What an authenticated AI Gateway needs. The two are not alternatives:
    // the gateway checks one and forwards the other.
    const captured: Captured = {};
    const service = makeService(captured, {
      extraHeaders: { 'cf-aig-authorization': 'Bearer gw-token' },
    });

    await service.embed(['q'], 1, 'query');

    expect(captured.headers?.['cf-aig-authorization']).toBe('Bearer gw-token');
    expect(captured.headers?.authorization).toBe('Bearer cf-token');
  });

  it('refuses a response with fewer vectors than inputs', async () => {
    // Silently pairing vectors to the wrong chunks would build an index that is
    // wrong in a way no later check could detect.
    const captured: Captured = {};
    const service = makeService(captured, {}, () => ({
      data: [{ embedding: [0.1], index: 0 }],
    }));

    await expect(service.embed(['a', 'b'], 1, 'passage')).rejects.toThrow(
      /returned 1 vectors for 2 inputs/,
    );
  });

  it('reorders by index when the provider returns them out of order', async () => {
    const captured: Captured = {};
    const service = makeService(captured, {}, () => ({
      data: [
        { embedding: [2], index: 1 },
        { embedding: [0], index: 0 },
      ],
    }));

    const batch = await service.embed(['first', 'second'], 1, 'passage');

    expect(batch?.vectors).toEqual([[0], [2]]);
  });
});
