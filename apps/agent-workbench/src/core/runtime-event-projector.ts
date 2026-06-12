import {
  approvalIdFromEvent,
  normalizeWorkbenchEvent,
  normalizeWorkbenchApprovalMetadata,
  workbenchRunLifecycleStatusFromDaemon,
  type DaemonOrchestratorEvent,
  type WorkbenchApprovalMetadata,
  type WorkbenchApprovalMetadataSource,
  type WorkbenchApprovalRiskLevel,
} from "../shared/workbench-contract";
import { projectJsonCoreEvent } from "./core-event-json-adapter";
import type { CoreAgentEvent } from "@crish/agent-runtime";

export type RuntimeProjectionRole = "user" | "assistant" | "system";
export type RuntimeProjectionToolStatus = "pending" | "approved" | "denied" | "running" | "completed" | "failed";
export type RuntimeProjectionRunStatus = "completed" | "cancelled" | "failed" | "running";

export interface RuntimeProjectionToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  status: RuntimeProjectionToolStatus;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  riskLevel?: WorkbenchApprovalRiskLevel;
  riskRule?: string;
  riskDetail?: string;
  riskSource?: WorkbenchApprovalMetadataSource;
  matched?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  checkpointId?: string;
  snapshotId?: string;
  approvalMetadata?: WorkbenchApprovalMetadata;
}

export interface RuntimeProjectionMessage {
  id: string;
  role: RuntimeProjectionRole;
  content: string;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  toolCalls?: RuntimeProjectionToolCall[];
  streaming?: boolean;
}

export type RuntimeTimelineDiagnosticSource = "daemon" | "provider" | "transport" | "runtime" | "protocol" | "unknown";

export interface RuntimeTimelineDiagnostic {
  title: string;
  content: string;
  source: RuntimeTimelineDiagnosticSource;
  severity: "error" | "warning" | "info";
}

export interface RuntimeTimelineMessageItem {
  kind: "message";
  id: string;
  order: number;
  timestamp: number;
  message: RuntimeProjectionMessage;
}

export interface RuntimeTimelineDiagnosticItem {
  kind: "diagnostic";
  id: string;
  order: number;
  timestamp: number;
  runId?: string;
  sessionId?: string;
  diagnostic: RuntimeTimelineDiagnostic;
  sourceMessage: RuntimeProjectionMessage;
}

export type RuntimeTimelineItem = RuntimeTimelineMessageItem | RuntimeTimelineDiagnosticItem;

export interface RuntimeProjectionApprovalDelta {
  id: string;
  status: "requested" | "resolved";
  decision?: string;
  toolCall?: RuntimeProjectionToolCall;
}

export interface RuntimeProjectionDelta {
  messages: RuntimeProjectionMessage[];
  updatedMessages: RuntimeProjectionMessage[];
  tools: RuntimeProjectionToolCall[];
  approvals: RuntimeProjectionApprovalDelta[];
  run?: {
    status: RuntimeProjectionRunStatus;
    reason?: string;
    error?: string;
  };
}

export interface RuntimeEventProjectionState {
  messages: RuntimeProjectionMessage[];
  drafts: Record<string, RuntimeProjectionMessage>;
  currentMessageId?: string;
  endedMessageIds: Record<string, true>;
  seenRunPromptIds: Record<string, true>;
}

export interface RuntimeEventProjectionContext {
  eventId?: string;
  runId?: string;
  sessionId?: string;
  timestamp?: string | number;
}

export interface ProjectRuntimeEventOptions extends RuntimeEventProjectionContext {
  sourceEvent?: unknown;
}

type JsonRecord = Record<string, unknown>;

export function createRuntimeEventProjectionState(
  initial?: Partial<RuntimeEventProjectionState>
): RuntimeEventProjectionState {
  return {
    messages: initial?.messages ? [...initial.messages] : [],
    drafts: initial?.drafts ? { ...initial.drafts } : {},
    currentMessageId: initial?.currentMessageId,
    endedMessageIds: initial?.endedMessageIds ? { ...initial.endedMessageIds } : {},
    seenRunPromptIds: initial?.seenRunPromptIds ? { ...initial.seenRunPromptIds } : {},
  };
}

