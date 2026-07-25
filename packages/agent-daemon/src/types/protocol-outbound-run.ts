import type { JsonObject, AgentEvent } from "@crish/shared-types";
import type { ApprovalProtocolDecision } from "./snapshot-types.js";

export interface EventMessage {
  type: "event";
  runId: string;
  orchestratorEventId?: string;
  sequence?: number;
  timestamp?: string;
  event: AgentEvent;
}

export interface ApprovalRequestedMessage {
  type: "approval-requested";
  runId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  timeoutMs: number | null;
  expiresAt: number | null;
  remainingMs: number | null;
  risk?: string;
  riskReason?: string;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  metadata?: JsonObject;
}

export interface ApprovalResolvedMessage {
  type: "approval-resolved";
  toolCallId: string;
  decision: ApprovalProtocolDecision;
  reason?: string;
  expiredAt?: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
  runId?: string;
}

export interface SubagentStartedMessage {
  type: "subagent-started";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  description: string;
  mode: string;
}

export interface SubagentEndedMessage {
  type: "subagent-ended";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  status: "completed" | "failed";
  summary: string;
}

export interface SubagentEventMessage {
  type: "subagent-event";
  runId: string;
  subagentId: string;
  subagentRunId: string;
  parentToolCallId: string;
  event: AgentEvent;
}


