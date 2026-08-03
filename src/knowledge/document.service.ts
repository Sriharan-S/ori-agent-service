import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { chunkDocument, type Chunk } from './chunker';
import { EmbeddingService } from './embedding.service';
import { ExtractorService, UnsupportedDocumentError } from './extractor.service';

export type DocumentStatus = 'pending' | 'ready' | 'failed';

export interface DocumentSummary {
  id: number;
  title: string;
  sourceType: 'file' | 'text';
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  allowedRoles: string[];
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  embeddedCount: number;
  characters: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
}

export interface KnowledgeStatus {
  documents: number;
  chunks: number;
  embeddedChunks: number;
  /** Null when no embedding model is configured — lexical search only. */
  embeddingModel: { name: string; modelId: string } | null;
  pgvector: boolean;
}

interface DocumentRow {
  id: string;
  title: string;
  source_type: string;
  filename: string | null;
  mime_type: string | null;
  byte_size: string;
  allowed_roles: string[];
  status: string;
  error: string | null;
  chunk_count: number;
  embedded_count: number;
  characters: number;
  content?: string;
  created_at: Date;
  updated_at: Date;
}

const SUMMARY_COLUMNS = `
  id, title, source_type, filename, mime_type, byte_size, allowed_roles,
  status, error, chunk_count, embedded_count, length(content) AS characters,
  created_at, updated_at
`;

/** Embedding endpoints charge and rate-limit per request, not per token. */
const EMBED_BATCH = 64;

