export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A function offered to the model, in OpenAI's tool shape.
 *
 * `parameters` is JSON Schema. It is built from a registry function's own
 * `ParamSchema` rather than written by hand, so what the model is allowed to
 * send and what the validator will accept cannot drift apart.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

/** One tool invocation the model asked for. */
export interface ToolCall {
  /** Provider-assigned. Echoed back on the matching tool result message. */
  id: string;
  name: string;
  /**
   * Already parsed. The provider hands these over as a JSON *string*, and a
   * model that emits malformed JSON is a routine event rather than an
   * exceptional one — see `parseToolArguments`.
   */
  arguments: Record<string, unknown>;
  /** Set when the arguments string would not parse. The loop feeds it back. */
  malformed?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant turns that asked for tools. */
  toolCalls?: ToolCall[];
  /** Tool turns: which call this is the result of. */
  toolCallId?: string;
}

export interface CompletionOptions {
  /** Label used for logs, metrics and the fallback cooldown key. */
  context: string;
  maxTokens?: number;
  temperature?: number;
  /** Overrides the provider default. */
  timeoutMs?: number;
  /** Functions the model may call this turn. Omitted means plain completion. */
  tools?: ToolSchema[];
  /**
   * `auto` lets the model answer instead of calling — which is how it declines
   * when nothing fits, so it is the default wherever declining is a valid
   * outcome. `required` forces a call and `none` forbids one.
   */
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface CompletionResult {
  text: string;
  /** Empty when the model answered rather than calling something. */
  toolCalls: ToolCall[];
  finishReason: string | null;
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

/**
 * Parse a tool call's argument string.
 *
 * Never throws. A model that emits `{"name": "sriharan` is not an exception to
 * handle at this layer — it is a turn the loop has to be able to answer with
 * "that was not valid JSON, try again", which it can only do if the malformed
 * text survives as data. Throwing here would abort a run over something one
 * more round-trip fixes.
 */
export function parseToolArguments(
  raw: string | null | undefined,
): { arguments: Record<string, unknown>; malformed?: string } {
  const text = (raw ?? '').trim();
  if (text === '') return { arguments: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        arguments: {},
        malformed: `arguments must be a JSON object, received ${
          Array.isArray(parsed) ? 'an array' : typeof parsed
        }`,
      };
    }
    return { arguments: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      arguments: {},
      malformed: `arguments were not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
