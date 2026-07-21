/**
 * Anthropic Messages SSE 解析 → ProviderStreamEvent。
 * 对照 litellm anthropic chat handler content_block_delta / tool_use 映射。
 */

import type { JsonObject, JsonValue } from '@crish/shared-types';
import {
  isSseReadDiagnostic,
  readSseJson,
  type SseDiagnosticsOptions,
} from './openai-stream-parse';
import type { ProviderStreamEvent, ProviderUsage } from './types';

interface PendingToolUse {
  id: string;
  name: string;
  argumentsText: string;
}

/**
 * Parse Anthropic Messages streaming SSE body into ProviderStreamEvent.
 * Emits text-delta / thought-delta / tool-call / stop (never silent empty complete).
 */
export async function* parseAnthropicMessagesStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'Streaming response body is empty',
    };
    return;
  }

  const pendingTools = new Map<number, PendingToolUse>();
  let stopReason: ProviderStreamEvent & { type: 'stop' } = {
    type: 'stop',
    reason: 'stop',
  };
  let usage: ProviderUsage | undefined;
  let emittedContent = false;
  let sawMessageStop = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: 'provider-diagnostic', diagnostic: payload.diagnostic };
      continue;
    }

    const eventType = typeof payload.type === 'string' ? payload.type : '';

    if (eventType === 'error') {
      const error =
        anthropicPayloadError(payload) ?? 'Anthropic streaming error';
      yield { type: 'stop', reason: 'error', error, usage };
      return;
    }

    if (eventType === 'message_start') {
      const message =
        payload.message && typeof payload.message === 'object'
          ? (payload.message as Record<string, unknown>)
          : undefined;
      usage = parseAnthropicUsage(message?.usage) ?? usage;
      continue;
    }

    if (eventType === 'content_block_start') {
      const index = numberField(payload.index) ?? 0;
      const block =
        payload.content_block && typeof payload.content_block === 'object'
          ? (payload.content_block as Record<string, unknown>)
          : undefined;
      if (!block) continue;
      const blockType = typeof block.type === 'string' ? block.type : '';
      if (blockType === 'tool_use') {
        pendingTools.set(index, {
          id: typeof block.id === 'string' ? block.id : `toolu_${index}`,
          name: typeof block.name === 'string' ? block.name : '',
          argumentsText: '',
        });
      } else if (blockType === 'thinking') {
        // thinking start — content arrives via thinking_delta
      }
      continue;
    }

    if (eventType === 'content_block_delta') {
      const index = numberField(payload.index) ?? 0;
      const delta =
        payload.delta && typeof payload.delta === 'object'
          ? (payload.delta as Record<string, unknown>)
          : undefined;
      if (!delta) continue;
      const deltaType = typeof delta.type === 'string' ? delta.type : '';

      if (deltaType === 'text_delta' || typeof delta.text === 'string') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (text) {
          emittedContent = true;
          yield { type: 'text-delta', text };
        }
        continue;
      }

      if (
        deltaType === 'thinking_delta' ||
        typeof delta.thinking === 'string'
      ) {
        const text = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (text) {
          emittedContent = true;
          yield { type: 'thought-delta', text };
        }
        continue;
      }

      if (
        deltaType === 'input_json_delta' ||
        typeof delta.partial_json === 'string'
      ) {
        const partial =
          typeof delta.partial_json === 'string' ? delta.partial_json : '';
        const pending = pendingTools.get(index);
        if (pending) {
          pending.argumentsText += partial;
        }
        continue;
      }

      continue;
    }

    if (eventType === 'content_block_stop') {
      const index = numberField(payload.index) ?? 0;
      const pending = pendingTools.get(index);
      if (pending && pending.name) {
        emittedContent = true;
        yield {
          type: 'tool-call',
          id: pending.id,
          toolName: pending.name,
          input: parseArguments(pending.argumentsText),
        };
        pendingTools.delete(index);
      }
      continue;
    }

    if (eventType === 'message_delta') {
      const delta =
        payload.delta && typeof payload.delta === 'object'
          ? (payload.delta as Record<string, unknown>)
          : undefined;
      if (delta?.stop_reason !== undefined) {
        stopReason = {
          type: 'stop',
          reason: anthropicStopReasonToStop(delta.stop_reason),
        };
      }
      // message_start carries input_tokens; message_delta typically only has output_tokens — merge.
      const deltaUsage = parseAnthropicUsage(payload.usage);
      if (deltaUsage) {
        usage = mergeAnthropicUsage(usage, deltaUsage);
      }
      continue;
    }

    if (eventType === 'message_stop') {
      sawMessageStop = true;
      continue;
    }

    // Some proxies only send data objects without type; ignore noise.
  }

  // Flush any remaining tool_use that never got content_block_stop (defensive).
  for (const pending of pendingTools.values()) {
    if (pending.name) {
      emittedContent = true;
      yield {
        type: 'tool-call',
        id: pending.id,
        toolName: pending.name,
        input: parseArguments(pending.argumentsText),
      };
    }
  }

  if (!emittedContent && !sawMessageStop && !usage) {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'Anthropic streaming response completed without content events',
    };
    return;
  }

  yield { ...stopReason, usage };
}

