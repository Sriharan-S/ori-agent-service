import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CONFIG,
  decodeEncryptionKey,
  type AppConfig,
} from '../config/configuration';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';

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
         FROM ${this.schema}.models
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
          `UPDATE ${this.schema}.models
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
          `INSERT INTO ${this.schema}.models
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
    await this.db.query(`DELETE FROM ${this.schema}.models WHERE id = $1`, [id]);
    this.cache = null;
  }

  /** Records the outcome of a call so the dashboard can show model health. */
  async recordOutcome(id: number, error: string | null): Promise<void> {
    await this.db
      .query(
        error
          ? `UPDATE ${this.schema}.models SET last_error = $2 WHERE id = $1`
          : `UPDATE ${this.schema}.models SET last_ok_at = now(), last_error = NULL WHERE id = $1`,
        error ? [id, error.slice(0, 500)] : [id],
      )
      .catch(() => undefined);
  }

  invalidate(): void {
    this.cache = null;
  }

  /**
   * First boot with an empty models table takes the seed values from the
   * environment, so a fresh deployment is usable before anyone opens the
   * dashboard. After that the table is the source of truth.
   */
  private async seedIfEmpty(): Promise<void> {
    const { seedBaseUrl, seedModel, seedApiKey } = this.config.llm;
    if (!seedBaseUrl || !seedModel) return;

    const existing = await this.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.schema}.models`,
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