export function projectDaemonOrchestratorEvents(
  events: DaemonOrchestratorEvent[],
  initial?: Partial<RuntimeEventProjectionState>
): RuntimeEventProjectionState {
  const state = createRuntimeEventProjectionState(initial);
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    projectDaemonOrchestratorEvent(state, event);
  }
  flushRuntimeProjectionDrafts(state);
  return state;
}

export function replayRuntimeEvents(
  events: DaemonOrchestratorEvent[],
  initial?: Partial<RuntimeEventProjectionState>
): RuntimeEventProjectionState {
  return projectDaemonOrchestratorEvents(events, initial);
}

export function materializeRuntimeProjectionMessages(
  state: RuntimeEventProjectionState
): RuntimeProjectionMessage[] {
  return [...state.messages, ...Object.values(state.drafts).filter((draft) => draft.content || draft.toolCalls?.length)];
}

export function materializeRuntimeTimelineItems(state: RuntimeEventProjectionState): RuntimeTimelineItem[] {
  return timelineItemsFromRuntimeProjectionMessages(materializeRuntimeProjectionMessages(state));
}

export function timelineItemsFromRuntimeProjectionMessages(messages: RuntimeProjectionMessage[]): RuntimeTimelineItem[] {
  return messages
    .filter((message) => message.content.trim() !== "" || (message.toolCalls?.length ?? 0) > 0)
    .map((message, order) => {
      const diagnostic = classifyRuntimeDiagnosticContent(message.content);
      if (diagnostic) {
        return {
          kind: "diagnostic" as const,
          id: `diagnostic-${message.id}`,
          order,
          timestamp: message.timestamp,
          runId: message.runId,
          sessionId: message.sessionId,
          diagnostic,
          sourceMessage: message,
        };
      }
      return {
        kind: "message" as const,
        id: `message-${message.id}`,
        order,
        timestamp: message.timestamp,
        message,
      };
    });
}

export function classifyRuntimeDiagnosticContent(content: string): RuntimeTimelineDiagnostic | null {
  if (!content.trim()) return null;
  const normalized = content.toLowerCase();
  const matches = (tokens: string[]) => tokens.some((token) => normalized.includes(token));
  if (
    matches([
      "sidecar.daemon",
      "failed to send query to daemon",
      "reconnect failed while querying daemon",
      "daemon websocket",
      "process exited before ready line",
    ])
  ) {
    return { title: "后台连接错误", content, source: "daemon", severity: "error" };
  }
  if (matches(["backend protocol failed", "invalid run-task message", "unexpected field", "protocol-error"])) {
    return { title: "协议错误", content, source: "protocol", severity: "error" };
  }
  if (matches(["fetch transport failed", "rust request fallback failed", "provider request timed out"])) {
    return { title: "模型传输错误", content, source: "transport", severity: "error" };
  }
  if (matches(["system messages are not allowed", "chat/completions", "responses api"])) {
    return { title: "模型接口错误", content, source: "provider", severity: "error" };
  }
  if (matches(["<!doctype html", "&lt;!doctype html", "<html", "&lt;html"])) {
    return { title: "上游网关错误", content, source: "transport", severity: "error" };
  }
  if (content.startsWith("[错误]") || matches(["runtime error", "run failed"])) {
    return { title: "运行时错误", content, source: "runtime", severity: "error" };
  }
  return null;
}

export function projectDaemonOrchestratorEvent(
  state: RuntimeEventProjectionState,
  event: DaemonOrchestratorEvent
): RuntimeProjectionDelta {
  if (event.type === "run-queued") {
    return projectRunQueuedEvent(state, event);
  }

  if (event.type === "run-failed") {
    const status = runStatusFromDaemonEvent(event) ?? "failed";
    const errorText = stringValue(event.payload.error) ?? "Run failed";
    if (errorText.toLowerCase() === "aborted") {
      return emptyDelta({ run: { status, reason: "cancelled", error: errorText } });
    }
    const message = appendMessage(state, {
      id: `daemon-error-${event.id}`,
      role: "system",
      content: errorText,
      timestamp: parseTimestamp(event.timestamp),
      runId: event.runId,
      sessionId: event.sessionId,
    });
    return emptyDelta({ messages: [message], run: { status, reason: runReasonFromDaemonEvent(event), error: message.content } });
  }

  if (event.type === "run-completed") {
    return emptyDelta({ run: { status: runStatusFromDaemonEvent(event) ?? "completed", reason: runReasonFromDaemonEvent(event) } });
  }

  if (event.type === "run-cancelled") {
    return emptyDelta({ run: { status: runStatusFromDaemonEvent(event) ?? "cancelled", reason: runReasonFromDaemonEvent(event) } });
  }

  if (event.type !== "runtime-event") return emptyDelta();
  const runtimeEvent = payloadRecord(event.payload, "event");
  if (!runtimeEvent) return emptyDelta();
  return projectRuntimeEvent(state, runtimeEvent, {
    eventId: event.id,
    runId: event.runId,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    sourceEvent: event,
  });
}

