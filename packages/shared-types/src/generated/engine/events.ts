// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)
// Registry: crates/conex-types/contracts/engine-events.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type { AgentEndReason, AgentMessage, AgentMessageBlock, ToolBatchCall, ToolProgressUpdate, ToolBatchResult, ContextCompressionRecord, ProviderDiagnostic, PermissionRequest, ApprovalDecision, RuntimeCheckpointRecord, RuntimeCheckpointRestoreRecord, RunTerminalStatus } from "./types";

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

export type EngineEvent = EngineAgentStartEvent | EngineAgentEndEvent | EngineTurnStartEvent | EngineTurnEndEvent | EngineMessageStartEvent | EngineMessageDeltaEvent | EngineMessageEndEvent | EngineToolStartEvent | EngineToolUpdateEvent | EngineToolEndEvent | EngineToolBatchStartEvent | EngineToolBatchEndEvent | EngineToolInputRepairedEvent | EngineContextCompressionStartEvent | EngineContextCompressionEndEvent | EngineProviderDiagnosticEvent | EngineRuntimeErrorEvent | EngineRuntimeSteeringEvent | EngineRuntimeInterventionRequiredEvent | EngineApprovalRequestedEvent | EngineApprovalResolvedEvent | EngineCheckpointCreatedEvent | EngineCheckpointRestoredEvent | EngineRunTerminalEvent;

export const ENGINE_EVENT_TYPES = ["agent-start","agent-end","turn-start","turn-end","message-start","message-delta","message-end","tool-start","tool-update","tool-end","tool-batch-start","tool-batch-end","tool-input-repaired","context-compression-start","context-compression-end","provider-diagnostic","runtime-error","runtime-steering","runtime-intervention-required","approval-requested","approval-resolved","checkpoint-created","checkpoint-restored","run-terminal"] as const;
export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];

