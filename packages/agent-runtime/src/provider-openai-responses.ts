/**
 * Responses API — 请求构建与响应解析。
 */
import type { JsonObject } from "@crish/shared-types";
import type { ProviderStreamEvent, ProviderUsage } from "./types";
import {
  compactObject,
  reasoningEffortObject,
  toResponsesInput,
  toResponsesTool,
  toResponsesToolChoice,
  type OpenAICompatibleReasoningEffort,
  type OpenAICompatibleReasoningEffortFormat,
  type OpenAICompatibleToolChoice,
} from "./openai-request-build";
import { isSseReadDiagnostic, readSseJson, type SseDiagnosticsOptions } from "./openai-stream-parse";
import type { RequestBuildContext } from "./provider-openai-base";
import { recordField, stringField, formatProviderError } from "./provider-openai-base";

interface ResponsePendingToolCall {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
  argumentsDone?: boolean;
  itemDone?: boolean;
}

export function buildResponsesRequestBody(
  opts: {
    model: string;
    stream?: boolean;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: OpenAICompatibleReasoningEffort;
    reasoningEffortFormat?: OpenAICompatibleReasoningEffortFormat;
    toolChoice?: OpenAICompatibleToolChoice;
  },
  context: RequestBuildContext,
): JsonObject {
  const { request, wireMode } = context;
  return compactObject({
    model: opts.model,
    stream: opts.stream,
    temperature: opts.temperature,
    top_p: opts.topP,
    max_output_tokens: opts.maxTokens,
    ...reasoningEffortObject("responses", opts.model, opts.reasoningEffort, opts.reasoningEffortFormat),
    input: toResponsesInput(request.systemPrompt, request.messages, wireMode),
    tools: request.tools.length > 0 ? request.tools.map(toResponsesTool) : undefined,
    tool_choice: request.tools.length > 0 ? toResponsesToolChoice(opts.toolChoice ?? "auto") : undefined,
  });
}

export async function* parseResponsesJsonResponse(body: JsonObject): AsyncIterable<ProviderStreamEvent> {
  const output = Array.isArray(body.output) ? body.output : [];
  let sawToolCall = false;
  for (const item of output) {
    for (const event of responseOutputItemEvents(item)) {
      if (event.type === "tool-call") sawToolCall = true;
      yield event;
    }
  }
  yield compactObject({ type: "stop", reason: sawToolCall ? "tool-call" : responseStatusToStop(body), error: responseError(body), usage: parseUsage(body.usage) }) as ProviderStreamEvent;
}