export function projectRuntimeEvent(
  state: RuntimeEventProjectionState,
  runtimeEvent: JsonRecord,
  options: ProjectRuntimeEventOptions = {}
): RuntimeProjectionDelta {
  runtimeEvent = normalizeWorkbenchEvent(runtimeEvent) as JsonRecord;

  // Route through the Core Event Projector (6-domain contract)
  const coreEvent = projectJsonCoreEvent(runtimeEvent, {
    sessionId: options.sessionId,
    runId: options.runId,
    timestamp: options.timestamp,
  });
  if (!coreEvent) return emptyDelta();

  return projectCoreAgentEvent(state, coreEvent, options);
}

/**
 * Project a CoreAgentEvent (6-domain) into the runtime projection state.
 *
 * This is the unified entry point for all runtime event processing.
 * Instead of switching on 24 raw event types, we switch on 6 domains
 * (agent, turn, message, tool, compression, diagnostic) and then
 * inspect the phase for domain-specific behavior.
 */
function projectCoreAgentEvent(
  state: RuntimeEventProjectionState,
  coreEvent: CoreAgentEvent,
  options: ProjectRuntimeEventOptions
): RuntimeProjectionDelta {
  switch (coreEvent.type) {
    // ─── Agent domain ──────────────────────────────────────
    case "agent": {
      if (coreEvent.phase === "end") {
        const status = mapAgentEndReasonToRunStatus(coreEvent.meta.reason);
        const messages = flushRuntimeProjectionDrafts(state).map((message) => {
          message.streaming = false;
          return message;
        });
        return emptyDelta({
          messages,
          run: { status, reason: coreEvent.meta.reason, error: coreEvent.meta.error },
        });
      }
      // agent-start and intervention-required have no projection state impact
      return emptyDelta();
    }

    // ─── Turn domain ───────────────────────────────────────
    case "turn":
      // Turn lifecycle events don't affect projection state
      return emptyDelta();

    // ─── Message domain ────────────────────────────────────
    case "message": {
      if (coreEvent.phase === "start") {
        return projectMessageStartFromCore(state, coreEvent, options);
      }
      if (coreEvent.phase === "delta") {
        return projectMessageDeltaFromCore(state, coreEvent, options);
      }
      if (coreEvent.phase === "end") {
        return projectMessageEndFromCore(state, coreEvent, options);
      }
      return emptyDelta();
    }

    // ─── Tool domain ───────────────────────────────────────
    case "tool": {
      if (coreEvent.phase === "start") {
        // Single tool-start (has call) or batch-start (has calls)
        if (coreEvent.meta.call) {
          const tool = toolCallFromCall(coreEvent.meta.call as unknown as JsonRecord, options, "running");
          if (!tool) return emptyDelta();
          attachToolCall(state, tool);
          return emptyDelta({ tools: [tool], updatedMessages: messagesContainingTool(state, tool.id) });
        }
        return emptyDelta();
      }
      if (coreEvent.phase === "delta") {
        // Unified: "delta" replaces internal "update"
        const toolId = coreEvent.meta.toolCallId ?? "";
        const update = coreEvent.meta.update as unknown as JsonRecord | undefined;
        const text = stringValue(update?.text) ?? stringValue(update?.message) ?? "";
        if (!toolId || !text) return emptyDelta();
        const updated = updateToolCall(state, toolId, (tool) => {
          tool.output = `${tool.output ?? ""}${text}`;
        });
        return emptyDelta({ updatedMessages: updated });
      }
      if (coreEvent.phase === "end") {
        // Single tool-end (has result) or batch-end (has batchResults)
        if (coreEvent.meta.result) {
          const result = coreEvent.meta.result as unknown as JsonRecord;
          const toolId = stringValue(result.id);
          if (!toolId) return emptyDelta();
          const status: RuntimeProjectionToolStatus = result.isError === true ? "failed" : "completed";
          const updated = updateToolCall(state, toolId, (tool) => {
            tool.status = status;
            tool.output = outputText(payloadRecord(result, "output"));
          });
          const tool = toolCallFromResult(result, options, status);
          return emptyDelta({ tools: tool ? [tool] : [], updatedMessages: updated });
        }
        return emptyDelta();
      }
      return emptyDelta();
    }

    // ─── Compression domain ────────────────────────────────
    case "compression":
      // Compression events don't affect message/tool projection state
      return emptyDelta();

    // ─── Diagnostic domain ─────────────────────────────────
    case "diagnostic": {
      const meta = coreEvent.meta;

      // approval-requested
      if (meta.originalType === "approval-requested") {
        const details = meta.details as { kind: string; request?: JsonRecord } | undefined;
        const request = details?.request;
        const runtimeEvent = { request, ...meta } as unknown as JsonRecord;
        const tool = toolCallFromApproval(request, runtimeEvent, options);
        if (!tool) return emptyDelta();
        attachToolCall(state, tool);
        return emptyDelta({
          tools: [tool],
          approvals: [{ id: tool.id, status: "requested", toolCall: tool }],
          updatedMessages: messagesContainingTool(state, tool.id),
        });
      }

      // approval-resolved
      if (meta.originalType === "approval-resolved") {
        const details = meta.details as { kind: string; requestId?: string; decision?: JsonRecord } | undefined;
        const approvalId = details?.requestId ?? approvalIdFromEvent(meta as unknown as JsonRecord);
        if (!approvalId) return emptyDelta();
        const decisionValue = stringValue(details?.decision) ?? stringValue(meta as unknown as JsonRecord);
        const toolStatus = decisionValue === "denied" || decisionValue === "deny" ? "denied" : "approved";
        const updated = updateToolCall(state, approvalId, (tool) => {
          tool.status = toolStatus;
        });
        return emptyDelta({ approvals: [{ id: approvalId, status: "resolved", decision: decisionValue }], updatedMessages: updated });
      }

      // runtime-error
      if (meta.originalType === "runtime-error") {
        const content = meta.message ?? "Runtime error";
        const current = state.currentMessageId ? state.drafts[state.currentMessageId] : undefined;
        if (current) {
          current.content = `${current.content ? `${current.content}\n` : ""}[错误] ${content}`;
          current.streaming = false;
          if (state.currentMessageId) {
            state.endedMessageIds[state.currentMessageId] = true;
            delete state.drafts[state.currentMessageId];
            state.currentMessageId = undefined;
          }
          const message = appendMessage(state, current);
          return emptyDelta({ messages: [message], run: { status: "failed", error: content } });
        }

        const message = appendMessage(state, {
          id: `daemon-runtime-error-${options.eventId ?? stableSuffix()}`,
          role: "assistant",
          content: `[错误] ${content}`,
          timestamp: parseTimestamp(options.timestamp),
          runId: options.runId,
          sessionId: options.sessionId,
          streaming: false,
        });
        return emptyDelta({ messages: [message], run: { status: "failed", error: content } });
      }

      // run-terminal
      if (meta.originalType === "run-terminal") {
        const details = meta.details as { kind: string; terminal?: string; error?: string } | undefined;
        const terminal = details?.terminal ?? "completed";
        const status: RuntimeProjectionRunStatus =
          terminal === "failed" ? "failed" : terminal === "cancelled" ? "cancelled" : "completed";
        const error = details?.error;
        const flushed = flushRuntimeProjectionDrafts(state).map((msg) => {
          msg.streaming = false;
          return msg;
        });
        return emptyDelta({
          messages: flushed,
          run: { status, error },
        });
      }

      // Other diagnostics (provider-diagnostic, runtime-steering, checkpoint-*, tool-input-repaired)
      // have no projection state impact
      return emptyDelta();
    }
  }
}

