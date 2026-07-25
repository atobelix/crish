import type { AgentEvent, AgentMessage, AgentMessageBlock, JsonObject, JsonValue, ToolBatchCall, ToolBatchResult } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";
import type { OrchestratorEvent, OrchestratorRunRecord, RunStatus } from "@crish/agent-orchestrator";
import { approvalRiskFields } from "../approval-projection.js";
import type { DaemonBackgroundTaskSnapshot, DaemonTaskMessageSnapshot, DaemonTaskSnapshotApproval, DaemonTaskSnapshotToolCall } from "../types.js";

export type EventHandler = (event: OrchestratorEvent, ctx: SnapshotBuildContext) => void;
export type RuntimeEventHandler = (runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext) => void;

export interface SnapshotBuildState {
  latestError?: string;
  status: RunStatus;
  updatedAt: string;
  progressLabel: string;
  lastAssistantMessage?: MutableMessage;
}

export interface SnapshotBuildContext {
  runId: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  metadata: JsonObject;
  firstEventTimestamp?: string;
  messages: MutableMessage[];
  drafts: Map<string, MutableMessage>;
  endedMessageIds: Set<string>;
  pendingToolCalls: Map<string, DaemonTaskSnapshotToolCall>;
  approvals: Map<string, DaemonTaskSnapshotApproval>;
  backgroundTasks: Map<string, DaemonBackgroundTaskSnapshot>;
  toolCallIndex: Map<string, ToolCallLocation>;
  runtimeEvents: AgentEvent[];
  state: SnapshotBuildState;
}

export interface MutableMessage extends DaemonTaskMessageSnapshot {
  toolCalls: DaemonTaskSnapshotToolCall[] | undefined;
}

export interface ToolCallLocation {
  message: MutableMessage;
  toolCall: DaemonTaskSnapshotToolCall;
}

export interface BuildDaemonTaskSnapshotInput {
  run?: OrchestratorRunRecord;
  events: OrchestratorEvent[];
}

export const EVENT_HANDLERS: Record<string, EventHandler> = {
  "run-queued": handleRunQueued,
  "run-started": handleRunStarted,
  "run-cancel-requested": handleRunCancelRequested,
  "run-cancelled": handleRunCancelled,
  "run-completed": handleRunCompleted,
  "run-failed": handleRunFailed,
  "runtime-event": handleRuntimeEvent,
  "session-created": handleSessionCreated,
};

export const RUNTIME_EVENT_HANDLERS: Record<string, RuntimeEventHandler> = {
  "agent-start": handleAgentStartEvent,
  "turn-start": handleTurnStart,
  "turn-end": handleTurnEnd,
  "message-delta": handleMessageDeltaEvent,
  "message-end": handleMessageEndEvent,
  "tool-start": handleToolStart,
  "tool-update": handleToolUpdate,
  "tool-end": handleToolEnd,
  "approval-requested": handleApprovalRequestedEvent,
  "approval-resolved": handleApprovalResolvedEvent,
  "runtime-error": handleRuntimeErrorEvent,
  "agent-end": handleAgentEndEvent,
};

function handleRunQueued(event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "queued";
  ctx.state.progressLabel = "Queued";
  const eventRun = recordField(event.payload, "run");
  const eventPrompt = stringField(recordField(eventRun, "metadata"), "prompt");
  if (eventPrompt) {
    ctx.messages.push({
      id: `daemon-user-${event.id}`,
      role: "user",
      content: eventPrompt,
      createdAt: event.timestamp,
      toolCalls: undefined,
    });
  }
}

function handleRunStarted(_event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "running";
  ctx.state.progressLabel = "Running";
}

function handleRunCancelRequested(_event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "cancelling";
  ctx.state.progressLabel = "Cancelling";
}

function handleRunCancelled(_event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "cancelled";
  ctx.state.progressLabel = "Cancelled";
}

function handleRunCompleted(_event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "completed";
  ctx.state.progressLabel = "Completed";
}

