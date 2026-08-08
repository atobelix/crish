// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)
// Registry: crates/conex-types/contracts/engine-events.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { AgentEndReason, AgentMessage, AgentMessageBlock, ToolBatchCall, ToolProgressUpdate, ToolBatchResult, ContextCompressionRecord, ProviderDiagnostic, PermissionRequest, ApprovalDecision, RuntimeCheckpointRecord, RuntimeCheckpointRestoreRecord, RunTerminalStatus, RunCacheStats, MissAttribution, SecurityAuditOperation, ImpactAssessment, SecurityAuditDecision, SubagentEventPayload, SubagentEventKind, SubagentEndStatus } from "./types";

import type { JsonValue } from "../../primitive-types";

export interface EngineAgentStartEvent {
  type: "agent-start";
  sessionId: string;
  timestamp: string;
}

export interface EngineAgentEndEvent {
  type: "agent-end";
  sessionId: string;
  timestamp: string;
  reason: AgentEndReason;
  error?: string;
}

export interface EngineTurnStartEvent {
  type: "turn-start";
  sessionId: string;
  turnIndex: number;
  timestamp: string;
}

export interface EngineTurnEndEvent {
  type: "turn-end";
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  toolCallCount: number;
}

export interface EngineMessageStartEvent {
  type: "message-start";
  sessionId: string;
  message: AgentMessage;
}

export interface EngineMessageDeltaEvent {
  type: "message-delta";
  sessionId: string;
  timestamp: string;
  messageId: string;
  block: AgentMessageBlock;
}

export interface EngineMessageEndEvent {
  type: "message-end";
  sessionId: string;
  turnIndex?: number;
  message: AgentMessage;
}

export interface EngineToolStartEvent {
  type: "tool-start";
  sessionId: string;
  batchId: string;
  call: ToolBatchCall;
  timestamp: string;
}

export interface EngineToolUpdateEvent {
  type: "tool-update";
  sessionId: string;
  batchId: string;
  toolCallId: string;
  update: ToolProgressUpdate;
  timestamp: string;
}

export interface EngineToolEndEvent {
  type: "tool-end";
  sessionId: string;
  batchId: string;
  result: ToolBatchResult;
  timestamp: string;
}

export interface EngineToolBatchStartEvent {
  type: "tool-batch-start";
  sessionId: string;
  batchId: string;
  timestamp: string;
  summary: string;
  calls: ToolBatchCall[];
}

export interface EngineToolBatchEndEvent {
  type: "tool-batch-end";
  sessionId: string;
  batchId: string;
  timestamp: string;
  calls: ToolBatchResult[];
}

export interface EngineToolInputRepairedEvent {
  type: "tool-input-repaired";
  sessionId: string;
  timestamp: string;
  toolCallId: string;
  toolName: string;
  notes: string[];
}

export interface EngineContextCompressionStartEvent {
  type: "context-compression-start";
  sessionId: string;
  timestamp: string;
  reason: string;
  tokensBefore: number;
}

export interface EngineContextCompressionEndEvent {
  type: "context-compression-end";
  sessionId: string;
  timestamp: string;
  result?: ContextCompressionRecord;
  aborted: boolean;
  error?: string;
}

export interface EngineProviderDiagnosticEvent {
  type: "provider-diagnostic";
  sessionId: string;
  timestamp: string;
  diagnostic: ProviderDiagnostic;
}

export interface EngineRuntimeErrorEvent {
  type: "runtime-error";
  sessionId: string;
  timestamp: string;
  error: string;
  retryable?: boolean;
}

export interface EngineRuntimeSteeringEvent {
  type: "runtime-steering";
  sessionId: string;
  timestamp: string;
  reason: string;
  message: AgentMessage;
}

export interface EngineRuntimeInterventionRequiredEvent {
  type: "runtime-intervention-required";
  sessionId: string;
  timestamp: string;
  reason: string;
  choices: string[];
  message: string;
}

export interface EngineApprovalRequestedEvent {
  type: "approval-requested";
  sessionId: string;
  request: PermissionRequest;
  timestamp: string;
}