// ─── Core-event-aware message projection helpers ────────────

function projectMessageStartFromCore(
  state: RuntimeEventProjectionState,
  coreEvent: CoreAgentEvent,
  options: ProjectRuntimeEventOptions
): RuntimeProjectionDelta {
  const meta = coreEvent.meta as { message?: unknown };
  const message = (meta.message ?? {}) as JsonRecord;
  const messageId = stringValue(message.id) ?? `draft-${options.eventId ?? stableSuffix()}`;
  if (state.endedMessageIds[messageId]) return emptyDelta();
  const draft = messageFromAgentMessage(message, options);
  state.drafts[messageId] =
    draft ??
    createDraftMessage(messageId, {
      ...options,
      timestamp: stringValue(message.createdAt) ?? options.timestamp,
    });
  state.currentMessageId = messageId;
  return emptyDelta({ updatedMessages: [state.drafts[messageId]] });
}

function projectMessageDeltaFromCore(
  state: RuntimeEventProjectionState,
  coreEvent: CoreAgentEvent,
  options: ProjectRuntimeEventOptions
): RuntimeProjectionDelta {
  const meta = coreEvent.meta as { messageId?: string; block?: unknown };
  const messageId = meta.messageId ?? state.currentMessageId ?? `draft-${options.eventId ?? stableSuffix()}`;
  if (state.endedMessageIds[messageId]) return emptyDelta();
  const block = (meta.block ?? {}) as JsonRecord;
  if (!block || !stringValue(block.type)) return emptyDelta();

  const draft = state.drafts[messageId] ?? createDraftMessage(messageId, options);
  const blockType = stringValue(block.type);
  if (blockType === "text" || blockType === "thought") {
    const text = typeof block.text === "string" ? block.text : "";
    draft.content += text;
  }
  if (blockType === "tool-call") {
    const tool = toolCallFromBlock(block, options);
    if (tool) {
      upsertToolCall(draft, tool);
    }
  }
  state.drafts[messageId] = draft;
  state.currentMessageId = messageId;
  return emptyDelta({ updatedMessages: [draft] });
}

