import { Injectable, Logger } from '@nestjs/common';
import { ModelRegistryService } from '../llm/model-registry.service';
import { resolvePrefixes } from '../llm/embedding-prefixes';
import { LlmError } from '../llm/llm.types';

/**
 * Which side of the pair is being embedded.
 *
 * Not a detail the caller can be allowed to omit. Retrieval embedders are
 * trained on asymmetric pairs, so embedding a question as though it were a
 * passage puts it in the wrong part of the space — and nothing downstream can
 * detect that, because the vectors are all perfectly valid.
 */
export type EmbeddingMode = 'query' | 'passage';

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

export interface EmbeddingBatch {
  vectors: number[][];
  model: string;
  dimensions: number;
}

/**
 * Text to vectors, when an embedding endpoint is configured.
 *
 * Deliberately optional. The provider running the chat models frequently cannot
 * embed at all — Groq hosts no embedding model — so requiring one would mean a
 * knowledge base that does not work on a perfectly reasonable setup. When no
 * `embedding` model is configured, `isConfigured()` is false, no vectors are
 * stored, and retrieval uses its lexical half alone. That is a weaker search,
 * not a broken one, and the console says which mode is in force.
 *
 * The wire format is OpenAI's `/embeddings`, which is what every hosted
 * provider and every local server worth pointing at speaks.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  constructor(private readonly models: ModelRegistryService) {}

  /**
   * Whether embeddings are available for this application.
   *
   * Checked per call rather than cached, because an operator adding an
   * embedding model should not have to restart the service to use it. The model
   * registry has its own short cache underneath.
   */
  async isConfigured(applicationId: number): Promise<boolean> {
    const candidates = await this.models.candidatesFor('embedding', applicationId);
    return candidates.length > 0;
  }

  /**
   * Describes the active embedding model, or null. For the console.
   *
   * Reports the prefixes it will actually use, resolved rather than as stored,
   * so an operator can see that a default was applied instead of having to know
   * this table exists.
   */
  async describe(applicationId: number): Promise<{
    name: string;
    modelId: string;
    queryPrefix: string;
    passagePrefix: string;
  } | null> {
    const [model] = await this.models.candidatesFor('embedding', applicationId);
    if (!model) return null;

    const prefixes = resolvePrefixes(
      model.modelId,
      model.embeddingQueryPrefix,
      model.embeddingPassagePrefix,
    );

    return {
      name: model.name,
      modelId: model.modelId,
      queryPrefix: prefixes.query,
      passagePrefix: prefixes.passage,
    };
  }

  /**
   * Embed a batch, falling over to the next configured model on failure.
   *
   * Returns null when nothing is configured — the caller stores no vectors and
   * carries on. An error, by contrast, is thrown: a configured endpoint that is
   * failing is a problem an operator needs to see against the document, not one
   * to paper over by silently producing a lexical-only index they did not ask
   * for.
   */
  async embed(
    texts: string[],
    applicationId: number,
    mode: EmbeddingMode,
  ): Promise<EmbeddingBatch | null> {
    if (texts.length === 0) return { vectors: [], model: '', dimensions: 0 };

    const candidates = await this.models.candidatesFor('embedding', applicationId);
    if (candidates.length === 0) return null;

    let lastError: unknown = null;

    for (const model of candidates) {
      try {
        // Resolved per model, because failover can land on a different family
        // with different prefixes — and the wrong family's prefix is worse than
        // none at all.
        const prefixes = resolvePrefixes(
          model.modelId,
          model.embeddingQueryPrefix,
          model.embeddingPassagePrefix,
        );
        const prefix = mode === 'query' ? prefixes.query : prefixes.passage;

        const vectors = await this.callEndpoint(
          `${model.baseUrl.replace(/\/+$/, '')}/embeddings`,
          model.modelId,
          model.apiKey,
          prefix ? texts.map((text) => `${prefix}${text}`) : texts,
          model.timeoutMs,
          model.extraHeaders,
        );

        await this.models.recordOutcome(model.id, null);

        return {
          vectors,
          model: model.modelId,
          dimensions: vectors[0]?.length ?? 0,
        };
      } catch (error) {
        lastError = error;
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Embedding model "${model.name}" failed — ${detail}`);
        await this.models.recordOutcome(model.id, detail);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Every configured embedding model failed.');
  }

  private async callEndpoint(
    url: string,
    modelId: string,
    apiKey: string,
    input: string[],
    timeoutMs: number,
    extraHeaders: Record<string, string>,
  ): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          // Operator headers first; the built-ins below win. Same rule as the
          // chat provider, for the same reason.
          ...extraHeaders,
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: modelId, input }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new LlmError(
          `Embedding endpoint returned ${response.status}: ${body.slice(0, 300)}`,
          modelId,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }

      const payload = (await response.json()) as EmbeddingResponse;
      const data = payload.data ?? [];

      if (data.length !== input.length) {
        throw new Error(
          `Embedding endpoint returned ${data.length} vectors for ${input.length} inputs.`,
        );
      }

      // The spec allows results out of order, and `index` is how they say so.
      // Silently mismatching a vector to the wrong chunk would produce a search
      // index that is wrong in a way nothing downstream can detect.
      const ordered = [...data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );

      return ordered.map((entry, position) => {
        const vector = entry.embedding;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error(`Embedding ${position} came back empty.`);
        }
        return vector;
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Embedding request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Cosine similarity, for the deployments with no pgvector.
 *
 * Exported and pure so the ranking can be tested without a database. Returns 0
 * for a length mismatch rather than throwing: chunks embedded by a model the
 * operator has since replaced are stale, not corrupt, and the right response is
 * to rank them last and let a re-index fix them.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
