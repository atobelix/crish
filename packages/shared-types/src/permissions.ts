import type { JsonObject } from './primitive-types';
import type { AgentTool } from './tool';

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

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

// ─── 运行时权限接口（从 agent-runtime/types.ts 下沉）─────────

export interface RuntimePermissionRequest {
  id: string;
  sessionId: string;
  cwd: string;
  tool: AgentTool;
  input: JsonObject;
  summary: string;
  metadata?: JsonObject;
}

export interface RuntimePermissionPolicy {
  decide(
    request: RuntimePermissionRequest
  ): Promise<PermissionDecision> | PermissionDecision;
  recordDecision?(
    request: RuntimePermissionRequest,
    decision: PermissionDecision
  ): void;
}
