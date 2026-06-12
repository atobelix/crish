import type { JsonObject, JsonValue, AgentEvent, AgentMessage, AgentMessageBlock, ToolBatchCall, ToolBatchResult } from "@crish/shared-types";
import { collectRuntimeMetricsSnapshot } from "@crish/agent-runtime";
import { isRecord } from "@crish/shared-utils";
import type {
  OrchestratorEvent,
  OrchestratorRunRecord,
  RunStatus,
} from "@crish/agent-orchestrator";
import type {
  DaemonBackgroundTaskSnapshot,
  DaemonTaskMessageSnapshot,
  DaemonTaskSnapshot,
  DaemonTaskSnapshotApproval,
  DaemonTaskSnapshotToolCall,
} from "./types.js";

export interface BuildDaemonTaskSnapshotInput {
  run?: OrchestratorRunRecord;
  events: OrchestratorEvent[];
}

interface MutableMessage extends DaemonTaskMessageSnapshot {
  toolCalls?: DaemonTaskSnapshotToolCall[];
}

export function buildDaemonTaskSnapshot(input: BuildDaemonTaskSnapshotInput): DaemonTaskSnapshot {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const runFromEvents = readLatestRunRecord(events);
  const run = input.run ?? runFromEvents;
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const runId = run?.id ?? firstString(events.map((event) => event.runId)) ?? "unknown-run";
  const sessionId = run?.sessionId ?? firstEvent?.sessionId ?? "unknown-session";
  const cwd = run?.cwd ?? stringField(recordField(firstEvent?.payload, "run"), "cwd") ?? "";
  const metadata = jsonObjectField(run?.metadata) ?? jsonObjectField(runFromEvents?.metadata) ?? {};
  const prompt = stringField(metadata, "prompt") ?? "";
  const messages: MutableMessage[] = [];
  const drafts = new Map<string, MutableMessage>();
  const endedMessageIds = new Set<string>();
  const pendingToolCalls = new Map<string, DaemonTaskSnapshotToolCall>();
  const approvals = new Map<string, DaemonTaskSnapshotApproval>();
  const backgroundTasks = new Map<string, DaemonBackgroundTaskSnapshot>();
  const runtimeEvents: AgentEvent[] = [];
  const state: {
    latestError?: string;
    status: RunStatus;
    updatedAt: string;
    progressLabel: string;
  } = {
    status: run?.status ?? "queued",
    updatedAt: run?.updatedAt ?? lastEvent?.timestamp ?? new Date(0).toISOString(),
    progressLabel: "Queued",
  };

  for (const event of events) {
    state.updatedAt = event.timestamp;

    switch (event.type) {
      case "run-queued": {
        state.status = "queued";
        state.progressLabel = "Queued";
        const eventRun = recordField(event.payload, "run");
        const eventPrompt = stringField(recordField(eventRun, "metadata"), "prompt");
        if (eventPrompt) {
          messages.push({
            id: `daemon-user-${event.id}`,
            role: "user",
            content: eventPrompt,
            createdAt: event.timestamp,
          });
        }
        break;
      }
      case "run-started":
        state.status = "running";
        state.progressLabel = "Running";
        break;
      case "run-cancel-requested":
        state.status = "cancelling";
        state.progressLabel = "Cancelling";
        break;
      case "run-cancelled":
        state.status = "cancelled";
        state.progressLabel = "Cancelled";
        break;
      case "run-completed":
        state.status = "completed";
        state.progressLabel = "Completed";
        break;
      case "run-failed": {
        state.status = "failed";
        state.latestError = stringField(event.payload, "error") ?? stringField(recordField(event.payload, "run"), "error") ?? "Run failed";
        state.progressLabel = "Failed";
        if (state.latestError.toLowerCase() !== "aborted") {
          messages.push({
            id: `daemon-error-${event.id}`,
            role: "system",
            content: state.latestError,
            createdAt: event.timestamp,
          });
        }
        break;
      }
      case "runtime-event":
        {
          const runtimeEvent = runtimeEventFromOrchestratorEvent(event);
          if (runtimeEvent) {
            runtimeEvents.push(runtimeEvent);
            applyRuntimeEventProjection(runtimeEvent, event, state, messages, drafts, endedMessageIds, pendingToolCalls, approvals, backgroundTasks);
          }
        }
        break;
      case "session-created":
        break;
    }
  }

  for (const draft of drafts.values()) {
    if (draft.content || draft.toolCalls?.length) messages.push(draft);
  }

  const metrics = collectRuntimeMetricsSnapshot(runtimeEvents);

  return {
    runId,
    sessionId,
    status: input.run?.status ?? state.status,
    title: titleFromPrompt(prompt, runId),
    messages: messages.map((message) => cleanMessage(message)),
    latestError: run?.error ?? state.latestError,
    approval: [...approvals.values()].at(-1),
    pendingToolCalls: [...pendingToolCalls.values()],
    backgroundTasks: [...backgroundTasks.values()],
    progress: {
      label: state.progressLabel,
      eventCount: metrics.eventCount,
      turnCount: metrics.turnCount,
      textDeltaCount: metrics.streaming.textDeltaCount,
      toolCallCount: metrics.tools.callCount + pendingToolCalls.size,
      completedToolCallCount: metrics.tools.callCount,
      pendingToolCallCount: pendingToolCalls.size,
      approvalPending: approvals.size > 0,
      updatedAt: run?.updatedAt ?? state.updatedAt,
    },
    usage: {
      sampleCount: metrics.providerUsage.sampleCount,
      promptTokens: metrics.providerUsage.promptTokens,
      completionTokens: metrics.providerUsage.completionTokens,
      totalTokens: metrics.providerUsage.totalTokens,
      reasoningTokens: metrics.providerUsage.reasoningTokens,
    },
    cache: {
      sampleCount: metrics.cache.sampleCount,
      promptTokens: metrics.cache.promptTokens,
      readTokens: metrics.cache.readTokens,
      writeTokens: metrics.cache.writeTokens,
      missTokens: metrics.cache.missTokens,
      hitRatio: metrics.cache.hitRatio,
      writeRatio: metrics.cache.writeRatio,
      ...(metrics.latestDimensions?.stablePrefixHash ? { stablePrefixHash: metrics.latestDimensions.stablePrefixHash } : {}),
      ...(metrics.latestDimensions?.cacheKey ? { cacheKey: metrics.latestDimensions.cacheKey } : {}),
      ...(metrics.latestDimensions?.cacheStrategy ? { cacheStrategy: metrics.latestDimensions.cacheStrategy } : {}),
    },
    updatedAt: run?.updatedAt ?? state.updatedAt,
    progressLabel: state.progressLabel,
    currentRun: {
      id: runId,
      sessionId,
      cwd,
      createdAt: run?.createdAt ?? firstEvent?.timestamp ?? state.updatedAt,
      updatedAt: run?.updatedAt ?? state.updatedAt,
      startedAt: run?.startedAt,
      finishedAt: run?.finishedAt,
      metadata,
    },
  };
}

