import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CONFIG,
  decodeEncryptionKey,
  type AppConfig,
} from '../config/configuration';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

export type ModelPurpose = 'any' | 'planner' | 'synthesizer' | 'router';

export interface ModelRecord {
  id: number;
  applicationId: number | null;
  name: string;
  provider: string;
  baseUrl: string;
  modelId: string;
  purpose: ModelPurpose;
  priority: number;
  isEnabled: boolean;
  supportsStreaming: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
  lastOkAt: Date | null;
  lastError: string | null;
}

/** Includes the decrypted credential. Never leaves the LLM layer. */
export interface ResolvedModel extends ModelRecord {
  apiKey: string;
}

export interface ModelInput {
  applicationId: number | null;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string | null;
  purpose: ModelPurpose;
  priority: number;
  isEnabled: boolean;
  supportsStreaming: boolean;
  timeoutMs?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
}

interface ModelRow {
  id: string;
  application_id: string | null;
  name: string;
  provider: string;
  base_url: string;
  model_id: string;
  api_key_encrypted: string | null;
  purpose: string;
  priority: number;
  is_enabled: boolean;
  supports_streaming: boolean;
  timeout_ms: number | null;
  max_output_tokens: number | null;
  temperature: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

/**
 * Models are configuration, not code.
 *
 * Which model plans, which one writes the answer, and what falls back to what
 * is a row in a table an operator edits — not an environment variable that
 * needs a redeploy. `priority` orders candidates for a purpose: the first
 * enabled model is primary, the next is its fallback, and so on.
 *
 * Provider credentials are encrypted at rest with `ENCRYPTION_KEY` and are
 * never returned by the management API or shown in the dashboard.
 */
@Injectable()
export class ModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ModelRegistryService.name);
  private readonly key: Buffer;
  private cache: { models: ResolvedModel[]; expiresAt: number } | null = null;
  private readonly cacheTtlMs = 15_000;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
  ) {
    this.key = decodeEncryptionKey(config.security.encryptionKey);
  }

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async onModuleInit(): Promise<void> {
    // Nothing to seed into a database that is not connected yet. The setup
    // flow calls this again once it is.
    if (!this.db.isReady()) return;
    await this.seedIfEmpty();
  }

  /**
   * Candidate models for a purpose, in fallback order.
   *
   * A purpose-specific model outranks a general one, so configuring a small
   * fast model for `router` while leaving `any` pointed at something larger
   * works without further wiring.
   */
  async candidatesFor(
    purpose: Exclude<ModelPurpose, 'any'>,
    applicationId: number,
  ): Promise<ResolvedModel[]> {
    const all = await this.all();

    return all
      .filter((model) => model.isEnabled)
      .filter(
        (model) =>
          model.applicationId === null || model.applicationId === applicationId,
      )
      .filter((model) => model.purpose === purpose || model.purpose === 'any')
      .sort((a, b) => {
        if (a.purpose !== b.purpose) return a.purpose === purpose ? -1 : 1;
        // Application-specific configuration beats the global default.
        if (a.applicationId !== b.applicationId) {
          return a.applicationId === null ? 1 : -1;
        }
        return a.priority - b.priority;
      });
  }

  async all(): Promise<ResolvedModel[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.models;

    const rows = await this.db.query<ModelRow>(
      `SELECT id, application_id, name, provider, base_url, model_id,
              api_key_encrypted, purpose, priority, is_enabled, supports_streaming,
              timeout_ms, max_output_tokens, temperature, last_ok_at, last_error
         FROM ${this.schema}.agent_models
        ORDER BY priority, id`,
    );

    const models = rows.map((row) => this.toResolved(row));
    this.cache = { models, expiresAt: Date.now() + this.cacheTtlMs };
    return models;
  }

  /** Management view — no credentials. */
  async list(): Promise<ModelRecord[]> {
    const models = await this.all();
    return models.map(({ apiKey: _apiKey, ...record }) => record);
  }

  async upsert(input: ModelInput, id?: number): Promise<ModelRecord> {
    const encrypted =
      input.apiKey === undefined
        ? undefined
        : input.apiKey === null || input.apiKey === ''
          ? null
          : encryptSecret(input.apiKey, this.key);

    const row = id
      ? await this.db.one<ModelRow>(
          `UPDATE ${this.schema}.agent_models
              SET application_id = $2, name = $3, base_url = $4, model_id = $5,
                  purpose = $6, priority = $7, is_enabled = $8,
                  supports_streaming = $9, timeout_ms = $10,
                  max_output_tokens = $11, temperature = $12,
                  api_key_encrypted = COALESCE($13, api_key_encrypted),
                  updated_at = now()
            WHERE id = $1
        RETURNING *`,
          [
            id,
            input.applicationId,
            input.name,
            input.baseUrl,
            input.modelId,
            input.purpose,
            input.priority,
            input.isEnabled,
            input.supportsStreaming,
            input.timeoutMs ?? null,
            input.maxOutputTokens ?? null,
            input.temperature ?? null,
            encrypted ?? null,
          ],
        )
      : await this.db.one<ModelRow>(
          `INSERT INTO ${this.schema}.agent_models
             (application_id, name, base_url, model_id, purpose, priority,
              is_enabled, supports_streaming, timeout_ms, max_output_tokens,
              temperature, api_key_encrypted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
          [
            input.applicationId,
            input.name,
            input.baseUrl,
            input.modelId,
            input.purpose,
            input.priority,
            input.isEnabled,
            input.supportsStreaming,
            input.timeoutMs ?? null,
            input.maxOutputTokens ?? null,
            input.temperature ?? null,
            encrypted ?? null,
          ],
        );

    this.cache = null;
    const { apiKey: _apiKey, ...record } = this.toResolved(row!);
    return record;
  }

  async remove(id: number): Promise<void> {
    await this.db.query(`DELETE FROM ${this.schema}.agent_models WHERE id = $1`, [id]);
    this.cache = null;
  }

  /** Records the outcome of a call so the dashboard can show model health. */
  async recordOutcome(id: number, error: string | null): Promise<void> {
    await this.db
      .query(
        error
          ? `UPDATE ${this.schema}.agent_models SET last_error = $2 WHERE id = $1`
          : `UPDATE ${this.schema}.agent_models SET last_ok_at = now(), last_error = NULL WHERE id = $1`,
        error ? [id, error.slice(0, 500)] : [id],
      )
      .catch(() => undefined);
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * Probe an endpoint with credentials that have not been saved.
   *
   * Saving a model that turns out to be unreachable means the next real chat
   * request is where you find out — so the console tests first. When editing an
   * existing model the key may be left blank to mean "unchanged", in which case
   * the stored one is used for the probe.
   */
  async testConnection(input: {
    baseUrl: string;
    modelId: string;
    apiKey?: string | null;
    existingId?: number | null;
  }): Promise<{
    ok: boolean;
    latencyMs: number;
    reply?: string;
    error?: string;
  }> {
    let apiKey = input.apiKey ?? '';

    if (!apiKey && input.existingId) {
      const stored = (await this.all()).find(
        (model) => model.id === input.existingId,
      );
      apiKey = stored?.apiKey ?? '';
    }

    const probe: ResolvedModel = {
      id: -1,
      applicationId: null,
      name: 'connection test',
      provider: 'openai-compatible',
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      apiKey,
      purpose: 'any',
      priority: 0,
      isEnabled: true,
      supportsStreaming: false,
      timeoutMs: 15_000,
      maxOutputTokens: 16,
      temperature: 0,
      lastOkAt: null,
      lastError: null,
    };

    const startedAt = Date.now();

    try {
      const result = await new OpenAiCompatibleProvider(probe).complete(
        [
          {
            role: 'user',
            content: 'Reply with the single word: ready',
          },
        ],
        { context: 'connection-test', maxTokens: 16, timeoutMs: 15_000 },
      );

      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        reply: result.text.trim().slice(0, 120),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: explainConnectionFailure(error),
      };
    }
  }

  /**
   * First boot with an empty models table takes the seed values from the
   * environment, so a fresh deployment is usable before anyone opens the
   * dashboard. After that the table is the source of truth.
   */
  async seedIfEmpty(): Promise<void> {
    const { seedBaseUrl, seedModel, seedApiKey } = this.config.llm;
    if (!seedBaseUrl || !seedModel) return;

    const existing = await this.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.schema}.agent_models`,
    );
    if (Number(existing?.count ?? 0) > 0) return;

    await this.upsert({
      applicationId: null,
      name: 'Seed model',
      baseUrl: seedBaseUrl,
      modelId: seedModel,
      apiKey: seedApiKey || null,
      purpose: 'any',
      priority: 100,
      isEnabled: true,
      supportsStreaming: true,
    });

    this.logger.log(`Seeded model registry from environment: ${seedModel}`);
  }

  private toResolved(row: ModelRow): ResolvedModel {
    let apiKey = '';
    if (row.api_key_encrypted) {
      try {
        apiKey = decryptSecret(row.api_key_encrypted, this.key);
      } catch {
        // A key encrypted under a different ENCRYPTION_KEY is unusable. Say so
        // once rather than failing every request with a decryption error.
        this.logger.error(
          `Model "${row.name}" has a credential that cannot be decrypted with the ` +
            'current ENCRYPTION_KEY. Re-enter it in the dashboard.',
        );
      }
    }

    return {
      id: Number(row.id),
      applicationId: row.application_id ? Number(row.application_id) : null,
      name: row.name,
      provider: row.provider,
      baseUrl: row.base_url,
      modelId: row.model_id,
      apiKey,
      purpose: row.purpose as ModelPurpose,
      priority: row.priority,
      isEnabled: row.is_enabled,
      supportsStreaming: row.supports_streaming,
      timeoutMs: row.timeout_ms ?? this.config.llm.defaultTimeoutMs,
      maxOutputTokens:
        row.max_output_tokens ?? this.config.llm.defaultMaxOutputTokens,
      temperature:
        row.temperature === null
          ? this.config.llm.defaultTemperature
          : Number(row.temperature),
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
    };
  }
}

