/**
 * Chat Completions API — 请求构建与响应解析? */
import type { JsonObject } from '@crish/shared-types';
import type { ProviderStreamEvent, ProviderUsage } from '@crish/shared-types';
import {
  compactObject,
  maxTokensObject,
  reasoningEffortObject,
  toChatMessages,
  toChatToolChoice,
  toOpenAITool,
  type OpenAICompatibleMaxTokensField,
  type OpenAICompatibleReasoningContentMode,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
} from './openai-request-build';
import {
  isSseReadDiagnostic,
  readSseJson,
  type SseDiagnosticsOptions,
} from './openai-stream-parse';
import type { RequestBuildContext } from './provider-openai-base';
import { recordField, stringField } from './provider-openai-base';

interface PendingToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export function buildChatCompletionsRequestBody(
  opts: {
    model: string;
    stream?: boolean;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    maxTokensField?: OpenAICompatibleMaxTokensField;
    reasoningEffort?: OpenAICompatibleReasoningEffort;
    reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
    reasoningContent?: OpenAICompatibleReasoningContentMode;
    toolChoice?: OpenAICompatibleToolChoice;
  },
  context: RequestBuildContext
): JsonObject {
  const { request, wireMode } = context;
  return compactObject({
    model: opts.model,
    stream: opts.stream,
    temperature: opts.temperature,
    top_p: opts.topP,
    ...(opts.maxTokensField
      ? maxTokensObject(opts.maxTokensField, opts.maxTokens)
      : {}),
    ...reasoningEffortObject(
      'chat-completions',
      opts.model,
      opts.reasoningEffort,
      opts.reasoningEffortFormat
    ),
    messages: toChatMessages(
      request.systemPrompt,
      request.messages,
      opts.reasoningContent ?? 'omit',
      wireMode
    ),
    tools:
      request.tools.length > 0 ? request.tools.map(toOpenAITool) : undefined,
    tool_choice:
      request.tools.length > 0
        ? toChatToolChoice(opts.toolChoice ?? 'auto')
        : undefined,
    stream_options: opts.stream !== false ? { include_usage: true } : undefined,
  });
}

export async function* parseChatCompletionsJsonResponse(
  body: JsonObject
): AsyncIterable<ProviderStreamEvent> {
  const error = providerBodyError(body);
  if (error) {
    yield { type: 'stop', reason: 'error', error };
    return;
  }
  const choice = Array.isArray(body.choices)
    ? (body.choices[0] as Record<string, unknown> | undefined)
    : undefined;
  const message =
    choice?.message && typeof choice.message === 'object'
      ? (choice.message as Record<string, unknown>)
      : undefined;
  if (!message) {
    yield {
      type: 'stop',
      reason: 'error',
      error: 'OpenAI-compatible response did not include a message',
    };
    return;
  }
  if (
    typeof message.reasoning_content === 'string' &&
    message.reasoning_content.length > 0
  )
    yield { type: 'thought-delta', text: message.reasoning_content };
  if (typeof message.content === 'string' && message.content.length > 0)
    yield { type: 'text-delta', text: message.content };
  if (Array.isArray(message.tool_calls)) {
    for (const rawCall of message.tool_calls) {
      const call = parseFullToolCall(rawCall);
      if (call)
        yield {
          type: 'tool-call',
          id: call.id,
          toolName: call.name,
          input: parseArguments(call.argumentsText),
        };
    }
  }
  const finalUsage = parseUsage(body.usage);
  yield {
    type: 'stop',
    reason: finishReasonToStop(choice?.finish_reason),
    ...(finalUsage !== undefined ? { usage: finalUsage } : {}),
  };
}