function applyRuntimeEventProjection(
  runtimeEvent: AgentEvent,
  event: OrchestratorEvent,
  state: { latestError?: string; status: RunStatus; progressLabel: string },
  messages: MutableMessage[],
  drafts: Map<string, MutableMessage>,
  endedMessageIds: Set<string>,
  pendingToolCalls: Map<string, DaemonTaskSnapshotToolCall>,
  approvals: Map<string, DaemonTaskSnapshotApproval>,
  backgroundTasks: Map<string, DaemonBackgroundTaskSnapshot>
): void {
  switch (runtimeEvent.type) {
    case "agent-start":
      state.status = "running";
      state.progressLabel = "Agent started";
      break;
    case "turn-start":
      state.progressLabel = `Turn ${runtimeEvent.turnIndex + 1} started`;
      break;
    case "turn-end":
      state.progressLabel = `Turn ${runtimeEvent.turnIndex + 1} finished`;
      break;
    case "message-delta":
      applyMessageDelta(event, runtimeEvent, drafts, endedMessageIds);
      break;
    case "message-end": {
      const messageId = runtimeEvent.message.id;
      endedMessageIds.add(messageId);
      drafts.delete(messageId);
      const message = messageFromAgentMessage(runtimeEvent.message, event);
      if (message) messages.push(message);
      break;
    }
    case "tool-start": {
      const toolCall = toolCallFromCall(runtimeEvent.call, event, "running");
      pendingToolCalls.set(toolCall.id, toolCall);
      attachToolCall(messages, drafts, toolCall);
      state.progressLabel = runtimeEvent.call.summary || `Running ${runtimeEvent.call.toolName}`;
      break;
    }
    case "tool-update": {
      const existing = pendingToolCalls.get(runtimeEvent.toolCallId);
      if (existing) {
        existing.status = "running";
        existing.updatedAt = runtimeEvent.timestamp;
        existing.output = runtimeEvent.update.text ?? existing.output;
      }
      applyBackgroundTaskJson(runtimeEvent.update.json, backgroundTasks, event.timestamp);
      if (runtimeEvent.update.text) state.progressLabel = runtimeEvent.update.text;
      break;
    }
    case "tool-end": {
      pendingToolCalls.delete(runtimeEvent.result.id);
      applyToolResult(messages, drafts, runtimeEvent.result);
      applyBackgroundTaskJson(runtimeEvent.result.output.json, backgroundTasks, event.timestamp);
      if (runtimeEvent.result.isError) {
        state.latestError = outputText(runtimeEvent.result.output) ?? `${runtimeEvent.result.toolName} failed`;
      }
      state.progressLabel = runtimeEvent.result.isError ? `${runtimeEvent.result.toolName} failed` : `${runtimeEvent.result.toolName} finished`;
      break;
    }
    case "approval-requested": {
      state.status = "awaiting-approval";
      const approval = approvalFromRequest(runtimeEvent.request, event.timestamp);
      approvals.set(approval.toolCallId, approval);
      pendingToolCalls.set(approval.toolCallId, {
        id: approval.toolCallId,
        name: approval.toolName,
        input: approval.input,
        status: "approval-required",
        summary: approval.summary,
        startedAt: approval.requestedAt,
        updatedAt: approval.requestedAt,
        ...(approval.metadata !== undefined ? { approvalMetadata: approval.metadata } : {}),
      });
      state.progressLabel = "Waiting for approval";
      break;
    }
    case "approval-resolved": {
      approvals.delete(runtimeEvent.requestId);
      pendingToolCalls.delete(runtimeEvent.requestId);
      state.status = "running";
      state.progressLabel = runtimeEvent.decision.behavior === "allow" ? "Approval granted" : "Approval denied";
      break;
    }
    case "runtime-error":
      state.latestError = runtimeEvent.error;
      state.progressLabel = "Runtime error";
      messages.push({
        id: `daemon-runtime-error-${event.id}`,
        role: "system",
        content: runtimeEvent.error,
        createdAt: event.timestamp,
      });
      break;
    case "agent-end":
      if (runtimeEvent.reason === "error") {
        state.latestError = runtimeEvent.error ?? "Agent ended with an error";
        state.progressLabel = "Agent error";
      }
      break;
    default:
      break;
  }
}