export interface EngineApprovalResolvedEvent {
  type: "approval-resolved";
  sessionId: string;
  toolCallId: string;
  requestId?: string;
  decision: ApprovalDecision;
  timestamp: string;
}

export interface EngineCheckpointCreatedEvent {
  type: "checkpoint-created";
  sessionId: string;
  timestamp: string;
  checkpoint: RuntimeCheckpointRecord;
}

export interface EngineCheckpointRestoredEvent {
  type: "checkpoint-restored";
  sessionId: string;
  timestamp: string;
  restore: RuntimeCheckpointRestoreRecord;
}

export interface EngineRunTerminalEvent {
  type: "run-terminal";
  sessionId: string;
  runId: string;
  timestamp: string;
  terminal: RunTerminalStatus;
  error?: string;
}

export interface EngineCacheStatsUpdatedEvent {
  type: "cache-stats-updated";
  sessionId: string;
  timestamp: string;
  stats: RunCacheStats;
}

export interface EngineCacheWasteAlertEvent {
  type: "cache-waste-alert";
  sessionId: string;
  timestamp: string;
  attribution: MissAttribution;
  missedTokens: number;
  idleMs: number;
  modelChanged: boolean;
  missedCostUsd?: number;
}

export interface EngineColdCacheWarningEvent {
  type: "cold-cache-warning";
  sessionId: string;
  timestamp: string;
  ttlSeconds: number;
  idleMs: number;
  resendEstimateTokens: number;
}

export interface EngineSecurityAuditEvent {
  type: "security-audit";
  sessionId: string;
  timestamp: string;
  operation: SecurityAuditOperation;
  targets: string[];
  impact: ImpactAssessment;
  decision: SecurityAuditDecision;
  permissionMode?: string;
  toolCallId?: string;
}

export interface EngineSubagentStartedEvent {
  type: "subagent-started";
  sessionId: string;
  subagentId: string;
  subagentRunId: string;
  role: string;
  capabilityMode: string;
  startedAt: string;
  description?: string;
  mode?: string;
  parentToolCallId?: string;
}

export interface EngineSubagentEventEvent {
  type: "subagent-event";
  sessionId: string;
  subagentId: string;
  subagentRunId: string;
  event: SubagentEventPayload;
}

export interface EngineSubagentEndedEvent {
  type: "subagent-ended";
  sessionId: string;
  subagentId: string;
  subagentRunId: string;
  status: SubagentEndStatus;
  summary?: string;
  endedAt: string;
}

export interface EngineTaskStartedEvent {
  type: "task-started";
  sessionId: string;
  taskId: string;
  command: string;
  cwd: string;
  ownerRunId: string;
  isDaemon: boolean;
}

export interface EngineTaskOutputEvent {
  type: "task-output";
  sessionId: string;
  taskId: string;
  line?: string;
  chunk?: string;
  lineCount?: number;
}

export interface EngineTaskHeartbeatEvent {
  type: "task-heartbeat";
  sessionId: string;
  taskId: string;
  resource: JsonValue;
}

export interface EngineTaskSuspiciousEvent {
  type: "task-suspicious";
  sessionId: string;
  taskId: string;
  silenceMs: number;
  lastOutputAtMs: number;
}

export interface EngineTaskCompletedEvent {
  type: "task-completed";
  sessionId: string;
  taskId: string;
  exitCode: number;
  durationMs: number;
  lineCount: number;
}

export interface EngineTaskFailedEvent {
  type: "task-failed";
  sessionId: string;
  taskId: string;
  exitCode: number;
  tail: string[];
  durationMs: number;
}

export interface EngineTaskKilledEvent {
  type: "task-killed";
  sessionId: string;
  taskId: string;
  viaForce: boolean;
  diagnostics?: string;
}

export interface EngineTimerFiredEvent {
  type: "timer-fired";
  sessionId: string;
  timerId: string;
  prompt: string;
  firedAtMs: number;
}

export interface EngineTimerCancelledEvent {
  type: "timer-cancelled";
  sessionId: string;
  timerId: string;
  reason: string;
  cancelledAtMs: number;
}

export interface EngineCronFiredEvent {
  type: "cron-fired";
  sessionId: string;
  cronId: string;
  prompt: string;
  expression: string;
  iteration: number;
  firedAtMs: number;
}