export async function* parseChatCompletionsStreamingResponse(
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
  const pending = new Map<number, PendingToolCall>();
  let finishReason: ProviderStreamEvent & { type: 'stop' } = {
    type: 'stop',
    reason: 'stop',
  };
  let usage: ProviderUsage | undefined;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) {
      yield { type: 'provider-diagnostic', diagnostic: payload.diagnostic };
      continue;
    }
    if (!modelMismatchReported) {
      const mm = modelMismatchStreamEvent(
        actualModelFromPayload(payload),
        diagnostics
      );
      if (mm) {
        modelMismatchReported = true;
        yield mm;
      }
    }
    const payloadError = providerBodyError(payload);
    if (payloadError) {
      yield { type: 'stop', reason: 'error', error: payloadError };
      return;
    }
    usage = parseUsage(payload.usage) ?? usage;
    const choice = Array.isArray(payload.choices)
      ? (payload.choices[0] as Record<string, unknown> | undefined)
      : undefined;
    const delta =
      choice?.delta && typeof choice.delta === 'object'
        ? (choice.delta as Record<string, unknown>)
        : undefined;
    if (!choice || !delta) continue;
    if (typeof delta.content === 'string' && delta.content.length > 0)
      yield { type: 'text-delta', text: delta.content };
    if (
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content.length > 0
    )
      yield { type: 'thought-delta', text: delta.reasoning_content };
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) mergeToolCallDelta(pending, raw);
    }
    if (choice.finish_reason)
      finishReason = {
        type: 'stop',
        reason: finishReasonToStop(choice.finish_reason),
      };
  }
  for (const call of pending.values()) {
    if (call.name)
      yield {
        type: 'tool-call',
        id: call.id,
        toolName: call.name,
        input: parseArguments(call.argumentsText),
      };
  }
  yield { ...finishReason, ...(usage !== undefined ? { usage } : {}) };
}

function mergeToolCallDelta(
  pending: Map<number, PendingToolCall>,
  raw: unknown
): void {
  if (!raw || typeof raw !== 'object') return;
  const record = raw as Record<string, unknown>;
  const index = typeof record.index === 'number' ? record.index : pending.size;
  const current = pending.get(index) ?? {
    id: `call_${index}`,
    name: '',
    argumentsText: '',
  };
  if (typeof record.id === 'string') current.id = record.id;
  const fn =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : undefined;
  if (typeof fn?.name === 'string') current.name = fn.name;
  if (typeof fn?.arguments === 'string') current.argumentsText += fn.arguments;
  pending.set(index, current);
}

function parseFullToolCall(raw: unknown): PendingToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const fn =
    record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : undefined;
  if (!fn || typeof fn.name !== 'string') return null;
  return {
    id: typeof record.id === 'string' ? record.id : `call_${fn.name}`,
    name: fn.name,
    argumentsText: typeof fn.arguments === 'string' ? fn.arguments : '{}',
  };
}

function parseArguments(input: string): any {
  if (!input.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed;
    return { value: parsed };
  } catch (cause) {
    return {
      __rawArguments: input,
      __parseError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function finishReasonToStop(
  reason: unknown
): 'stop' | 'tool-call' | 'length' | 'error' {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool-call';
  if (reason === 'length') return 'length';
  if (reason === 'stop' || reason == null) return 'stop';
  return 'error';
}

function parseUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const details =
    (usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === 'object'
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.input_tokens_details &&
    typeof usage.input_tokens_details === 'object'
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  const completionDetails =
    (usage.completion_tokens_details &&
    typeof usage.completion_tokens_details === 'object'
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : undefined) ??
    (usage.output_tokens_details &&
    typeof usage.output_tokens_details === 'object'
      ? (usage.output_tokens_details as Record<string, unknown>)
      : undefined) ??
    {};
  return compactObject({
    promptTokens:
      numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    completionTokens:
      numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    totalTokens: numberField(usage.total_tokens),
    cacheReadTokens: numberField(details.cached_tokens),
    reasoningTokens: numberField(completionDetails.reasoning_tokens),
  }) as ProviderUsage;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function actualModelFromPayload(
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (!payload) return undefined;
  return (
    stringField(payload.model) ??
    stringField(recordField(payload.response, undefined)?.model)
  );
}

function modelMismatchStreamEvent(
  actualModel: string | undefined,
  diagnostics: SseDiagnosticsOptions | undefined
): any {
  if (
    !actualModel ||
    !diagnostics?.enabled ||
    !diagnostics.configuredModel ||
    actualModel === diagnostics.configuredModel
  )
    return undefined;
  return {
    type: 'provider-diagnostic',
    diagnostic: {
      phase: 'model-mismatch',
      providerId: diagnostics.providerId,
      endpoint: diagnostics.endpoint,
      url: diagnostics.url,
      attempt: diagnostics.attempt,
      maxAttempts: diagnostics.maxAttempts,
      configuredModel: diagnostics.configuredModel,
      actualModel,
      modelMismatch: true,
      reason:
        'Provider response model differed from the configured request model; keeping the configured model for session state.',
    },
  };
}

function providerBodyError(
  body: Record<string, unknown> | undefined
): string | undefined {
  if (!body) return undefined;
  const error =
    body.error && typeof body.error === 'object'
      ? stringField((body.error as Record<string, unknown>).message)
      : stringField(body.error);
  return (
    error ??
    stringField(body.message) ??
    stringField(body.error_description) ??
    stringField(body.code)
  );
}