/** Parse a non-streaming Anthropic Messages JSON response. */
export async function* parseAnthropicMessagesJsonResponse(
  body: JsonObject
): AsyncIterable<ProviderStreamEvent> {
  const error = anthropicPayloadError(body);
  if (error) {
    yield { type: 'stop', reason: 'error', error };
    return;
  }

  const content = Array.isArray(body.content) ? body.content : [];
  let emitted = false;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' && typeof block.text === 'string' && block.text) {
      emitted = true;
      yield { type: 'text-delta', text: block.text };
    } else if (
      type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking
    ) {
      emitted = true;
      yield { type: 'thought-delta', text: block.thinking };
    } else if (type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      if (!name) continue;
      emitted = true;
      const input =
        block.input &&
        typeof block.input === 'object' &&
        !Array.isArray(block.input)
          ? (block.input as JsonObject)
          : {};
      yield {
        type: 'tool-call',
        id: typeof block.id === 'string' ? block.id : undefined,
        toolName: name,
        input,
      };
    }
  }

  const usage = parseAnthropicUsage(body.usage);
  const reason = anthropicStopReasonToStop(body.stop_reason);

  if (!emitted && reason === 'error') {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'Anthropic response did not include content',
      usage,
    };
    return;
  }

  yield { type: 'stop', reason, usage };
}

export function anthropicStopReasonToStop(
  reason: unknown
): 'stop' | 'tool-call' | 'length' | 'error' {
  if (reason === 'tool_use') return 'tool-call';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence' || reason == null)
    return 'stop';
  if (reason === 'refusal') return 'error';
  return 'stop';
}

export function parseAnthropicUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const promptTokens =
    numberField(usage.input_tokens) ?? numberField(usage.prompt_tokens);
  const completionTokens =
    numberField(usage.output_tokens) ?? numberField(usage.completion_tokens);
  const cacheRead = numberField(usage.cache_read_input_tokens);
  const cacheWrite = numberField(usage.cache_creation_input_tokens);
  const total =
    numberField(usage.total_tokens) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  return compactDefined({
    promptTokens,
    completionTokens,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
}

export function anthropicPayloadError(payload: JsonObject): string | undefined {
  const err = payload.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const record = err as Record<string, unknown>;
    const message =
      typeof record.message === 'string' ? record.message : undefined;
    const type = typeof record.type === 'string' ? record.type : undefined;
    if (message && type) return `${type}: ${message}`;
    if (message) return message;
    if (type) return type;
  }
  if (typeof payload.message === 'string' && payload.type === 'error') {
    return payload.message;
  }
  return undefined;
}

function parseArguments(input: string): JsonObject {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input) as JsonValue;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return { value: parsed as JsonValue };
  } catch (cause) {
    return {
      __rawArguments: input,
      __parseError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function compactDefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  ) as T;
}

function mergeAnthropicUsage(
  base: ProviderUsage | undefined,
  next: ProviderUsage
): ProviderUsage {
  // Partial chunks (message_start vs message_delta) often carry only input OR output tokens.
  // Prefer explicit fields from either side; recompute total from the merged pair.
  const promptTokens = next.promptTokens ?? base?.promptTokens;
  const completionTokens = next.completionTokens ?? base?.completionTokens;
  const cacheReadTokens = next.cacheReadTokens ?? base?.cacheReadTokens;
  const cacheWriteTokens = next.cacheWriteTokens ?? base?.cacheWriteTokens;
  const reasoningTokens = next.reasoningTokens ?? base?.reasoningTokens;
  const totalTokens =
    promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : (next.totalTokens ?? base?.totalTokens);

  return compactDefined({
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  }) as ProviderUsage;
}
