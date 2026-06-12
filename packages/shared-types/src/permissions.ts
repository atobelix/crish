import type { JsonObject } from "./primitive-types";

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface ToolMetadata {
  category?: string;
  isReadOnly?: boolean;
  fatalOnError?: boolean;
  concurrency?: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  parameters: JsonObject;
  summary: string;
  toolMetadata: ToolMetadata;
  metadata?: JsonObject;
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason?: string;
  metadata?: JsonObject;
}

export interface PermissionRule {
  name: string;
  evaluate(request: PermissionRequest): PermissionDecision | null;
}

export interface ApprovalHandler {
  requestApproval(request: PermissionRequest): Promise<PermissionDecision>;
}
