import { chunkDocument } from '../../src/knowledge/chunker';
import { cosineSimilarity } from '../../src/knowledge/embedding.service';
import { fuse, type Passage } from '../../src/knowledge/retrieval.service';
import {
  formatGrounding,
  formatReference,
  formatSources,
} from '../../src/knowledge/knowledge-prompt';
import { RetrievalService } from '../../src/knowledge/retrieval.service';
import { DocumentService } from '../../src/knowledge/document.service';

describe('chunkDocument', () => {
  it('splits on markdown headings and carries each one into its chunks', () => {
    const chunks = chunkDocument(
      [
        '# Billing',
        '',
        'Credits are consumed when an assessment starts.',
        '',
        '# Reports',
        '',
        'A report is generated once every level is complete.',
      ].join('\n'),
      'Handbook',
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.heading).toBe('Billing');
    expect(chunks[1]!.heading).toBe('Reports');

    // The heading and title are inside the searchable text, not beside it —
    // this is what makes a passage findable by the word that names its section.
    expect(chunks[0]!.content).toContain('Handbook — Billing');
    expect(chunks[1]!.content).toContain('every level is complete');
  });

  it('recognises underlined headings, which pasted documents use', () => {
    const chunks = chunkDocument(
      ['Refund policy', '=============', '', 'Refunds are issued within 14 days.'].join('\n'),
      'Policies',
    );

    expect(chunks[0]!.heading).toBe('Refund policy');
    expect(chunks[0]!.content).not.toContain('=====');
  });

  it('does not mistake a long shouted sentence for a heading', () => {
    const shouted =
      'THIS ENTIRE PARAGRAPH IS IN CAPITALS AND RUNS WELL PAST ANY REASONABLE ' +
      'LENGTH FOR A SECTION TITLE, SO IT IS CONTENT RATHER THAN A HEADING.';

    const chunks = chunkDocument(shouted, 'Notice');
    expect(chunks[0]!.heading).toBeNull();
    expect(chunks[0]!.content).toContain('RUNS WELL PAST');
  });

  it('keeps chunks bounded even for text with no structure at all', () => {
    // A PDF table extracted as one enormous line: no headings, no paragraphs,
    // and in the worst case no sentence stops either.
    const wall = 'data '.repeat(4000);
    const chunks = chunkDocument(wall, 'Extract');

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThan(2200);
    }
  });

  it('numbers chunks contiguously across sections', () => {
    const chunks = chunkDocument(
      ['# One', 'a'.repeat(50), '# Two', 'b'.repeat(50), '# Three', 'c'.repeat(50)].join('\n\n'),
      'Doc',
    );

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
  });

  it('produces nothing for empty input rather than one empty chunk', () => {
    expect(chunkDocument('   \n\n  ', 'Doc')).toEqual([]);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('ignores magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1);
  });

  it('returns 0 for a dimension mismatch instead of throwing', () => {
    // Chunks embedded by a model the operator has since replaced are stale, not
    // corrupt. They rank last and a re-index fixes them.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('fuse', () => {
  const row = (id: string, content: string) => ({
    document_id: id,
    title: 'Doc',
    heading: null,
    content,
  });

  it('ranks a passage found by both halves above one found by either alone', () => {
    const lexical = [row('1', 'only lexical'), row('2', 'found by both')];
    const vector = [row('3', 'only vector'), row('2', 'found by both')];

    const fused = fuse(lexical, vector, 3);
    expect(fused[0]!.content).toBe('found by both');
  });

  it('does not let one list monopolise the results', () => {
    const lexical = Array.from({ length: 10 }, (_unused, index) =>
      row(String(index), `lexical ${index}`),
    );
    const vector = [row('99', 'vector top hit')];

    const fused = fuse(lexical, vector, 3);
    // The single vector hit outranks all but the top lexical one, because rank
    // is what counts, not how many results a list happened to return.
    expect(fused.map((passage) => passage.content)).toContain('vector top hit');
  });

  it('merges the same passage arriving from both lists into one result', () => {
    const shared = row('1', 'identical passage');
    const fused = fuse([shared], [shared], 5);

    expect(fused).toHaveLength(1);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 30 }, (_unused, index) =>
      row(String(index), `passage ${index}`),
    );
    expect(fuse(many, [], 5)).toHaveLength(5);
  });
});