export async function* parseResponsesStreamingResponse(
  response: Response,
  diagnostics?: SseDiagnosticsOptions,
  signal?: AbortSignal
): AsyncIterable<ProviderStreamEvent> {
  if (!response.body) { yield { type: "stop", reason: "error", error: "Streaming response body is empty" }; return; }
  const pending = new Map<string, ResponsePendingToolCall>();
  const emitted = new Set<string>();
  let usage: ProviderUsage | undefined;
  let finalReason: "stop" | "tool-call" | "length" | "error" = "stop";
  let finalError: string | undefined;
  let sawToolCall = false;
  let sawTerminal = false;
  let modelMismatchReported = false;

  for await (const payload of readSseJson(response.body, diagnostics, signal)) {
    if (isSseReadDiagnostic(payload)) { yield { type: "provider-diagnostic", diagnostic: payload.diagnostic }; continue; }
    if (!modelMismatchReported) {
      const mm = modelMismatchStreamEvent(actualModelFromPayload(payload), diagnostics);
      if (mm) { modelMismatchReported = true; yield mm; }
    }
    const type = typeof payload.type === "string" ? payload.type : "";
    usage = parseUsage(payload.usage) ?? parseUsage(recordField(payload.response, "usage")) ?? usage;

    if (type === "error") { yield { type: "stop", reason: "error", error: responseError(payload) ?? stringField(payload.message) ?? stringField(payload.code) ?? "Responses stream emitted an error event", ...(usage !== undefined ? { usage } : {}) }; return; }
    if (type === "response.output_text.delta" && typeof payload.delta === "string" && payload.delta.length > 0) { yield { type: "text-delta", text: payload.delta }; continue; }
    if (isResponsesThoughtDelta(type) && typeof payload.delta === "string" && payload.delta.length > 0) { yield { type: "thought-delta", text: payload.delta, redacted: true }; continue; }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const call = mergeResponseToolCallItem(pending, payload.item);
      if (type === "response.output_item.done") {
        if (call) call.itemDone = true;
        const event = call && (call.argumentsDone || call.argumentsText.trim()) ? emitResponseToolCall(call, emitted) : undefined;
        if (event) { sawToolCall = true; yield event; }
      }
      continue;
    }
    if (type === "response.function_call_arguments.delta") { mergeResponseToolCallArguments(pending, payload, "append"); continue; }
    if (type === "response.function_call_arguments.done") {
      const call = mergeResponseToolCallArguments(pending, payload, "replace");
      if (call) call.argumentsDone = true;
      const event = emitResponseToolCall(call, emitted);
      if (event) { sawToolCall = true; yield event; }
      continue;
    }
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      sawTerminal = true;
      const responsePayload = recordField(payload.response, undefined);
      usage = parseUsage(recordField(responsePayload, "usage")) ?? usage;
      finalReason = responseStatusToStop(responsePayload ?? payload);
      finalError = responseError(responsePayload ?? payload);
      for (const item of responseOutputItems(responsePayload)) mergeResponseToolCallItem(pending, item);
    }
  }

  for (const call of pending.values()) { const event = emitResponseToolCall(call, emitted); if (event) sawToolCall = true; }
  if (!sawTerminal) { yield compactObject({ type: "stop", reason: "error", error: formatProviderError("Responses stream ended without a terminal response event", "invalid-stream"), usage }) as ProviderStreamEvent; return; }
  yield compactObject({ type: "stop", reason: sawToolCall ? "tool-call" : finalReason, error: finalError, usage }) as ProviderStreamEvent;
}

function* responseOutputItemEvents(item: unknown): Iterable<ProviderStreamEvent> {
  const record = recordField(item, undefined);
  if (!record) return;
  if (record.type === "message") {
    for (const part of responseContentParts(record.content)) {
      const content = recordField(part, undefined);
      if (!content) continue;
      if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string" && content.text.length > 0) yield { type: "text-delta", text: content.text };
    }
    return;
  }
  if (record.type === "function_call") {
    const name = stringField(record.name);
    if (!name) return;
    const toolCallId = stringField(record.call_id) ?? stringField(record.id);
    yield { type: "tool-call", toolName: name, input: parseArguments(stringField(record.arguments) ?? ""), ...(toolCallId !== undefined ? { id: toolCallId } : {}) };
    return;
  }
  if (record.type === "reasoning") {
    for (const part of responseContentParts(record.summary)) { const content = recordField(part, undefined); const text = stringField(content?.text); if (text) yield { type: "thought-delta", text, redacted: true }; }
  }
}

function responseContentParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [{ type: "text", text: value }];
  return [];
}

function responseOutputItems(response: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(response?.output) ? response.output : [];
}

