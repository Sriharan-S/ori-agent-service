export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionOptions {
  /** Label used for logs, metrics and the fallback cooldown key. */
  context: string;
  maxTokens?: number;
  temperature?: number;
  /** Overrides the provider default. */
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  complete(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<CompletionResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null = null,
    readonly retryable = false,
    /**
     * The underlying failure. Node's fetch reports every transport problem as
     * "fetch failed" and puts the real one here, so dropping it makes a DNS
     * typo and a dead port indistinguishable.
     */
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmError';
  }
}