/**
 * Turn a transport failure into one clear sentence.
 *
 * The raw chain reads "connection test request failed: fetch failed — fetch
 * failed — bad port", which repeats itself and buries the cause. Operators need
 * to know where to look, so this identifies the underlying error and says what
 * to check, keeping the technical detail once at the end.
 */
function explainConnectionFailure(error: unknown): string {
  // Walk the whole chain. Node's fetch reports every transport problem as
  // "fetch failed" and puts the real errno two levels down, so stopping at the
  // first cause makes a DNS typo and a dead port read identically.
  const detail = collectCauses(error).join(' / ');

  const say = (advice: string, technical?: string): string =>
    technical ? `${advice} (${technical})` : advice;

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(detail)) {
    return say(
      'That hostname did not resolve. Check the host part of the base URL.',
      firstCode(detail),
    );
  }
  if (/Failed to parse URL|Invalid URL|ERR_INVALID_URL/i.test(detail)) {
    return 'That is not a valid URL. It should look like http://host:8000/v1.';
  }
  if (/bad port|ERR_SOCKET/i.test(detail)) {
    return 'That port is not valid. The base URL should look like http://host:8000/v1.';
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed/i.test(detail)) {
    return say(
      'Nothing accepted a connection there. Check the host and port, and that the server is running.',
      firstCode(detail),
    );
  }
  if (/timed out|ETIMEDOUT|AbortError/i.test(detail)) {
    return 'The endpoint accepted the connection but did not answer in time.';
  }
  if (/\b401\b|unauthorized/i.test(detail)) {
    return 'The endpoint rejected the credentials. Check the API key.';
  }
  if (/\b403\b|forbidden/i.test(detail)) {
    return 'The endpoint refused the request. The key may lack access to this model.';
  }
  if (/\b404\b/i.test(detail)) {
    return 'No endpoint at that path. The base URL usually ends in /v1.';
  }
  if (/\b400\b/i.test(detail)) {
    return say(
      'The endpoint rejected the request, most often because that model id does not exist there.',
      firstLine(detail),
    );
  }
  if (/\b5\d\d\b/.test(detail)) {
    return say('The endpoint returned a server error.', firstLine(detail));
  }

  return firstLine(detail);
}

