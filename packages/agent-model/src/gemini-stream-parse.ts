/**
 * Gemini streamGenerateContent SSE 解析 → ProviderStreamEvent。
 * 对照 litellm / Google AI Studio：candidates[].content.parts text | functionCall。
 */

import type { JsonObject } from '@crish/shared-types';
import {
  isSseReadDiagnostic,
  readSseJson,
  type SseDiagnosticsOptions,
} from './openai-stream-parse';
import type { ProviderStreamEvent, ProviderUsage } from '@crish/shared-types';

/**
 * Parse Gemini streamGenerateContent SSE body into ProviderStreamEvent.
 * Emits text-delta / thought-delta / tool-call / stop (never silent empty complete).
 */
export async function* parseGeminiStreamingResponse(
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

  let stopReason: ProviderStreamEvent & { type: 'stop' } = {
    type: 'stop',
    reason: 'stop',
  };
  let usage: ProviderUsage | undefined;
  let emittedContent = false;
  let sawTerminal = false;
  let toolCallCount = 0;
  let streamError: string | undefined;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: 'provider-diagnostic', diagnostic: payload.diagnostic };
      continue;
    }

    // Top-level error object (some proxies / API error frames)
    const topError = geminiPayloadError(payload);
    if (topError) {
      yield {
        type: 'stop',
        reason: 'error',
        error: topError,
        ...(usage !== undefined ? { usage } : {}),
      };
      return;
    }

    // promptFeedback.blockReason without candidates → blocked
    const block = promptBlockReason(payload);
    if (block && !hasCandidates(payload)) {
      const blockUsage = parseGeminiUsage(payload.usageMetadata) ?? usage;
      yield {
        type: 'stop',
        reason: 'error',
        error: block,
        ...(blockUsage !== undefined ? { usage: blockUsage } : {}),
      };
      return;
    }

    const usageChunk = parseGeminiUsage(payload.usageMetadata);
    if (usageChunk) {
      usage = mergeGeminiUsage(usage, usageChunk);
    }

    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates
      : [];
    for (const raw of candidates) {
      if (!raw || typeof raw !== 'object') continue;
      const candidate = raw as Record<string, unknown>;

      const content =
        candidate.content && typeof candidate.content === 'object'
          ? (candidate.content as Record<string, unknown>)
          : undefined;
      const parts = Array.isArray(content?.parts) ? content!.parts : [];

      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== 'object') continue;
        const part = rawPart as Record<string, unknown>;

        // Thought / reasoning text
        if (
          part.thought === true &&
          typeof part.text === 'string' &&
          part.text
        ) {
          emittedContent = true;
          yield { type: 'thought-delta', text: part.text };
          continue;
        }

        if (typeof part.text === 'string' && part.text) {
          emittedContent = true;
          yield { type: 'text-delta', text: part.text };
          continue;
        }

        const functionCall =
          part.functionCall && typeof part.functionCall === 'object'
            ? (part.functionCall as Record<string, unknown>)
            : part.function_call && typeof part.function_call === 'object'
              ? (part.function_call as Record<string, unknown>)
              : undefined;

        if (functionCall) {
          const name =
            typeof functionCall.name === 'string' ? functionCall.name : '';
          if (!name) continue;
          emittedContent = true;
          toolCallCount += 1;
          const args = normalizeFunctionArgs(
            functionCall.args ?? functionCall.arguments
          );
          const id =
            typeof functionCall.id === 'string' && functionCall.id
              ? functionCall.id
              : `gemini_fc_${toolCallCount}`;
          yield {
            type: 'tool-call',
            id,
            toolName: name,
            input: args,
          };
        }
      }

      if (
        candidate.finishReason !== undefined &&
        candidate.finishReason !== null
      ) {
        sawTerminal = true;
        const mapped = geminiFinishReasonToStop(
          candidate.finishReason,
          toolCallCount > 0
        );
        stopReason = { type: 'stop', reason: mapped.reason };
        if (mapped.error) {
          streamError = mapped.error;
        }
      }
    }
  }

  if (toolCallCount > 0 && stopReason.reason === 'stop') {
    stopReason = { type: 'stop', reason: 'tool-call' };
  }

  if (!emittedContent && !sawTerminal && !usage) {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'Gemini streaming response completed without content events',
    };
    return;
  }

  if (streamError && stopReason.reason === 'error') {
    yield {
      type: 'stop',
      reason: 'error',
      error: streamError,
      ...(usage !== undefined ? { usage } : {}),
    };
    return;
  }

  yield {
    ...stopReason,
    ...(streamError && stopReason.reason === 'error'
      ? { error: streamError }
      : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/** Parse a non-streaming Gemini generateContent JSON response. */
export async function* parseGeminiJsonResponse(
  body: JsonObject
): AsyncIterable<ProviderStreamEvent> {
  const error = geminiPayloadError(body);
  if (error) {
    yield { type: 'stop', reason: 'error', error };
    return;
  }

  const block = promptBlockReason(body);
  if (block && !hasCandidates(body)) {
    const parseUsage = parseGeminiUsage(body.usageMetadata);
    yield {
      type: 'stop',
      reason: 'error',
      error: block,
      ...(parseUsage !== undefined ? { usage: parseUsage } : {}),
    };
    return;
  }

  let emitted = false;
  let toolCallCount = 0;
  let finishReason: unknown;
  let streamError: string | undefined;

  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.finishReason !== undefined) {
      finishReason = candidate.finishReason;
    }

    const content =
      candidate.content && typeof candidate.content === 'object'
        ? (candidate.content as Record<string, unknown>)
        : undefined;
    const parts = Array.isArray(content?.parts) ? content!.parts : [];

    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = rawPart as Record<string, unknown>;

      if (part.thought === true && typeof part.text === 'string' && part.text) {
        emitted = true;
        yield { type: 'thought-delta', text: part.text };
        continue;
      }

      if (typeof part.text === 'string' && part.text) {
        emitted = true;
        yield { type: 'text-delta', text: part.text };
        continue;
      }

      const functionCall =
        part.functionCall && typeof part.functionCall === 'object'
          ? (part.functionCall as Record<string, unknown>)
          : undefined;

      if (functionCall) {
        const name =
          typeof functionCall.name === 'string' ? functionCall.name : '';
        if (!name) continue;
        emitted = true;
        toolCallCount += 1;
        yield {
          type: 'tool-call',
          id:
            typeof functionCall.id === 'string' && functionCall.id
              ? functionCall.id
              : `gemini_fc_${toolCallCount}`,
          toolName: name,
          input: normalizeFunctionArgs(functionCall.args),
        };
      }
    }
  }

  const usage = parseGeminiUsage(body.usageMetadata);
  const mapped = geminiFinishReasonToStop(finishReason, toolCallCount > 0);
  if (mapped.error) streamError = mapped.error;

  if (!emitted && mapped.reason === 'error') {
    yield {
      type: 'stop',
      reason: 'error',
      error: streamError ?? 'Gemini response did not include content',
      ...(usage !== undefined ? { usage } : {}),
    };
    return;
  }

  if (!emitted && !usage) {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'Gemini response did not include content',
    };
    return;
  }

  const reason =
    toolCallCount > 0 && mapped.reason === 'stop' ? 'tool-call' : mapped.reason;

  yield {
    type: 'stop',
    reason,
    ...(reason === 'error' && streamError ? { error: streamError } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function geminiFinishReasonToStop(
  reason: unknown,
  hasToolCall: boolean
): { reason: 'stop' | 'tool-call' | 'length' | 'error'; error?: string } {
  if (
    reason == null ||
    reason === '' ||
    reason === 'FINISH_REASON_UNSPECIFIED'
  ) {
    return { reason: hasToolCall ? 'tool-call' : 'stop' };
  }
  const r = String(reason).toUpperCase();
  if (r === 'STOP' || r === 'END_TURN') {
    return { reason: hasToolCall ? 'tool-call' : 'stop' };
  }
  if (r === 'MAX_TOKENS') {
    return { reason: 'length' };
  }
  if (
    r === 'SAFETY' ||
    r === 'RECITATION' ||
    r === 'BLOCKLIST' ||
    r === 'PROHIBITED_CONTENT' ||
    r === 'SPII' ||
    r === 'IMAGE_SAFETY' ||
    r === 'MALFORMED_FUNCTION_CALL' ||
    r === 'OTHER'
  ) {
    return { reason: 'error', error: `Gemini finishReason: ${String(reason)}` };
  }
  return { reason: hasToolCall ? 'tool-call' : 'stop' };
}

export function parseGeminiUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const promptTokens =
    numberField(usage.promptTokenCount) ??
    numberField(usage.prompt_token_count);
  const completionTokens =
    numberField(usage.candidatesTokenCount) ??
    numberField(usage.responseTokenCount) ??
    numberField(usage.candidates_token_count);
  const cacheRead =
    numberField(usage.cachedContentTokenCount) ??
    numberField(usage.cached_content_token_count);
  const reasoningTokens =
    numberField(usage.thoughtsTokenCount) ??
    numberField(usage.thoughts_token_count);
  const total =
    numberField(usage.totalTokenCount) ??
    numberField(usage.total_token_count) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    cacheRead === undefined &&
    reasoningTokens === undefined &&
    total === undefined
  ) {
    return undefined;
  }

  return compactDefined({
    promptTokens,
    completionTokens,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    reasoningTokens,
  }) as unknown as ProviderUsage;
}