function mergeResponseToolCallItem(pending: Map<string, ResponsePendingToolCall>, item: unknown): ResponsePendingToolCall | undefined {
  const record = recordField(item, undefined);
  if (!record || record.type !== "function_call") return undefined;
  const itemId = stringField(record.id);
  const callId = stringField(record.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId ?? `response_call_${pending.size}`;
  const current = pending.get(key) ?? { id: itemId ?? callId ?? key, callId: callId ?? itemId ?? key, name: "", argumentsText: "" };
  current.callId = callId ?? current.callId;
  current.name = stringField(record.name) ?? current.name;
  if (typeof record.arguments === "string") current.argumentsText = record.arguments;
  pending.set(key, current);
  return current;
}

function mergeResponseToolCallArguments(pending: Map<string, ResponsePendingToolCall>, payload: JsonObject, mode: "append" | "replace"): ResponsePendingToolCall | undefined {
  const itemId = stringField(payload.item_id);
  const callId = stringField(payload.call_id);
  const key = findResponseToolCallKey(pending, itemId, callId) ?? itemId ?? callId;
  if (!key) return undefined;
  const current = pending.get(key) ?? { id: itemId ?? key, callId: callId ?? key, name: "", argumentsText: "" };
  const argumentsText = stringField(payload.arguments) ?? stringField(payload.delta);
  if (argumentsText !== undefined) current.argumentsText = mode === "append" ? current.argumentsText + argumentsText : argumentsText;
  pending.set(key, current);
  return current;
}

function findResponseToolCallKey(pending: Map<string, ResponsePendingToolCall>, itemId: string | undefined, callId: string | undefined): string | undefined {
  if (itemId && pending.has(itemId)) return itemId;
  if (callId && pending.has(callId)) return callId;
  if (callId) { for (const [key, call] of pending.entries()) { if (call.callId === callId) return key; } }
  return undefined;
}

function emitResponseToolCall(call: ResponsePendingToolCall | undefined, emitted: Set<string>): any {
  const emittedKey = call?.callId || call?.id;
  if (!call || !call.name || !emittedKey || emitted.has(emittedKey)) return undefined;
  emitted.add(emittedKey);
  return { type: "tool-call", id: call.callId || call.id, toolName: call.name, input: parseArguments(call.argumentsText) };
}

function isResponsesThoughtDelta(type: string): boolean {
  return type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta" || type === "response.reasoning.delta";
}

function responseStatusToStop(body: Record<string, unknown> | undefined): "stop" | "tool-call" | "length" | "error" {
  const status = body?.status;
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "error";
  return "stop";
}

function responseError(body: Record<string, unknown> | undefined): string | undefined {
  const error = recordField(body?.error, undefined);
  return stringField(error?.message) ?? stringField(body?.error);
}

function parseUsage(raw: unknown): ProviderUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const details = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" ? (usage.prompt_tokens_details as Record<string, unknown>) : undefined) ?? (usage.input_tokens_details && typeof usage.input_tokens_details === "object" ? (usage.input_tokens_details as Record<string, unknown>) : undefined) ?? {};
  const completionDetails = (usage.completion_tokens_details && typeof usage.completion_tokens_details === "object" ? (usage.completion_tokens_details as Record<string, unknown>) : undefined) ?? (usage.output_tokens_details && typeof usage.output_tokens_details === "object" ? (usage.output_tokens_details as Record<string, unknown>) : undefined) ?? {};
  return compactObject({
    promptTokens: numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    completionTokens: numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    totalTokens: numberField(usage.total_tokens),
    cacheReadTokens: numberField(details.cached_tokens),
    reasoningTokens: numberField(completionDetails.reasoning_tokens)
  }) as ProviderUsage;
}

function numberField(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function actualModelFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return stringField(payload.model) ?? stringField(recordField(payload.response, undefined)?.model);
}

function modelMismatchStreamEvent(actualModel: string | undefined, diagnostics: SseDiagnosticsOptions | undefined): any {
  if (!actualModel || !diagnostics?.enabled || !diagnostics.configuredModel || actualModel === diagnostics.configuredModel) return undefined;
  return { type: "provider-diagnostic", diagnostic: { phase: "model-mismatch", providerId: diagnostics.providerId, endpoint: diagnostics.endpoint, url: diagnostics.url, attempt: diagnostics.attempt, maxAttempts: diagnostics.maxAttempts, configuredModel: diagnostics.configuredModel, actualModel, modelMismatch: true, reason: "Provider response model differed from the configured request model; keeping the configured model for session state." } };
}

function parseArguments(input: string): any {
  if (!input.trim()) return {};
  try { const parsed = JSON.parse(input); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; return { value: parsed }; } catch { return {}; }
}