describe('RetrievalService', () => {
  function makeService(query: jest.Mock<Promise<unknown[]>, [string, unknown[]]>) {
    return new RetrievalService(
      { query, schema: 'ori' } as never,
      { embed: jest.fn(async () => null) } as never,
    );
  }

  it('filters by role inside SQL, not after ranking', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => []);
    await makeService(query).search(1, 'STUDENT', 'what are credits');

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('allowed_roles');
    expect(params).toContain('STUDENT');
  });

  it('ORs the query terms instead of requiring all of them', async () => {
    // websearch_to_tsquery ANDs everything, which is right for a search box and
    // wrong for a question. "what does an Agile Naturalist band mean" became
    // `agil & naturalist & band & mean` and matched nothing, because the passage
    // that defines Agile Naturalist does not contain the word "mean".
    //
    // The rewrite happens on the parsed tsquery, not the raw string — by then
    // Postgres has reduced it to lexemes and operators, so nothing in the user's
    // text can alter the query's structure.
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => []);
    await makeService(query).search(1, 'STUDENT', 'what does an Agile band mean');

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("replace(websearch_to_tsquery('english', $3)::text, '&', '|')");
    // The user's text is still bound, never interpolated.
    expect(params).toContain('what does an Agile band mean');
    expect(sql).not.toContain('Agile');
  });

  it('returns nothing rather than failing the run when search errors', async () => {
    // Knowledge is an enrichment. An answer without it is the answer this
    // service gave before there was a knowledge base.
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => {
      throw new Error('relation "agent_document_chunks" does not exist');
    });

    await expect(
      makeService(query).search(1, 'STUDENT', 'anything'),
    ).resolves.toEqual([]);
  });

  it('does not search on a one-character question', async () => {
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>(async () => []);
    expect(await makeService(query).search(1, 'STUDENT', 'x')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('DocumentService pgvector mirroring', () => {
  /**
   * The bracket bug, pinned.
   *
   * Postgres renders a `real[]` as `{1,2,3}` and pgvector parses `[1,2,3]`, so
   * `embedding::text::vector` raises "invalid input syntax for type vector" on
   * every row. It is invisible unless the extension is installed *and* an
   * embedding model is configured — the two together — which is why it survived
   * a first pass against a database that had pgvector but no embedder, and then
   * failed on the first real ingest.
   */
  function makeService(
    queries: string[],
    options: { failOn?: (sql: string) => boolean } = {},
  ) {
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (options.failOn?.(sql)) throw new Error('chunk write exploded');
        return { rows: [] };
      }),
    };

    const db = {
      schema: 'ori',
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        // The pgvector probe reads information_schema; say the column is there.
        return sql.includes('information_schema.columns')
          ? [{ present: true }]
          : sql.includes('INSERT INTO')
            ? [{ id: '1' }]
            : [];
      }),
      one: jest.fn(async (sql: string) =>
        sql.includes('SELECT') && sql.includes('agent_documents')
          ? null
          : null,
      ),
      transaction: jest.fn(async (handler: (c: unknown) => Promise<unknown>) =>
        handler(client),
      ),
    };

    return new DocumentService(
      db as never,
      {} as never,
      {
        isConfigured: jest.fn(async () => true),
        embed: jest.fn(async (texts: string[]) => ({
          vectors: texts.map(() => [0.1, 0.2, 0.3]),
          model: 'bge',
          dimensions: 3,
        })),
        describe: jest.fn(async () => null),
      } as never,
    );
  }

  it('builds pgvector literals with brackets, not a text cast', async () => {
    const queries: string[] = [];
    const service = makeService(queries);

    await service
      .createFromText(1, { title: 'T', content: 'Some text.', allowedRoles: ['*'] }, null)
      .catch(() => undefined);

    const mirror = queries.find((sql) => sql.includes('embedding_vec ='));
    expect(mirror).toBeDefined();
    expect(mirror).toContain('array_to_string');
    // The cast that looked right and was not.
    expect(mirror).not.toContain('embedding::text::vector');
  });

  it('marks a document failed when the index transaction throws', async () => {
    /*
     * The stuck-`pending` bug. The failure handler used to cover only chunking
     * and embedding, so a database error while writing the chunks propagated
     * with the row still on its initial `pending` — a document the console
     * shows as "indexing" forever, with no error to read and no sign it is
     * dead. One such row existed in a real database before this was fixed.
     */
    const queries: string[] = [];
    const service = makeService(queries, {
      failOn: (sql) => sql.includes('INSERT INTO') && sql.includes('agent_document_chunks'),
    });

    await expect(
      service.createFromText(1, { title: 'T', content: 'Some text.', allowedRoles: ['*'] }, null),
    ).rejects.toThrow(/chunk write exploded/);

    const marked = queries.find(
      (sql) => sql.includes("status = 'failed'") && sql.includes('agent_documents'),
    );
    expect(marked).toBeDefined();
  });
});

describe('knowledge prompts', () => {
  const passages: Passage[] = [
    {
      documentId: 1,
      title: 'Handbook',
      heading: 'Billing',
      content: 'Credits are consumed when an assessment starts.',
      score: 0.5,
    },
  ];

  it('tells the loop that documentation is not data', () => {
    // The failure this prevents: a model given documentation while choosing a
    // function answers from the documentation instead, and reports a balance
    // that came from a worked example in a PDF.
    const grounding = formatGrounding(passages);

    expect(grounding).toContain('documentation, not data');
    expect(grounding).toContain('Never report a number');
    expect(grounding).not.toMatch(/answer (the question )?from (this|it)/i);
  });

  it('tells the synthesizer that live results outrank documentation', () => {
    const reference = formatReference(passages);

    expect(reference).toContain('The facts above always win');
    expect(reference).toContain('Never take a number');
  });

  it('numbers sources so the document-only answer can cite them', () => {
    const sources = formatSources([
      ...passages,
      { ...passages[0]!, documentId: 2, heading: 'Reports' },
    ]);

    expect(sources).toContain('[1] Handbook — Billing');
    expect(sources).toContain('[2] Handbook — Reports');
  });

  it('emits nothing at all when there are no passages', () => {
    // An empty block would still spend tokens telling the model about a
    // knowledge base it was given nothing from.
    expect(formatGrounding([])).toBe('');
    expect(formatReference([])).toBe('');
  });

  it('clips an overlong passage', () => {
    const long: Passage = {
      documentId: 1,
      title: 'Handbook',
      heading: null,
      content: 'sentence. '.repeat(400),
      score: 1,
    };

    expect(formatGrounding([long]).length).toBeLessThan(1600);
  });
});