export function geminiPayloadError(payload: JsonObject): string | undefined {
  const err = payload.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const record = err as Record<string, unknown>;
    const message =
      typeof record.message === 'string' ? record.message : undefined;
    const status =
      typeof record.status === 'string' ? record.status : undefined;
    const code = record.code;
    if (message && status) return `${status}: ${message}`;
    if (message && code !== undefined) return `${code}: ${message}`;
    if (message) return message;
    if (status) return status;
  }
  return undefined;
}

function promptBlockReason(payload: JsonObject): string | undefined {
  const feedback = payload.promptFeedback;
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback))
    return undefined;
  const record = feedback as Record<string, unknown>;
  const reason = record.blockReason ?? record.block_reason;
  if (reason == null || reason === '' || reason === 'BLOCK_REASON_UNSPECIFIED')
    return undefined;
  const message =
    typeof record.blockReasonMessage === 'string'
      ? record.blockReasonMessage
      : typeof record.block_reason_message === 'string'
        ? record.block_reason_message
        : undefined;
  if (message) return `Gemini prompt blocked (${String(reason)}): ${message}`;
  return `Gemini prompt blocked: ${String(reason)}`;
}

function hasCandidates(payload: JsonObject): boolean {
  return Array.isArray(payload.candidates) && payload.candidates.length > 0;
}

function normalizeFunctionArgs(raw: unknown): JsonObject {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as JsonObject;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonObject;
      }
      return { value: parsed as never };
    } catch (cause) {
      return {
        __rawArguments: raw,
        __parseError: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
  if (raw === undefined || raw === null) return {};
  return { value: raw as never };
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

function mergeGeminiUsage(
  base: ProviderUsage | undefined,
  next: ProviderUsage
): ProviderUsage {
  const promptTokens = next.promptTokens ?? base?.promptTokens;
  const completionTokens = next.completionTokens ?? base?.completionTokens;
  const cacheReadTokens = next.cacheReadTokens ?? base?.cacheReadTokens;
  const cacheWriteTokens = next.cacheWriteTokens ?? base?.cacheWriteTokens;
  const reasoningTokens = next.reasoningTokens ?? base?.reasoningTokens;
  const totalTokens =
    next.totalTokens ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : base?.totalTokens);

  return compactDefined({
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  }) as ProviderUsage;
}