/**
 * Every distinct message in an error's cause chain, outermost first.
 *
 * Deduplicated, because the same text usually appears at more than one level
 * and "fetch failed / fetch failed" tells nobody anything twice.
 */
function collectCauses(error: unknown, depth = 0): string[] {
  if (depth > 5 || error === null || error === undefined) return [];

  if (!(error instanceof Error)) {
    // A thrown non-Error. Handled case by case because `String(…)` on a plain
    // object yields "[object Object]", which is worse than useless in a message
    // shown to an operator.
    if (typeof error === 'string') return error ? [error] : [];
    if (
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      typeof error === 'bigint'
    ) {
      return [String(error)];
    }
    if (typeof error === 'object') {
      const rendered = safeStringify(error);
      return rendered ? [rendered] : [];
    }
    return [];
  }

  return [
    ...new Set(
      [error.message, ...collectCauses(error.cause, depth + 1)].filter(Boolean),
    ),
  ];
}

function safeStringify(value: object): string {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? '';
  } catch {
    return '';
  }
}

/** The most specific errno-style code in a nested error chain. */
function firstCode(detail: string): string {
  const match = detail.match(/\b(E[A-Z]{3,})\b/);
  return match?.[1] ?? '';
}

function firstLine(detail: string): string {
  return detail.split('\n')[0]!.slice(0, 200);
}
