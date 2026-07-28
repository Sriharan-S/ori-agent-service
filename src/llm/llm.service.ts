import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { CircuitBreaker, isQuotaOrRateLimitError } from './circuit-breaker';
import {
  ModelRegistryService,
  type ModelPurpose,
  type ResolvedModel,
} from './model-registry.service';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import {
  LlmError,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
} from './llm.types';

export type Purpose = Exclude<ModelPurpose, 'any'>;

export interface LlmRequest extends Omit<CompletionOptions, 'context'> {
  purpose: Purpose;
  applicationId: number;
}

export interface StructuredRequest<T> extends LlmRequest {
  validate: (value: unknown) => T | string;
  shapeHint: string;
}

export interface LlmCallMetric {
  purpose: Purpose;
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  succeeded: boolean;
  attempt: number;
  at: number;
}

/**
 * Provider-agnostic LLM access.
 *
 * Which model answers is decided by the models table, not by this code: for a
 * given purpose it walks the configured candidates in priority order, and the
 * next one is the fallback. Adding, reordering or disabling a model is an
 * operator action, not a deployment.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly breaker: CircuitBreaker;
  private readonly metrics: LlmCallMetric[] = [];
  private readonly maxMetrics = 500;

  constructor(
    @Inject(CONFIG) config: AppConfig,
    private readonly models: ModelRegistryService,
  ) {
    this.breaker = new CircuitBreaker(
      config.llm.breakerThreshold,
      config.llm.breakerCooldownMs,
    );
  }

  async complete(
    messages: ChatMessage[],
    request: LlmRequest,
  ): Promise<CompletionResult> {
    const candidates = await this.candidates(request);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const model = candidates[attempt]!;
      if (this.breaker.isOpen(String(model.id))) continue;

      const provider = new OpenAiCompatibleProvider(model);

      try {
        const result = await provider.complete(messages, {
          context: request.purpose,
          ...request,
        });

        this.succeeded(model, request.purpose, result, attempt);
        return result;
      } catch (error) {
        lastError = error;
        this.failed(model, request.purpose, error, attempt);
      }
    }

    throw this.exhausted(request.purpose, candidates.length, lastError);
  }

  /**
   * Streaming completion. Yields deltas; returns the assembled result.
   *
   * Failover only applies before the first token: once bytes have reached the
   * client, silently switching models would splice two different answers
   * together. After that, a failure is a failure.
   */
  async *stream(
    messages: ChatMessage[],
    request: LlmRequest,
  ): AsyncGenerator<string, CompletionResult, undefined> {
    const candidates = (await this.candidates(request)).filter(
      (model) => model.supportsStreaming,
    );
    let lastError: unknown = null;

    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      const model = candidates[attempt]!;
      if (this.breaker.isOpen(String(model.id))) continue;

      const provider = new OpenAiCompatibleProvider(model);
      const iterator = provider.stream(messages, {
        context: request.purpose,
        ...request,
      });

      let emitted = false;

      try {
        for (;;) {
          const next = await iterator.next();

          if (next.done) {
            this.succeeded(model, request.purpose, next.value, attempt);
            return next.value;
          }

          emitted = true;
          yield next.value;
        }
      } catch (error) {
        lastError = error;
        this.failed(model, request.purpose, error, attempt);
        if (emitted) throw error;
      }
    }

    throw this.exhausted(request.purpose, candidates.length, lastError);
  }

  /**
   * Completion constrained to a JSON object.
   *
   * Models wrap JSON in prose and markdown fences with some regularity, so the
   * response is cleaned before parsing. A payload that still will not parse or
   * validate gets exactly one repair round-trip — a second failure is a real
   * failure, and retrying further just burns latency.
   */
  async completeStructured<T>(
    messages: ChatMessage[],
    request: StructuredRequest<T>,
  ): Promise<T> {
    const first = await this.complete(messages, request);
    const parsed = this.parseAndValidate(first.text, request.validate);
    if (parsed.ok) return parsed.value;

    this.logger.warn(
      `${request.purpose}: structured parse failed (${parsed.complaint}) — repairing`,
    );

    const repair: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 2000) },
      {
        role: 'user',
        content:
          `That response could not be used: ${parsed.complaint}\n\n` +
          'Reply with valid JSON only — no markdown fences, no commentary. ' +
          `Expected shape:\n${request.shapeHint}`,
      },
    ];

    const second = await this.complete(repair, request);
    const retried = this.parseAndValidate(second.text, request.validate);
    if (retried.ok) return retried.value;

    throw new LlmError(
      `${request.purpose}: structured output invalid after repair — ${retried.complaint}`,
      second.provider,
      null,
      false,
    );
  }

  /** Reachability probe for `/ready` and the dashboard. */
  async healthCheck(
    applicationId: number,
  ): Promise<Array<{ model: string; ok: boolean; error?: string }>> {
    const candidates = await this.models.candidatesFor('planner', applicationId);

    return Promise.all(
      candidates.map(async (model) => {
        try {
          await new OpenAiCompatibleProvider(model).complete(
            [{ role: 'user', content: 'ping' }],
            { context: 'healthcheck', maxTokens: 1, timeoutMs: 5000 },
          );
          await this.models.recordOutcome(model.id, null);
          return { model: model.name, ok: true };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.models.recordOutcome(model.id, message);
          return { model: model.name, ok: false, error: message };
        }
      }),
    );
  }

  getMetrics(limit = 100): LlmCallMetric[] {
    return this.metrics.slice(-limit);
  }

  private async candidates(request: LlmRequest): Promise<ResolvedModel[]> {
    const candidates = await this.models.candidatesFor(
      request.purpose,
      request.applicationId,
    );

    if (candidates.length === 0) {
      throw new LlmError(
        `No enabled model is configured for "${request.purpose}". Add one in the dashboard.`,
        'none',
        null,
        false,
      );
    }

    return candidates;
  }

  private succeeded(
    model: ResolvedModel,
    purpose: Purpose,
    result: CompletionResult,
    attempt: number,
  ): void {
    this.breaker.recordSuccess(String(model.id));
    void this.models.recordOutcome(model.id, null);
    this.record({
      purpose,
      model: model.name,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      succeeded: true,
      attempt,
      at: Date.now(),
    });
  }

  private failed(
    model: ResolvedModel,
    purpose: Purpose,
    error: unknown,
    attempt: number,
  ): void {
    const message = error instanceof Error ? error.message : String(error);

    this.breaker.recordFailure(String(model.id), isQuotaOrRateLimitError(error));
    void this.models.recordOutcome(model.id, message);
    this.logger.warn(`${purpose}: model "${model.name}" failed — ${message}`);

    this.record({
      purpose,
      model: model.name,
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      succeeded: false,
      attempt,
      at: Date.now(),
    });
  }

  private exhausted(
    purpose: Purpose,
    tried: number,
    lastError: unknown,
  ): LlmError {
    const detail =
      lastError instanceof Error ? lastError.message : 'no candidate available';
    this.logger.error(`${purpose}: all ${tried} model(s) failed — ${detail}`);

    return lastError instanceof LlmError
      ? lastError
      : new LlmError(
          `Every configured model for "${purpose}" failed: ${detail}`,
          'none',
          null,
          true,
        );
  }

  private record(metric: LlmCallMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxMetrics) this.metrics.shift();
  }

  private parseAndValidate<T>(
    raw: string,
    validate: (value: unknown) => T | string,
  ): { ok: true; value: T } | { ok: false; complaint: string } {
    const cleaned = extractJsonObject(raw);
    if (cleaned === null) {
      return { ok: false, complaint: 'no JSON object found in the response' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      return {
        ok: false,
        complaint: `JSON.parse failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const validated = validate(parsed);
    return typeof validated === 'string'
      ? { ok: false, complaint: validated }
      : { ok: true, value: validated };
  }
}

/**
 * Pull the first balanced JSON object out of a model response, tolerating
 * markdown fences and surrounding prose.
 *
 * Brace counting rather than a greedy `\{[\s\S]*\}` match, so trailing prose
 * containing a `}` does not drag garbage into the parse.
 */
export function extractJsonObject(raw: string): string | null {
  const withoutFences = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = withoutFences.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < withoutFences.length; index += 1) {
    const char = withoutFences[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return withoutFences.slice(start, index + 1);
    }
  }

  return null;
}