function handleRunFailed(event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "failed";
  ctx.state.latestError = stringField(event.payload, "error") ?? stringField(recordField(event.payload, "run"), "error") ?? "Run failed";
  ctx.state.progressLabel = "Failed";
  if (ctx.state.latestError.toLowerCase() !== "aborted") {
    ctx.messages.push({
      id: `daemon-error-${event.id}`,
      role: "system",
      content: ctx.state.latestError,
      createdAt: event.timestamp,
      toolCalls: undefined,
    });
  }
}

function handleRuntimeEvent(event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const runtimeEvent = runtimeEventFromOrchestratorEvent(event);
  if (!runtimeEvent) return;
  ctx.runtimeEvents.push(runtimeEvent);
  const handler = RUNTIME_EVENT_HANDLERS[runtimeEvent.type];
  if (handler) handler(runtimeEvent, event, ctx);
}

function handleSessionCreated(_event: OrchestratorEvent, _ctx: SnapshotBuildContext): void {
}

function handleAgentStartEvent(_runtimeEvent: AgentEvent, _event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  ctx.state.status = "running";
  ctx.state.progressLabel = "Agent started";
}

function handleTurnStart(runtimeEvent: AgentEvent, _event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const turnEvent = runtimeEvent as Extract<AgentEvent, { type: "turn-start" }>;
  ctx.state.progressLabel = `Turn ${turnEvent.turnIndex + 1} started`;
}

function handleTurnEnd(runtimeEvent: AgentEvent, _event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const turnEvent = runtimeEvent as Extract<AgentEvent, { type: "turn-end" }>;
  ctx.state.progressLabel = `Turn ${turnEvent.turnIndex + 1} finished`;
}

function handleMessageDeltaEvent(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const msgEvent = runtimeEvent as Extract<AgentEvent, { type: "message-delta" }>;
  if (ctx.endedMessageIds.has(msgEvent.messageId)) return;
  const draft: MutableMessage = ctx.drafts.get(msgEvent.messageId) ?? {
    id: `daemon-draft-${msgEvent.messageId}`,
    role: "assistant",
    content: "",
    createdAt: event.timestamp,
    toolCalls: undefined,
  };
  if (msgEvent.block.type === "text" || msgEvent.block.type === "thought") {
    draft.content += msgEvent.block.text;
  }
  if (msgEvent.block.type === "tool-call") {
    const toolCall = toolCallFromBlock(msgEvent.block, event, "pending");
    draft.toolCalls = [...(draft.toolCalls ?? []), toolCall];
    ctx.toolCallIndex.set(toolCall.id, { message: draft, toolCall });
  }
  ctx.drafts.set(msgEvent.messageId, draft);
}

function handleMessageEndEvent(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const msgEvent = runtimeEvent as Extract<AgentEvent, { type: "message-end" }>;
  const messageId = msgEvent.message.id;
  ctx.endedMessageIds.add(messageId);
  const draft = ctx.drafts.get(messageId);
  if (draft?.toolCalls) {
    for (const tc of draft.toolCalls) ctx.toolCallIndex.delete(tc.id);
  }
  ctx.drafts.delete(messageId);
  const message = messageFromAgentMessage(msgEvent.message, event);
  if (!message) return;
  ctx.messages.push(message);
  if (message.role === "assistant") ctx.state.lastAssistantMessage = message;
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      ctx.toolCallIndex.set(tc.id, { message, toolCall: tc });
    }
  }
}

function handleToolStart(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const toolEvent = runtimeEvent as Extract<AgentEvent, { type: "tool-start" }>;
  const toolCall = toolCallFromCall(toolEvent.call, event, "running");
  ctx.pendingToolCalls.set(toolCall.id, toolCall);
  const newMessage = attachToolCall(ctx.messages, ctx.drafts, toolCall, ctx.toolCallIndex, ctx.state.lastAssistantMessage);
  if (newMessage) ctx.state.lastAssistantMessage = newMessage;
  ctx.state.progressLabel = toolEvent.call.summary || `Running ${toolEvent.call.toolName}`;
}