function projectMessageEndFromCore(
  state: RuntimeEventProjectionState,
  coreEvent: CoreAgentEvent,
  options: ProjectRuntimeEventOptions
): RuntimeProjectionDelta {
  const meta = coreEvent.meta as { message?: unknown };
  const message = (meta.message ?? {}) as JsonRecord;
  const messageId = stringValue(message.id) ?? state.currentMessageId;
  let projected = messageFromAgentMessage(message, options);
  if (!projected && messageId) projected = state.drafts[messageId];
  if (!projected) return emptyDelta();
  projected.streaming = false;
  if (messageId) {
    state.endedMessageIds[messageId] = true;
    delete state.drafts[messageId];
    if (state.currentMessageId === messageId) state.currentMessageId = undefined;
  }
  const added = appendMessage(state, projected);
  return emptyDelta({ messages: [added] });
}

export function flushRuntimeProjectionDrafts(state: RuntimeEventProjectionState): RuntimeProjectionMessage[] {
  const flushed: RuntimeProjectionMessage[] = [];
  for (const [messageId, draft] of Object.entries(state.drafts)) {
    if (!draft.content && !draft.toolCalls?.length) continue;
    appendMessage(state, draft);
    flushed.push(draft);
    delete state.drafts[messageId];
  }
  if (state.currentMessageId && !state.drafts[state.currentMessageId]) {
    state.currentMessageId = undefined;
  }
  return flushed;
}

export function mapAgentEndReasonToRunStatus(reason: unknown): RuntimeProjectionRunStatus {
  if (reason === "aborted" || reason === "cancelled") return "cancelled";
  if (
    reason === "error" ||
    reason === "blocked" ||
    reason === "goal-blocked" ||
    reason === "goal-max-rounds" ||
    reason === "goal-stalled" ||
    reason === "max-rounds" ||
    reason === "max-turns" ||
    reason === "agent-error" ||
    reason === "provider-error" ||
    reason === "runtime-error" ||
    reason === "intervention-required" ||
    reason === "run-engine-error"
  ) {
    return "failed";
  }
  return "completed";
}

function projectRunQueuedEvent(state: RuntimeEventProjectionState, event: DaemonOrchestratorEvent): RuntimeProjectionDelta {
  const run = payloadRecord(event.payload, "run");
  const prompt = metadataString(payloadRecord(run, "metadata"), "prompt");
  const runId = stringValue(run?.id) ?? event.runId;
  if (!prompt || !runId || state.seenRunPromptIds[runId]) return emptyDelta();
  state.seenRunPromptIds[runId] = true;
  const message = appendMessage(state, {
    id: `daemon-user-${event.id}`,
    role: "user",
    content: prompt,
    timestamp: parseTimestamp(event.timestamp),
    runId,
    sessionId: event.sessionId,
  });
  return emptyDelta({ messages: [message], run: { status: "running" } });
}