/**
 * The knowledge base: documents in, searchable passages out.
 *
 * Ingestion runs inside the request that uploaded the file rather than on a
 * queue. An operator uploading a document is watching the screen, and the
 * failures that matter — a scanned PDF with no text layer, an embedding
 * endpoint refusing the key — are ones they need to see now and fix now, not
 * discover later against a row that says "failed". A queue would be the right
 * answer for bulk ingestion; nothing here is bulk.
 *
 * Nothing in this file knows what any document is *about*. Retrieval is by role
 * and by text, and the roles are the application's own.
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);
  private pgvector: boolean | null = null;

  constructor(
    private readonly db: PrimaryDb,
    private readonly extractor: ExtractorService,
    private readonly embeddings: EmbeddingService,
  ) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async list(applicationId: number): Promise<DocumentSummary[]> {
    const rows = await this.db.query<DocumentRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM ${this.schema}.agent_documents
        WHERE application_id = $1
        ORDER BY created_at DESC`,
      [applicationId],
    );
    return rows.map(toSummary);
  }

  async get(applicationId: number, id: number): Promise<DocumentDetail | null> {
    const row = await this.db.one<DocumentRow>(
      `SELECT ${SUMMARY_COLUMNS}, content FROM ${this.schema}.agent_documents
        WHERE application_id = $1 AND id = $2`,
      [applicationId, id],
    );
    return row ? { ...toSummary(row), content: row.content ?? '' } : null;
  }

  async status(applicationId: number): Promise<KnowledgeStatus> {
    const [totals] = await this.db.query<{
      documents: string;
      chunks: string;
      embedded: string;
    }>(
      `SELECT
         (SELECT count(*) FROM ${this.schema}.agent_documents
           WHERE application_id = $1) AS documents,
         (SELECT count(*) FROM ${this.schema}.agent_document_chunks
           WHERE application_id = $1) AS chunks,
         (SELECT count(*) FROM ${this.schema}.agent_document_chunks
           WHERE application_id = $1 AND embedding IS NOT NULL) AS embedded`,
      [applicationId],
    );

    return {
      documents: Number(totals?.documents ?? 0),
      chunks: Number(totals?.chunks ?? 0),
      embeddedChunks: Number(totals?.embedded ?? 0),
      embeddingModel: await this.embeddings.describe(applicationId),
      pgvector: await this.hasPgvector(),
    };
  }

  async createFromText(
    applicationId: number,
    input: { title: string; content: string; allowedRoles: string[] },
    createdBy: number | null,
  ): Promise<DocumentDetail> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new UnsupportedDocumentError('There is no text to save.');
    }

    return this.ingest(
      applicationId,
      {
        title: input.title.trim() || 'Untitled note',
        sourceType: 'text',
        filename: null,
        mimeType: 'text/plain',
        byteSize: Buffer.byteLength(content, 'utf8'),
        allowedRoles: normaliseRoles(input.allowedRoles),
        content,
      },
      createdBy,
    );
  }

  async createFromFile(
    applicationId: number,
    input: {
      title: string;
      buffer: Buffer;
      filename: string;
      mimeType: string;
      allowedRoles: string[];
    },
    createdBy: number | null,
  ): Promise<DocumentDetail> {
    const extracted = await this.extractor.extract(
      input.buffer,
      input.filename,
      input.mimeType,
    );

    return this.ingest(
      applicationId,
      {
        title: input.title.trim() || input.filename,
        sourceType: 'file',
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.buffer.byteLength,
        allowedRoles: normaliseRoles(input.allowedRoles),
        content: extracted.text,
      },
      createdBy,
    );
  }

  /**
   * Change who may retrieve a document.
   *
   * The chunk rows carry their own copy of the role list so that retrieval is a
   * single-table query with no join, which means this has to write both. Doing
   * it in one transaction is what stops a widened document from being briefly
   * unsearchable, or a narrowed one from being briefly readable by a role that
   * has just lost access.
   */
  async setRoles(
    applicationId: number,
    id: number,
    allowedRoles: string[],
  ): Promise<DocumentSummary | null> {
    const roles = normaliseRoles(allowedRoles);

    return this.db.transaction(async (client) => {
      const updated = await client.query<DocumentRow>(
        `UPDATE ${this.schema}.agent_documents
            SET allowed_roles = $3, updated_at = now()
          WHERE application_id = $1 AND id = $2
        RETURNING ${SUMMARY_COLUMNS}`,
        [applicationId, id, roles],
      );

      if (updated.rows.length === 0) return null;

      await client.query(
        `UPDATE ${this.schema}.agent_document_chunks
            SET allowed_roles = $3
          WHERE application_id = $1 AND document_id = $2`,
        [applicationId, id, roles],
      );

      return toSummary(updated.rows[0]!);
    });
  }

  async remove(applicationId: number, id: number): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.schema}.agent_documents
        WHERE application_id = $1 AND id = $2
        RETURNING id`,
      [applicationId, id],
    );
    // Chunks go with it — the foreign key cascades.
    return rows.length > 0;
  }

  /**
   * Re-chunk and re-embed a document that is already stored.
   *
   * The extracted text is kept precisely so this does not need the original
   * file. Adding an embedding model after uploading twenty documents should not
   * mean uploading them again.
   */
  async reindex(applicationId: number, id: number): Promise<DocumentDetail | null> {
    const existing = await this.get(applicationId, id);
    if (!existing) return null;

    await this.buildIndex(applicationId, id, existing.title, existing.content, existing.allowedRoles);
    return this.get(applicationId, id);
  }

  /** Every document re-indexed. Used after the embedding model changes. */
  async reindexAll(applicationId: number): Promise<{ reindexed: number; failed: number }> {
    const documents = await this.list(applicationId);
    let reindexed = 0;
    let failed = 0;

    for (const document of documents) {
      try {
        await this.reindex(applicationId, document.id);
        reindexed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Re-index of document ${document.id} failed: ${describe(error)}`,
        );
      }
    }

    return { reindexed, failed };
  }

  private async ingest(
    applicationId: number,
    input: {
      title: string;
      sourceType: 'file' | 'text';
      filename: string | null;
      mimeType: string;
      byteSize: number;
      allowedRoles: string[];
      content: string;
    },
    createdBy: number | null,
  ): Promise<DocumentDetail> {
    const checksum = createHash('sha256').update(input.content).digest('hex');

    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM ${this.schema}.agent_documents
        WHERE application_id = $1 AND checksum = $2`,
      [applicationId, checksum],
    );

    // Same text already present. Re-uploading is how people fix a mistake, and
    // two identical documents in the index means the same passage occupies two
    // of the handful of slots a prompt has room for.
    if (existing) {
      const id = Number(existing.id);
      this.logger.log(`Document ${id} already holds this exact text — replacing it`);
      await this.db.query(
        `UPDATE ${this.schema}.agent_documents
            SET title = $3, allowed_roles = $4, updated_at = now()
          WHERE application_id = $1 AND id = $2`,
        [applicationId, id, input.title, input.allowedRoles],
      );
      await this.buildIndex(applicationId, id, input.title, input.content, input.allowedRoles);
      return (await this.get(applicationId, id))!;
    }

    const [created] = await this.db.query<{ id: string }>(
      `INSERT INTO ${this.schema}.agent_documents
         (application_id, title, source_type, filename, mime_type, byte_size,
          checksum, allowed_roles, content, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
       RETURNING id`,
      [
        applicationId,
        input.title,
        input.sourceType,
        input.filename,
        input.mimeType,
        input.byteSize,
        checksum,
        input.allowedRoles,
        input.content,
        createdBy,
      ],
    );

    const id = Number(created!.id);
    await this.buildIndex(applicationId, id, input.title, input.content, input.allowedRoles);

    return (await this.get(applicationId, id))!;
  }

  /**
   * Replace a document's chunks, embedding them if that is configured.
   *
   * The delete and the insert share a transaction so a failure part-way leaves
   * the previous index in place. A document that is briefly missing from search
   * is worse than one that is briefly out of date, and an interrupted re-index
   * should not be able to produce a half-indexed document that looks complete.
   */
  private async buildIndex(
    applicationId: number,
    documentId: number,
    title: string,
    content: string,
    allowedRoles: string[],
  ): Promise<void> {
    try {
      await this.indexOrThrow(documentId, applicationId, title, content, allowedRoles);
    } catch (error) {
      // Every failure lands here, including one thrown by the transaction
      // below. It used to cover only chunking and embedding, so a database
      // error while writing the chunks left the row on its initial `pending` —
      // a document the console shows as "indexing" forever, with no error to
      // read and no indication it is dead. Exactly one such row existed before
      // this was fixed.
      const detail = describe(error);
      this.logger.warn(`Indexing document ${documentId} failed: ${detail}`);

      await this.db
        .query(
          `UPDATE ${this.schema}.agent_documents
              SET status = 'failed', error = $2, updated_at = now()
            WHERE id = $1`,
          [documentId, detail],
        )
        // Recording the failure must not replace it with a different one.
        .catch(() => undefined);

      throw error;
    }
  }

  private async indexOrThrow(
    documentId: number,
    applicationId: number,
    title: string,
    content: string,
    allowedRoles: string[],
  ): Promise<void> {
    let vectors: number[][] | null = null;
    let model = '';

    const chunks: Chunk[] = chunkDocument(content, title);

    if (chunks.length === 0) {
      throw new UnsupportedDocumentError(
        'Nothing usable could be read out of that document.',
      );
    }

    const embedded = await this.embedAll(
      chunks.map((chunk) => chunk.content),
      applicationId,
    );

    if (embedded) {
      vectors = embedded.vectors;
      model = embedded.model;
    }

    const usePgvector = await this.hasPgvector();

    await this.db.transaction(async (client) => {
      await client.query(
        `DELETE FROM ${this.schema}.agent_document_chunks WHERE document_id = $1`,
        [documentId],
      );

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const vector = vectors?.[index] ?? null;

        await client.query(
          `INSERT INTO ${this.schema}.agent_document_chunks
             (document_id, application_id, ordinal, heading, content,
              allowed_roles, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            documentId,
            applicationId,
            chunk.ordinal,
            chunk.heading,
            chunk.content,
            allowedRoles,
            vector,
            vector ? model : null,
          ],
        );
      }

      // Mirrored into pgvector's own type when the extension exists, so the
      // distance computation can happen in the database. One statement over the
      // whole document rather than per row.
      //
      // Built with array_to_string rather than a cast through text: Postgres
      // renders a real[] as `{1,2,3}` and pgvector parses `[1,2,3]`, so
      // `embedding::text::vector` raises "invalid input syntax for type vector"
      // on every row. It only fails where the extension is installed *and* an
      // embedding model is configured, which is why it survived a first pass
      // against a database that had pgvector but no embedder.
      if (usePgvector && vectors) {
        await client.query(
          `UPDATE ${this.schema}.agent_document_chunks
              SET embedding_vec =
                    ('[' || array_to_string(embedding, ',') || ']')::vector
            WHERE document_id = $1 AND embedding IS NOT NULL`,
          [documentId],
        );
      }

      await client.query(
        `UPDATE ${this.schema}.agent_documents
            SET status = 'ready', error = NULL, chunk_count = $2,
                embedded_count = $3, updated_at = now()
          WHERE id = $1`,
        [documentId, chunks.length, vectors ? chunks.length : 0],
      );
    });

    this.logger.log(
      `Indexed document ${documentId}: ${chunks.length} chunk(s)` +
        (vectors ? ` embedded with ${model}` : ' (lexical only)'),
    );
  }

  private async embedAll(
    texts: string[],
    applicationId: number,
  ): Promise<{ vectors: number[][]; model: string } | null> {
    if (!(await this.embeddings.isConfigured(applicationId))) return null;

    const vectors: number[][] = [];
    let model = '';

    for (let index = 0; index < texts.length; index += EMBED_BATCH) {
      const batch = await this.embeddings.embed(
        texts.slice(index, index + EMBED_BATCH),
        applicationId,
        'passage',
      );
      if (!batch) return null;

      vectors.push(...batch.vectors);
      model = batch.model;
    }

    return { vectors, model };
  }

  /**
   * Whether this database has pgvector, asked once.
   *
   * An extension cannot appear and disappear during a process's lifetime in any
   * way worth handling, and this is on the path of every ingest and every
   * search.
   */
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

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: Number(row.id),
    title: row.title,
    sourceType: row.source_type === 'file' ? 'file' : 'text',
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    allowedRoles: row.allowed_roles ?? ['*'],
    status: row.status as DocumentStatus,
    error: row.error,
    chunkCount: row.chunk_count,
    embeddedCount: row.embedded_count,
    characters: Number(row.characters ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * An empty role list would mean "no role may read this", which nobody uploads a
 * document intending. It is read as "everyone", the same as `*`.
 */
function normaliseRoles(roles: string[] | null | undefined): string[] {
  const cleaned = (roles ?? [])
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  if (cleaned.length === 0 || cleaned.includes('*')) return ['*'];
  return [...new Set(cleaned)];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