function handleToolUpdate(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const toolEvent = runtimeEvent as Extract<AgentEvent, { type: "tool-update" }>;
  const existing = ctx.pendingToolCalls.get(toolEvent.toolCallId);
  if (existing) {
    existing.status = "running";
    existing.updatedAt = toolEvent.timestamp;
    existing.output = toolEvent.update.text ?? existing.output;
  }
  applyBackgroundTaskJson(toolEvent.update.json, ctx.backgroundTasks, event.timestamp);
  if (toolEvent.update.text) ctx.state.progressLabel = toolEvent.update.text;
}

function handleToolEnd(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const toolEvent = runtimeEvent as Extract<AgentEvent, { type: "tool-end" }>;
  ctx.pendingToolCalls.delete(toolEvent.result.id);
  applyToolResult(toolEvent.result, ctx.toolCallIndex);
  applyBackgroundTaskJson(toolEvent.result.output.json, ctx.backgroundTasks, event.timestamp);
  if (toolEvent.result.isError) {
    ctx.state.latestError = outputText(toolEvent.result.output) ?? `${toolEvent.result.toolName} failed`;
  }
  ctx.state.progressLabel = toolEvent.result.isError ? `${toolEvent.result.toolName} failed` : `${toolEvent.result.toolName} finished`;
}

function handleApprovalRequestedEvent(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const approvalEvent = runtimeEvent as Extract<AgentEvent, { type: "approval-requested" }>;
  ctx.state.status = "awaiting-approval";
  const approval = approvalFromRequest(approvalEvent.request, event.timestamp);
  ctx.approvals.set(approval.toolCallId, approval);
  ctx.pendingToolCalls.set(approval.toolCallId, {
    id: approval.toolCallId,
    name: approval.toolName,
    input: approval.input,
    status: "approval-required",
    summary: approval.summary,
    startedAt: approval.requestedAt,
    updatedAt: approval.requestedAt,
    output: undefined,
    approvalMetadata: approval.metadata,
  });
  ctx.state.progressLabel = "Waiting for approval";
}

function handleApprovalResolvedEvent(runtimeEvent: AgentEvent, _event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const approvalEvent = runtimeEvent as Extract<AgentEvent, { type: "approval-resolved" }>;
  ctx.approvals.delete(approvalEvent.requestId);
  ctx.pendingToolCalls.delete(approvalEvent.requestId);
  ctx.state.status = "running";
  ctx.state.progressLabel = approvalEvent.decision.behavior === "allow" ? "Approval granted" : "Approval denied";
}

function handleRuntimeErrorEvent(runtimeEvent: AgentEvent, event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const errorEvent = runtimeEvent as Extract<AgentEvent, { type: "runtime-error" }>;
  ctx.state.latestError = errorEvent.error;
  ctx.state.progressLabel = "Runtime error";
  ctx.messages.push({
    id: `daemon-runtime-error-${event.id}`,
    role: "system",
    content: errorEvent.error,
    createdAt: event.timestamp,
    toolCalls: undefined,
  });
}

function handleAgentEndEvent(runtimeEvent: AgentEvent, _event: OrchestratorEvent, ctx: SnapshotBuildContext): void {
  const endEvent = runtimeEvent as Extract<AgentEvent, { type: "agent-end" }>;
  if (endEvent.reason === "error") {
    ctx.state.latestError = endEvent.error ?? "Agent ended with an error";
    ctx.state.progressLabel = "Agent error";
  }
}

export function runtimeEventFromOrchestratorEvent(event: OrchestratorEvent): AgentEvent | undefined {
  const runtimeEvent = recordField(event.payload, "event") as AgentEvent | undefined;
  return runtimeEvent && typeof runtimeEvent.type === "string" ? runtimeEvent : undefined;
}