function runtimeEventFromOrchestratorEvent(event: OrchestratorEvent): AgentEvent | undefined {
  const runtimeEvent = recordField(event.payload, "event") as AgentEvent | undefined;
  return runtimeEvent && typeof runtimeEvent.type === "string" ? runtimeEvent : undefined;
}

function applyMessageDelta(
  event: OrchestratorEvent,
  runtimeEvent: Extract<AgentEvent, { type: "message-delta" }>,
  drafts: Map<string, MutableMessage>,
  endedMessageIds: Set<string>
): void {
  if (endedMessageIds.has(runtimeEvent.messageId)) return;
  const draft = drafts.get(runtimeEvent.messageId) ?? {
    id: `daemon-draft-${runtimeEvent.messageId}`,
    role: "assistant",
    content: "",
    createdAt: event.timestamp,
  };

  if (runtimeEvent.block.type === "text" || runtimeEvent.block.type === "thought") {
    draft.content += runtimeEvent.block.text;
  }
  if (runtimeEvent.block.type === "tool-call") {
    draft.toolCalls = [...(draft.toolCalls ?? []), toolCallFromBlock(runtimeEvent.block, event, "pending")];
  }
  drafts.set(runtimeEvent.messageId, draft);
}

function messageFromAgentMessage(message: AgentMessage, event: OrchestratorEvent): MutableMessage | undefined {
  if (message.role === "tool") return undefined;
  const content: string[] = [];
  const toolCalls: DaemonTaskSnapshotToolCall[] = [];

  let currentTextRun = "";

  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thought") {
      if (block.text) {
        currentTextRun += block.text;
      }
    } else {
      if (currentTextRun) {
        content.push(currentTextRun);
        currentTextRun = "";
      }
      if (block.type === "tool-call") {
        toolCalls.push(toolCallFromBlock(block, event, "pending"));
      }
      if (block.type === "tool-result") {
        const text = outputText(block.output);
        if (text) content.push(text);
      }
    }
  }

  if (currentTextRun) {
    content.push(currentTextRun);
  }

  if (content.length === 0 && toolCalls.length === 0) return undefined;
  return {
    id: message.id,
    role: message.role,
    content: content.join("\n"),
    createdAt: message.createdAt || event.timestamp,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function attachToolCall(
  messages: MutableMessage[],
  drafts: Map<string, MutableMessage>,
  toolCall: DaemonTaskSnapshotToolCall
): void {
  const target = [...drafts.values()].at(-1) ?? [...messages].reverse().find((message) => message.role === "assistant");
  if (!target) {
    messages.push({
      id: `daemon-tool-${toolCall.id}`,
      role: "assistant",
      content: "",
      createdAt: toolCall.startedAt,
      toolCalls: [toolCall],
    });
    return;
  }
  const existing = target.toolCalls?.find((candidate) => candidate.id === toolCall.id);
  if (existing) Object.assign(existing, toolCall);
  else target.toolCalls = [...(target.toolCalls ?? []), toolCall];
}

function applyToolResult(
  messages: MutableMessage[],
  drafts: Map<string, MutableMessage>,
  result: ToolBatchResult
): void {
  for (const message of [...messages, ...drafts.values()]) {
    const toolCall = message.toolCalls?.find((candidate) => candidate.id === result.id);
    if (!toolCall) continue;
    toolCall.status = result.isError ? "failed" : "completed";
    toolCall.output = outputText(result.output);
    toolCall.updatedAt = message.createdAt;
    return;
  }
}

function toolCallFromBlock(
  block: Extract<AgentMessageBlock, { type: "tool-call" }>,
  event: OrchestratorEvent,
  status: DaemonTaskSnapshotToolCall["status"]
): DaemonTaskSnapshotToolCall {
  return {
    id: block.id,
    name: block.toolName,
    input: block.input,
    status,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
  };
}

function toolCallFromCall(
  call: ToolBatchCall,
  event: OrchestratorEvent,
  status: DaemonTaskSnapshotToolCall["status"]
): DaemonTaskSnapshotToolCall {
  return {
    id: call.id,
    name: call.toolName,
    input: call.input,
    status,
    summary: call.summary,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
  };
}

function approvalFromRequest(
  request: Extract<AgentEvent, { type: "approval-requested" }>["request"],
  requestedAt: string
): DaemonTaskSnapshotApproval {
  const metadata = jsonObjectField(request.metadata);
  return {
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    input: request.parameters,
    summary: request.summary,
    requestedAt,
    status: "pending",
    ...approvalRiskFields(metadata),
  };
}

function approvalRiskFields(metadata: JsonObject | undefined): Pick<
  DaemonTaskSnapshotApproval,
  "risk" | "riskReason" | "requiresDoubleConfirm" | "recommendSnapshot" | "metadata"
> {
  if (!metadata) return {};
  return {
    ...(typeof metadata.risk === "string" ? { risk: metadata.risk } : {}),
    ...(typeof metadata.reason === "string" ? { riskReason: metadata.reason } : {}),
    ...(typeof metadata.requiresDoubleConfirm === "boolean"
      ? { requiresDoubleConfirm: metadata.requiresDoubleConfirm }
      : {}),
    ...(typeof metadata.recommendSnapshot === "boolean" ? { recommendSnapshot: metadata.recommendSnapshot } : {}),
    metadata,
  };
}

function applyBackgroundTaskJson(
  value: JsonValue | undefined,
  backgroundTasks: Map<string, DaemonBackgroundTaskSnapshot>,
  fallbackUpdatedAt: string
): void {
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
  return {
    id,
    kind: "command",
    title: command,
    state,
    command,
    cwd: stringField(record, "cwd"),
    startedAt: stringField(record, "startedAt"),
    updatedAt,
    finishedAt: stringField(record, "finishedAt"),
    durationMs: numberField(record, "durationMs"),
    exitCode: nullableNumberField(record, "exitCode"),
    signal: nullableStringField(record, "signal"),
    outputPreview: stringField(record, "outputPreview"),
  };
}

function outputText(output: { text?: string; json?: JsonValue } | undefined): string | undefined {
  if (!output) return undefined;
  if (typeof output.text === "string" && output.text.length > 0) return output.text;
  if (output.json !== undefined) return JSON.stringify(output.json, null, 2);
  return undefined;
}

function cleanMessage(message: MutableMessage): DaemonTaskMessageSnapshot {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.toolCalls && message.toolCalls.length > 0 ? { toolCalls: message.toolCalls } : {}),
  };
}

function readLatestRunRecord(events: OrchestratorEvent[]): OrchestratorRunRecord | undefined {
  let latest: OrchestratorRunRecord | undefined;
  for (const event of events) {
    const run = recordField(event.payload, "run") as OrchestratorRunRecord | undefined;
    if (run && typeof run.id === "string" && typeof run.sessionId === "string") latest = run;
  }
  return latest;
}

function titleFromPrompt(prompt: string, runId: string): string {
  const title = prompt.trim().split(/\r?\n/)[0]?.trim();
  if (!title) return runId;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
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
