import { Injectable, Logger } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { cosineSimilarity, EmbeddingService } from './embedding.service';

export interface Passage {
  documentId: number;
  title: string;
  heading: string | null;
  content: string;
  /** Fused rank score. Comparable within one result set, not across sets. */
  score: number;
}

interface ChunkRow {
  document_id: string;
  title: string;
  heading: string | null;
  content: string;
  lexical_rank: number | null;
  embedding: number[] | null;
}

/** How far down each ranked list still counts. Standard RRF constant. */
const RRF_K = 60;
const LEXICAL_POOL = 40;
const VECTOR_POOL = 40;

/**
 * Finding the passages that bear on a question.
 *
 * Hybrid, because the two halves fail on opposite inputs. Lexical search is
 * exact and cheap and cannot match "how much does it cost" against a passage
 * that only ever says "pricing"; vector search handles that and will
 * confidently return something adjacent when the user typed a product code that
 * appears verbatim in one chunk and nowhere else. Running both and fusing the
 * ranks means a passage has two ways to be found and only needs one.
 *
 * Fusion is Reciprocal Rank Fusion: each list contributes 1/(k + rank). It uses
 * only the ordering, never the scores, which matters because `ts_rank_cd` and
 * cosine similarity are not on comparable scales and any attempt to normalise
 * them into one number is a tuning exercise that has to be redone every time
 * the embedding model changes.
 *
 * Every query is filtered by the caller's role in SQL, not after ranking. A
 * document the caller may not see must not be able to influence what they get
 * back, and must not consume one of the few slots a prompt has room for.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);
  private pgvector: boolean | null = null;

  constructor(
    private readonly db: PrimaryDb,
    private readonly embeddings: EmbeddingService,
  ) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /**
   * The passages worth putting in a prompt, best first.
   *
   * Returns an empty array for any failure. Knowledge is an enrichment: an
   * answer without it is the answer this service gave before there was a
   * knowledge base, and taking a run down because a search failed would trade a
   * working feature for a new one.
   */
  async search(
    applicationId: number,
    role: string,
    query: string,
    limit = 5,
  ): Promise<Passage[]> {
    const text = query.trim();
    if (text.length < 2) return [];

    try {
      const [lexical, vector] = await Promise.all([
        this.lexical(applicationId, role, text),
        this.vector(applicationId, role, text),
      ]);

      return fuse(lexical, vector, limit);
    } catch (error) {
      this.logger.warn(
        `Knowledge search failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Postgres full-text search over the generated tsvector.
   *
   * `websearch_to_tsquery` parses the input, so quoted phrases and `-excluded`
   * behave the way anybody who has used a search box expects, and punctuation
   * never raises — which `to_tsquery` does, and the input here is whatever the
   * user typed.
   *
   * The `&` → `|` rewrite is the important part. `websearch_to_tsquery` joins
   * every term with AND, which is right for a search box and wrong for a
   * question: "what does an Agile Naturalist band mean" produced
   * `agil & naturalist & band & mean` and matched nothing, because the passage
   * defining Agile Naturalist happens not to contain the word "mean". Requiring
   * every word of a sentence to appear makes the lexical half almost useless on
   * exactly the input this service receives.
   *
   * Rewriting to OR restores recall without costing precision: `ts_rank_cd`
   * scores by how many distinct terms matched and how close together they are,
   * so a passage matching four terms still outranks one matching a stray "the",
   * and RRF only ever uses the ordering anyway.
   *
   * Doing it on the *parsed* tsquery rather than on the raw string is what makes
   * it safe. By that point Postgres has already reduced the input to normalised
   * lexemes and operators, so the text form holds nothing that could change the
   * query's structure — and the user's text is still passed as a bound
   * parameter, never interpolated. Phrase operators from a quoted phrase survive
   * as `<->` and keep working.
   */
  private async lexical(
    applicationId: number,
    role: string,
    query: string,
  ): Promise<ChunkRow[]> {
    return this.db.query<ChunkRow>(
      `SELECT c.document_id, d.title, c.heading, c.content,
              ts_rank_cd(c.search_tsv, q.query) AS lexical_rank,
              NULL::real[] AS embedding
         FROM ${this.schema}.agent_document_chunks c
         JOIN ${this.schema}.agent_documents d ON d.id = c.document_id
        CROSS JOIN (
          SELECT replace(websearch_to_tsquery('english', $3)::text, '&', '|')::tsquery
        ) AS q(query)
        WHERE c.application_id = $1
          AND d.status = 'ready'
          AND ('*' = ANY(c.allowed_roles) OR $2 = ANY(c.allowed_roles))
          AND c.search_tsv @@ q.query
        ORDER BY lexical_rank DESC
        LIMIT $4`,
      [applicationId, role, query, LEXICAL_POOL],
    );
  }

  private async vector(
    applicationId: number,
    role: string,
    query: string,
  ): Promise<ChunkRow[]> {
    // 'query', not 'passage'. The whole point of an asymmetric embedder is that
    // these two land in different parts of the space.
    const batch = await this.embeddings.embed([query], applicationId, 'query');
    const embedding = batch?.vectors[0];
    if (!embedding || embedding.length === 0) return [];

    if (await this.hasPgvector()) {
      // The database does the distance computation and only the winners cross
      // the wire. `<=>` is cosine distance, so ascending is most-similar-first.
      return this.db.query<ChunkRow>(
        `SELECT c.document_id, d.title, c.heading, c.content,
                NULL::real AS lexical_rank,
                NULL::real[] AS embedding
           FROM ${this.schema}.agent_document_chunks c
           JOIN ${this.schema}.agent_documents d ON d.id = c.document_id
          WHERE c.application_id = $1
            AND d.status = 'ready'
            AND c.embedding_vec IS NOT NULL
            AND ('*' = ANY(c.allowed_roles) OR $2 = ANY(c.allowed_roles))
          ORDER BY c.embedding_vec <=> $3::text::vector
          LIMIT $4`,
        [applicationId, role, JSON.stringify(embedding), VECTOR_POOL],
      );
    }

    // No pgvector: rank in process. Reads every embedded chunk this caller may
    // see, which is why the role filter is in the query and not applied after.
    const rows = await this.db.query<ChunkRow>(
      `SELECT c.document_id, d.title, c.heading, c.content,
              NULL::real AS lexical_rank, c.embedding
         FROM ${this.schema}.agent_document_chunks c
         JOIN ${this.schema}.agent_documents d ON d.id = c.document_id
        WHERE c.application_id = $1
          AND d.status = 'ready'
          AND c.embedding IS NOT NULL
          AND ('*' = ANY(c.allowed_roles) OR $2 = ANY(c.allowed_roles))`,
      [applicationId, role],
    );

    return rows
      .map((row) => ({
        row,
        similarity: cosineSimilarity(embedding, row.embedding ?? []),
      }))
      .filter((entry) => entry.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, VECTOR_POOL)
      .map((entry) => entry.row);
  }

  private async hasPgvector(): Promise<boolean> {
    if (this.pgvector !== null) return this.pgvector;

    const rows = await this.db
      .query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name = 'agent_document_chunks'
              AND column_name = 'embedding_vec'
         ) AS present`,
        [this.db.schema],
      )
      .catch(() => []);

    this.pgvector = rows[0]?.present === true;
    return this.pgvector;
  }
}

/**
 * Reciprocal Rank Fusion over the two ranked lists.
 *
 * Exported for testing: this is the part where a subtle mistake produces
 * plausible-looking but consistently worse results, which is exactly the kind
 * of bug nobody notices from the outside.
 */
export function fuse(
  lexical: Array<{ document_id: string; title: string; heading: string | null; content: string }>,
  vector: Array<{ document_id: string; title: string; heading: string | null; content: string }>,
  limit: number,
): Passage[] {
  const scores = new Map<string, { passage: Passage; score: number }>();

  const contribute = (
    list: Array<{ document_id: string; title: string; heading: string | null; content: string }>,
  ): void => {
    list.forEach((row, index) => {
      // Content is the key, not the chunk id: the same passage arriving from
      // both lists must combine into one result rather than compete with itself.
      const key = row.content;
      const contribution = 1 / (RRF_K + index + 1);
      const existing = scores.get(key);

      if (existing) {
        existing.score += contribution;
        return;
      }

      scores.set(key, {
        score: contribution,
        passage: {
          documentId: Number(row.document_id),
          title: row.title,
          heading: row.heading,
          content: row.content,
          score: 0,
        },
      });
    });
  };

  contribute(lexical);
  contribute(vector);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.passage, score: entry.score }));
}