export function messageFromAgentMessage(message: AgentMessage, event: OrchestratorEvent): MutableMessage | undefined {
  if (message.role === "tool") return undefined;
  const content: string[] = [];
  const toolCalls: DaemonTaskSnapshotToolCall[] = [];
  let currentTextRun = "";
  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thought") {
      if (block.text) currentTextRun += block.text;
    } else {
      if (currentTextRun) { content.push(currentTextRun); currentTextRun = ""; }
      if (block.type === "tool-call") toolCalls.push(toolCallFromBlock(block, event, "pending"));
      if (block.type === "tool-result") {
        const text = outputText(block.output);
        if (text) content.push(text);
      }
    }
  }
  if (currentTextRun) content.push(currentTextRun);
  if (content.length === 0 && toolCalls.length === 0) return undefined;
  return {
    id: message.id,
    role: message.role,
    content: content.join("\n"),
    createdAt: message.createdAt || event.timestamp,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export function attachToolCall(
  messages: MutableMessage[],
  drafts: Map<string, MutableMessage>,
  toolCall: DaemonTaskSnapshotToolCall,
  toolCallIndex: Map<string, ToolCallLocation>,
  lastAssistantMessage: MutableMessage | undefined
): MutableMessage | undefined {
  const target = lastDraftValue(drafts) ?? lastAssistantMessage;
  if (!target) {
    const message: MutableMessage = {
      id: `daemon-tool-${toolCall.id}`,
      role: "assistant",
      content: "",
      createdAt: toolCall.startedAt,
      toolCalls: [toolCall],
    };
    messages.push(message);
    toolCallIndex.set(toolCall.id, { message, toolCall });
    return message;
  }
  const indexed = toolCallIndex.get(toolCall.id);
  const existing = indexed && indexed.message === target ? indexed.toolCall : undefined;
  if (existing) {
    Object.assign(existing, toolCall);
  } else {
    target.toolCalls = [...(target.toolCalls ?? []), toolCall];
    toolCallIndex.set(toolCall.id, { message: target, toolCall });
  }
  return undefined;
}

export function cleanMessage(message: MutableMessage): DaemonTaskMessageSnapshot {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    toolCalls: message.toolCalls && message.toolCalls.length > 0 ? message.toolCalls : undefined,
  };
}

export function readLatestRunRecord(events: OrchestratorEvent[]): OrchestratorRunRecord | undefined {
  let latest: OrchestratorRunRecord | undefined;
  for (const event of events) {
    const run = recordField(event.payload, "run") as OrchestratorRunRecord | undefined;
    if (run && typeof run.id === "string" && typeof run.sessionId === "string") latest = run;
  }
  return latest;
}

export function titleFromPrompt(prompt: string, runId: string): string {
  const title = prompt.trim().split(/\r?\n/)[0]?.trim();
  if (!title) return runId;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function lastDraftValue(drafts: Map<string, MutableMessage>): MutableMessage | undefined {
  let last: MutableMessage | undefined;
  for (const draft of drafts.values()) last = draft;
  return last;
}

function applyToolResult(result: ToolBatchResult, toolCallIndex: Map<string, ToolCallLocation>): void {
  const indexed = toolCallIndex.get(result.id);
  if (!indexed) return;
  indexed.toolCall.status = result.isError ? "failed" : "completed";
  indexed.toolCall.output = outputText(result.output);
  indexed.toolCall.updatedAt = indexed.message.createdAt;
}

function toolCallFromBlock(block: Extract<AgentMessageBlock, { type: "tool-call" }>, event: OrchestratorEvent, status: DaemonTaskSnapshotToolCall["status"]): DaemonTaskSnapshotToolCall {
  return { id: block.id, name: block.toolName, input: block.input, status, summary: undefined, startedAt: event.timestamp, updatedAt: event.timestamp, output: undefined, approvalMetadata: undefined };
}

function toolCallFromCall(call: ToolBatchCall, event: OrchestratorEvent, status: DaemonTaskSnapshotToolCall["status"]): DaemonTaskSnapshotToolCall {
  return { id: call.id, name: call.toolName, input: call.input, status, summary: call.summary, startedAt: event.timestamp, updatedAt: event.timestamp, output: undefined, approvalMetadata: undefined };
}

function approvalFromRequest(request: Extract<AgentEvent, { type: "approval-requested" }>["request"], requestedAt: string): DaemonTaskSnapshotApproval {
  const metadata = jsonObjectField(request.metadata);
  return { toolCallId: request.toolCallId, toolName: request.toolName, input: request.parameters, summary: request.summary, requestedAt, status: "pending", ...approvalRiskFields(metadata) };
}

function applyBackgroundTaskJson(value: JsonValue | undefined, backgroundTasks: Map<string, DaemonBackgroundTaskSnapshot>, fallbackUpdatedAt: string): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) applyBackgroundTaskJson(item, backgroundTasks, fallbackUpdatedAt);
    return;
  }
  if (!isRecord(value)) return;
  const tasks = Array.isArray(value.tasks) ? value.tasks : undefined;
  if (tasks) {
    for (const task of tasks) applyBackgroundTaskJson(task, backgroundTasks, fallbackUpdatedAt);
  }
  const task = backgroundTaskFromRecord(value, fallbackUpdatedAt);
  if (task) backgroundTasks.set(task.id, task);
}

