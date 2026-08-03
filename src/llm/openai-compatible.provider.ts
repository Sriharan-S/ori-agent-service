import {
  LlmError,
  parseToolArguments,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type ToolCall,
} from './llm.types';
import type { ResolvedModel } from './model-registry.service';

interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | null };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: RawToolCall[] | null;
      /**
       * Reasoning models put their chain of thought here and the answer in
       * `content`. Never used as the answer — it is read only to explain an
       * empty one, which is the difference between "the model failed" and "the
       * model thought until it ran out of tokens".
       */
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Messages in the wire shape.
 *
 * `name` is deliberately never sent. Groq rejects `messages[].name` outright,
 * and it carries nothing the `tool_call_id` pairing does not already establish
 * — so omitting it costs nothing and keeps one more provider working.
 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        // An assistant turn that only called tools has no prose. The field must
        // still be present — some providers reject a message without one.
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      };
    }

    return { role: message.role, content: message.content };
  });
}

function toToolCalls(raw: RawToolCall[] | null | undefined): ToolCall[] {
  if (!raw?.length) return [];

  const calls: ToolCall[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index]!;
    const name = entry.function?.name;
    if (!name) continue;

    const parsed = parseToolArguments(entry.function?.arguments);
    calls.push({
      // Some OpenAI-compatible servers omit the id. The pairing between an
      // assistant tool call and its result is positional then, and a synthesised
      // id keeps that pairing expressible rather than dropping the call.
      id: entry.id ?? `call_${index}`,
      name,
      arguments: parsed.arguments,
      ...(parsed.malformed ? { malformed: parsed.malformed } : {}),
    });
  }

  return calls;
}

/**
 * One client for every provider.
 *
 * vLLM, and most hosted providers worth using, speak the OpenAI chat
 * completions shape. Treating that as the interface means adding a provider is
 * a row in the models table rather than a new class.
 */
export class OpenAiCompatibleProvider {
  constructor(private readonly model: ResolvedModel) {}

  get name(): string {
    return this.model.name;
  }

  get modelId(): string {
    return this.model.modelId;
  }

  async complete(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const response = await this.post(messages, options, false);

    const payload = (await response.json()) as ChatCompletionResponse;
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? '';
    const toolCalls = toToolCalls(choice?.message?.tool_calls);

    // An assistant turn that only calls a tool has no prose, and that is the
    // normal successful shape once tools are in play — not an empty completion.
    if (!text.trim() && toolCalls.length === 0) {
      throw new LlmError(
        `${this.name} returned an empty completion${describeEmpty(payload)}`,
        this.name,
        null,
        true,
      );
    }

    return {
      text,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      provider: this.name,
      model: this.model.modelId,
      latencyMs: Date.now() - startedAt,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    };
  }

  /**
   * Streaming completion, yielding text deltas as they arrive.
   *
   * The caller sees tokens as the model produces them, which is the difference
   * between an answer that appears after eight seconds of nothing and one that
   * starts immediately.
   */
  async *stream(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<string, CompletionResult, undefined> {
    const startedAt = Date.now();
    const response = await this.post(messages, options, true);

    if (!response.body) {
      throw new LlmError(
        `${this.name} returned no response body to stream`,
        this.name,
        null,
        true,
      );
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    let buffer = '';
    let text = '';
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a frame may straddle chunks.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '' || data === '[DONE]') continue;

            let chunk: StreamChunk;
            try {
              chunk = JSON.parse(data) as StreamChunk;
            } catch {
              continue;
            }

            if (chunk.usage) {
              promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
              completionTokens = chunk.usage.completion_tokens ?? completionTokens;
            }

            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              yield delta;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!text.trim()) {
      throw new LlmError(
        `${this.name} streamed an empty completion`,
        this.name,
        null,
        true,
      );
    }

    return {
      text,
      toolCalls: [],
      finishReason: null,
      provider: this.name,
      model: this.model.modelId,
      latencyMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
    };
  }

  private async post(
    messages: ChatMessage[],
    options: CompletionOptions,
    stream: boolean,
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.model.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        `${this.model.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            // Operator headers first, so the built-ins below always win. A
            // gateway needs its own header *alongside* the provider's
            // authorization, never instead of it — and a typo here must not be
            // able to silently strip authentication. Setting `authorization`
            // deliberately is still possible by leaving the model's key blank.
            ...this.model.extraHeaders,
            'content-type': 'application/json',
            ...(this.model.apiKey
              ? { authorization: `Bearer ${this.model.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.model.modelId,
            messages: toWireMessages(messages),
            temperature: options.temperature ?? this.model.temperature,
            max_tokens: options.maxTokens ?? this.model.maxOutputTokens,
            stream,
            ...(options.tools?.length
              ? {
                  tools: options.tools.map((tool) => ({
                    type: 'function',
                    function: tool,
                  })),
                  tool_choice: options.toolChoice ?? 'auto',
                }
              : {}),
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new LlmError(
          `${this.name} returned ${response.status}: ${body.slice(0, 300)}`,
          this.name,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }

      return response;
    } catch (error) {
      if (error instanceof LlmError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError(
          `${this.name} timed out after ${timeoutMs}ms`,
          this.name,
          null,
          true,
        );
      }

      throw new LlmError(
        `${this.name} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
        null,
        true,
        error,
      );
    } finally {
      // Cleared once headers are in; the body stream is read after this and is
      // bounded by the run timeout rather than the request timeout.
      clearTimeout(timer);
    }
  }
}

/**
 * Why a completion came back empty.
 *
 * "returned an empty completion" is true and useless — it sent an operator
 * looking at the network when the actual cause was a reasoning model spending
 * its entire token budget on chain of thought and never reaching an answer.
 * `finish_reason: "length"` with reasoning tokens present says exactly that, and
 * the fix (raise the model's max output tokens) is then obvious.
 */
function describeEmpty(payload: ChatCompletionResponse): string {
  const choice = payload.choices?.[0];

  if (!choice) return ' — the response contained no choices at all.';

  const finish = choice.finish_reason ?? 'unspecified';
  const reasoning =
    choice.message?.reasoning_content?.trim() ??
    (payload.usage?.completion_tokens_details?.reasoning_tokens
      ? '(reasoning tokens reported)'
      : '');

  if (finish === 'length') {
    return reasoning
      ? ' — it stopped at the output-token limit while still reasoning, so no answer ' +
          'was produced. Raise this model\'s max output tokens.'
      : ' — it stopped at the output-token limit before producing any text. Raise ' +
          "this model's max output tokens.";
  }

  if (reasoning) {
    return ` — it produced reasoning but no answer (finish reason: ${finish}).`;
  }

  return ` — finish reason: ${finish}.`;
}