export type EngineEvent = EngineAgentStartEvent | EngineAgentEndEvent | EngineTurnStartEvent | EngineTurnEndEvent | EngineMessageStartEvent | EngineMessageDeltaEvent | EngineMessageEndEvent | EngineToolStartEvent | EngineToolUpdateEvent | EngineToolEndEvent | EngineToolBatchStartEvent | EngineToolBatchEndEvent | EngineToolInputRepairedEvent | EngineContextCompressionStartEvent | EngineContextCompressionEndEvent | EngineProviderDiagnosticEvent | EngineRuntimeErrorEvent | EngineRuntimeSteeringEvent | EngineRuntimeInterventionRequiredEvent | EngineApprovalRequestedEvent | EngineApprovalResolvedEvent | EngineCheckpointCreatedEvent | EngineCheckpointRestoredEvent | EngineRunTerminalEvent | EngineCacheStatsUpdatedEvent | EngineCacheWasteAlertEvent | EngineColdCacheWarningEvent | EngineSecurityAuditEvent | EngineSubagentStartedEvent | EngineSubagentEventEvent | EngineSubagentEndedEvent | EngineTaskStartedEvent | EngineTaskOutputEvent | EngineTaskHeartbeatEvent | EngineTaskSuspiciousEvent | EngineTaskCompletedEvent | EngineTaskFailedEvent | EngineTaskKilledEvent | EngineTimerFiredEvent | EngineTimerCancelledEvent | EngineCronFiredEvent;

export const ENGINE_EVENT_TYPES = ["agent-start","agent-end","turn-start","turn-end","message-start","message-delta","message-end","tool-start","tool-update","tool-end","tool-batch-start","tool-batch-end","tool-input-repaired","context-compression-start","context-compression-end","provider-diagnostic","runtime-error","runtime-steering","runtime-intervention-required","approval-requested","approval-resolved","checkpoint-created","checkpoint-restored","run-terminal","cache-stats-updated","cache-waste-alert","cold-cache-warning","security-audit","subagent-started","subagent-event","subagent-ended","task-started","task-output","task-heartbeat","task-suspicious","task-completed","task-failed","task-killed","timer-fired","timer-cancelled","cron-fired"] as const;
export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

export const ENGINE_EVENT_BACKPRESSURE = {
  "agent-start": "critical",
  "agent-end": "critical",
  "turn-start": "critical",
  "turn-end": "critical",
  "message-start": "critical",
  "message-delta": "delta",
  "message-end": "critical",
  "tool-start": "critical",
  "tool-update": "critical",
  "tool-end": "critical",
  "tool-batch-start": "critical",
  "tool-batch-end": "critical",
  "tool-input-repaired": "critical",
  "context-compression-start": "critical",
  "context-compression-end": "critical",
  "provider-diagnostic": "critical",
  "runtime-error": "critical",
  "runtime-steering": "critical",
  "runtime-intervention-required": "critical",
  "approval-requested": "critical",
  "approval-resolved": "critical",
  "checkpoint-created": "critical",
  "checkpoint-restored": "critical",
  "run-terminal": "critical",
  "cache-stats-updated": "critical",
  "cache-waste-alert": "critical",
  "cold-cache-warning": "critical",
  "security-audit": "critical",
  "subagent-started": "critical",
  "subagent-event": "delta",
  "subagent-ended": "critical",
  "task-started": "critical",
  "task-output": "delta",
  "task-heartbeat": "delta",
  "task-suspicious": "soft",
  "task-completed": "critical",
  "task-failed": "critical",
  "task-killed": "critical",
  "timer-fired": "critical",
  "timer-cancelled": "soft",
  "cron-fired": "critical"
} as const;
export type EngineEventBackpressure = (typeof ENGINE_EVENT_BACKPRESSURE)[EngineEventType];

export const SUBAGENT_EVENT_KIND_BACKPRESSURE = {
  "progress": "delta",
  "message": "soft",
  "tool": "soft"
} as const;
export type SubagentEventKindBackpressure = (typeof SUBAGENT_EVENT_KIND_BACKPRESSURE)[SubagentEventKind];