function backgroundTaskFromRecord(record: Record<string, unknown>, fallbackUpdatedAt: string): DaemonBackgroundTaskSnapshot | undefined {
  const id = stringField(record, "id");
  const command = stringField(record, "command");
  const state = stringField(record, "state");
  if (!id || !command || !state) return undefined;
  if (!isBackgroundTaskState(state)) return undefined;
  const updatedAt = stringField(record, "updatedAt") ?? fallbackUpdatedAt;
  return { id, kind: "command", title: command, state, command, cwd: stringField(record, "cwd"), startedAt: stringField(record, "startedAt"), updatedAt, finishedAt: stringField(record, "finishedAt"), durationMs: numberField(record, "durationMs"), timeoutMs: undefined, exitCode: nullableNumberField(record, "exitCode"), signal: nullableStringField(record, "signal"), timedOut: undefined, cancelled: undefined, truncated: undefined, stdoutBytes: undefined, stderrBytes: undefined, outputPreview: stringField(record, "outputPreview"), diagnostics: undefined };
}

function outputText(output: { text?: string; json?: JsonValue } | undefined): string | undefined {
  if (!output) return undefined;
  if (typeof output.text === "string" && output.text.length > 0) return output.text;
  if (output.json !== undefined) return JSON.stringify(output.json, null, 2);
  return undefined;
}

function firstString(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function recordField(parent: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = parent?.[key];
  return isRecord(value) ? value : undefined;
}

function jsonObjectField(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined;
}

function stringField(parent: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = parent?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(parent: Record<string, unknown>, key: string): number | undefined {
  const value = parent[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumberField(parent: Record<string, unknown>, key: string): number | null | undefined {
  const value = parent[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableStringField(parent: Record<string, unknown>, key: string): string | null | undefined {
  const value = parent[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isBackgroundTaskState(value: string): value is DaemonBackgroundTaskSnapshot["state"] {
  return value === "running" || value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed-out";
}

export function createCtx(events: OrchestratorEvent[], run: OrchestratorRunRecord | undefined): SnapshotBuildContext {
  const runFromEvents = readLatestRunRecord(events);
  const firstEvent = events[0];
  const runId = run?.id ?? firstString(events.map((e) => e.runId)) ?? "unknown-run";
  const sessionId = run?.sessionId ?? firstEvent?.sessionId ?? "unknown-session";
  const cwd = run?.cwd ?? stringField(recordField(firstEvent?.payload, "run"), "cwd") ?? "";
  const metadata = jsonObjectField(run?.metadata) ?? jsonObjectField(runFromEvents?.metadata) ?? {};
  return {
    runId,
    sessionId,
    cwd,
    prompt: stringField(metadata, "prompt") ?? "",
    metadata,
    ...(firstEvent?.timestamp ? { firstEventTimestamp: firstEvent.timestamp } : {}),
    messages: [],
    drafts: new Map(),
    endedMessageIds: new Set(),
    pendingToolCalls: new Map(),
    approvals: new Map(),
    backgroundTasks: new Map(),
    toolCallIndex: new Map(),
    runtimeEvents: [],
    state: {
      status: run?.status ?? "queued",
      updatedAt: run?.updatedAt ?? (events.at(-1)?.timestamp ?? new Date(0).toISOString()),
      progressLabel: "Queued",
    },
  };
}