function messageFromAgentMessage(message: JsonRecord | undefined, options: ProjectRuntimeEventOptions): RuntimeProjectionMessage | null {
  if (!message) return null;
  const roleValue = stringValue(message.role);
  if (roleValue === "tool") return null;
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const content: string[] = [];
  const toolCalls: RuntimeProjectionToolCall[] = [];

  let currentTextRun = "";

  for (const blockValue of blocks) {
    if (!isRecord(blockValue)) continue;
    const blockType = stringValue(blockValue.type);
    if (blockType === "text" || blockType === "thought") {
      const text = typeof blockValue.text === "string" ? blockValue.text : "";
      if (text) {
        currentTextRun += text;
      }
    } else {
      if (currentTextRun) {
        content.push(currentTextRun);
        currentTextRun = "";
      }
      if (blockType === "tool-call") {
        const toolCall = toolCallFromBlock(blockValue, options);
        if (toolCall) toolCalls.push(toolCall);
      }
      if (blockType === "tool-result") {
        const output = outputText(payloadRecord(blockValue, "output"));
        if (output) content.push(output);
      }
    }
  }

  if (currentTextRun) {
    content.push(currentTextRun);
  }

  if (!content.length && toolCalls.length === 0) return null;

  return {
    id: stringValue(message.id) ?? `daemon-message-${options.eventId ?? stableSuffix()}`,
    role: roleValue === "user" || roleValue === "assistant" || roleValue === "system" ? roleValue : "system",
    content: content.join("\n"),
    timestamp: parseTimestamp(stringValue(message.createdAt) ?? options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    streaming: false,
  };
}

function createDraftMessage(messageId: string, options: ProjectRuntimeEventOptions): RuntimeProjectionMessage {
  return {
    id: `daemon-draft-${messageId}`,
    role: "assistant",
    content: "",
    timestamp: parseTimestamp(options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
    streaming: true,
  };
}

function attachToolCall(state: RuntimeEventProjectionState, toolCall: RuntimeProjectionToolCall): void {
  const draft = state.currentMessageId ? state.drafts[state.currentMessageId] : undefined;
  const target = draft ?? [...state.messages].reverse().find((message) => message.role === "assistant");
  if (!target) {
    appendMessage(state, {
      id: `daemon-tool-${toolCall.id}`,
      role: "assistant",
      content: "",
      timestamp: toolCall.timestamp,
      runId: toolCall.runId,
      sessionId: toolCall.sessionId,
      toolCalls: [toolCall],
    });
    return;
  }
  upsertToolCall(target, toolCall);
}

function updateToolCall(
  state: RuntimeEventProjectionState,
  toolId: string,
  updater: (tool: RuntimeProjectionToolCall) => void
): RuntimeProjectionMessage[] {
  const updatedMessages: RuntimeProjectionMessage[] = [];
  for (const message of [...state.messages, ...Object.values(state.drafts)]) {
    const tool = message.toolCalls?.find((item) => item.id === toolId);
    if (!tool) continue;
    updater(tool);
    updatedMessages.push(message);
  }
  return updatedMessages;
}

function messagesContainingTool(state: RuntimeEventProjectionState, toolId: string): RuntimeProjectionMessage[] {
  return [...state.messages, ...Object.values(state.drafts)].filter((message) =>
    message.toolCalls?.some((tool) => tool.id === toolId)
  );
}

function upsertToolCall(message: RuntimeProjectionMessage, toolCall: RuntimeProjectionToolCall): void {
  const existing = message.toolCalls?.find((item) => item.id === toolCall.id);
  if (existing) {
    Object.assign(existing, toolCall);
    return;
  }
  message.toolCalls = [...(message.toolCalls ?? []), toolCall];
}

function toolCallFromBlock(block: JsonRecord | undefined, options: ProjectRuntimeEventOptions): RuntimeProjectionToolCall | null {
  if (!block) return null;
  const id = stringValue(block.id);
  const name = stringValue(block.toolName);
  if (!id || !name) return null;
  return {
    id,
    name,
    input: block.input ?? {},
    status: "pending",
    timestamp: parseTimestamp(options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
  };
}

function toolCallFromCall(
  call: JsonRecord | undefined,
  options: ProjectRuntimeEventOptions,
  status: RuntimeProjectionToolStatus
): RuntimeProjectionToolCall | null {
  if (!call) return null;
  const id = stringValue(call.id);
  const name = stringValue(call.toolName);
  if (!id || !name) return null;
  return {
    id,
    name,
    input: call.input ?? {},
    status,
    timestamp: parseTimestamp(options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
  };
}

function toolCallFromResult(
  result: JsonRecord | undefined,
  options: ProjectRuntimeEventOptions,
  status: RuntimeProjectionToolStatus
): RuntimeProjectionToolCall | null {
  if (!result) return null;
  const id = stringValue(result.id);
  const name = stringValue(result.toolName);
  if (!id || !name) return null;
  return {
    id,
    name,
    input: {},
    output: outputText(payloadRecord(result, "output")),
    status,
    timestamp: parseTimestamp(options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
  };
}

function toolCallFromApproval(
  request: JsonRecord | undefined,
  runtimeEvent: JsonRecord,
  options: ProjectRuntimeEventOptions
): RuntimeProjectionToolCall | null {
  if (!request) return null;
  const tool = payloadRecord(request, "tool");
  const id = approvalIdFromEvent(runtimeEvent);
  if (!id) return null;
  const name = stringValue(request.toolName) ?? stringValue(tool?.name) ?? "approval";
  const summary = stringValue(request.summary);
  const input = request.input ?? request.summary ?? {};
  const approvalMetadata = normalizeWorkbenchApprovalMetadata(request.metadata);
  return {
    id,
    name,
    input: summary ? `${summary}\n\n${typeof input === "string" ? input : safeJson(input)}` : input,
    status: "pending",
    timestamp: parseTimestamp(options.timestamp),
    runId: options.runId,
    sessionId: options.sessionId,
    approvalMetadata,
    ...approvalMetadataFields(approvalMetadata),
  };
}

function approvalMetadataFields(metadata: WorkbenchApprovalMetadata): Pick<
  RuntimeProjectionToolCall,
  | "riskLevel"
  | "riskRule"
  | "riskDetail"
  | "riskSource"
  | "matched"
  | "requiresDoubleConfirm"
  | "recommendSnapshot"
  | "checkpointId"
  | "snapshotId"
> {
  return {
    riskLevel: metadata.riskLevel,
    riskRule: metadata.riskRule,
    riskDetail: metadata.riskDetail,
    riskSource: metadata.source,
    matched: metadata.matched,
    requiresDoubleConfirm: metadata.requiresDoubleConfirm,
    recommendSnapshot: metadata.recommendSnapshot,
    checkpointId: metadata.checkpointId,
    snapshotId: metadata.snapshotId,
  };
}

function appendMessage(state: RuntimeEventProjectionState, message: RuntimeProjectionMessage): RuntimeProjectionMessage {
  const existingIndex = state.messages.findIndex((item) => item.id === message.id);
  if (existingIndex >= 0) {
    state.messages[existingIndex] = message;
    return message;
  }
  state.messages.push(message);
  return message;
}

function emptyDelta(overrides: Partial<RuntimeProjectionDelta> = {}): RuntimeProjectionDelta {
  return {
    messages: [],
    updatedMessages: [],
    tools: [],
    approvals: [],
    ...overrides,
  };
}

function outputText(output: JsonRecord | undefined): string | undefined {
  if (!output) return undefined;
  const text = stringValue(output.text);
  if (text) return text;
  if (output.json !== undefined) return safeJson(output.json);
  return undefined;
}

function metadataString(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function runStatusFromDaemonEvent(event: DaemonOrchestratorEvent): RuntimeProjectionRunStatus | null {
  const status = workbenchRunLifecycleStatusFromDaemon(event);
  return status === "running" || status === "completed" || status === "cancelled" || status === "failed" ? status : null;
}

function runReasonFromDaemonEvent(event: DaemonOrchestratorEvent): string | undefined {
  const payload = event.payload;
  const run = payloadRecord(payload, "run");
  return stringValue(payload.reason) ?? stringValue(run?.reason) ?? stringValue(payload.outcome) ?? undefined;
}

function payloadRecord(parent: JsonRecord | undefined | null, key: string): JsonRecord | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseTimestamp(value?: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSuffix(): string {
  return "runtime-event";
}
