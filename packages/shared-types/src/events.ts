import type { AgentMessage, AgentMessageBlock } from "./message";
import type { ToolBatchCall, ToolBatchResult, ToolProgressUpdate, ProviderDiagnostic, ContextCompressionRecord, RuntimeCheckpointRecord, RuntimeCheckpointRestoreRecord } from "./tool";
import type { PermissionRequest, PermissionDecision } from "./permissions";

export type AgentDomainEvent =
  | { type: "agent-start"; sessionId: string; timestamp: string }
  | { type: "agent-end"; sessionId: string; timestamp: string; reason: "stop" | "max-turns" | "aborted" | "error"; error?: string };

export type TurnDomainEvent =
  | { type: "turn-start"; sessionId: string; turnIndex: number; timestamp: string }
  | { type: "turn-end"; sessionId: string; turnIndex: number; timestamp: string; toolCallCount: number };

export type MessageDomainEvent =
  | { type: "message-start"; sessionId: string; message: AgentMessage }
  | { type: "message-delta"; sessionId: string; timestamp: string; messageId: string; block: AgentMessageBlock }
  | { type: "message-end"; sessionId: string; message: AgentMessage };

export type ToolDomainEvent =
  | { type: "tool-start"; sessionId: string; batchId: string; call: ToolBatchCall; timestamp: string }
  | { type: "tool-update"; sessionId: string; batchId: string; toolCallId: string; update: ToolProgressUpdate; timestamp: string }
  | { type: "tool-end"; sessionId: string; batchId: string; result: ToolBatchResult; timestamp: string }
  | { type: "tool-batch-start"; sessionId: string; batchId: string; timestamp: string; summary: string; calls: ToolBatchCall[] }
  | { type: "tool-batch-end"; sessionId: string; batchId: string; timestamp: string; calls: ToolBatchResult[] }
  | { type: "tool-input-repaired"; sessionId: string; timestamp: string; toolCallId: string; toolName: string; notes: string[] };

export type CompressionDomainEvent =
  | { type: "context-compression-start"; sessionId: string; timestamp: string; reason: string; tokensBefore: number }
  | { type: "context-compression-end"; sessionId: string; timestamp: string; result?: ContextCompressionRecord; aborted: boolean; error?: string };

export type DiagnosticDomainEvent =
  | { type: "provider-diagnostic"; sessionId: string; timestamp: string; diagnostic: ProviderDiagnostic }
  | { type: "runtime-error"; sessionId: string; timestamp: string; error: string; retryable?: boolean }
  | { type: "runtime-steering"; sessionId: string; timestamp: string; reason: string; message: AgentMessage }
  | { type: "runtime-intervention-required"; sessionId: string; timestamp: string; reason: string; choices: string[]; message: string }
  | { type: "approval-requested"; sessionId: string; request: PermissionRequest; timestamp: string }
  | { type: "approval-resolved"; sessionId: string; requestId: string; decision: PermissionDecision; timestamp: string }
  | { type: "checkpoint-created"; sessionId: string; timestamp: string; checkpoint: RuntimeCheckpointRecord }
  | { type: "checkpoint-restored"; sessionId: string; timestamp: string; restore: RuntimeCheckpointRestoreRecord }
  | { type: "run-terminal"; sessionId: string; runId: string; timestamp: string; terminal: "completed" | "cancelled" | "failed"; error?: string };

export type AgentEvent = AgentDomainEvent | TurnDomainEvent | MessageDomainEvent | ToolDomainEvent | CompressionDomainEvent | DiagnosticDomainEvent;
