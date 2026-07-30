import type { JsonObject } from "@crish/shared-types";

export type SubagentExecutionStrategy =
  | "in-process"
  | "daemon-rpc"
  | "isolated";

export interface SubagentConfig {
  executionStrategy: SubagentExecutionStrategy;
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  workingDirectory?: string;
  env?: Record<string, string>;
}

export interface AgentContextView {
  sessionId: string;
  parentSessionId?: string;
  parentToolCallId?: string;
  cwd: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  contextState?: JsonObject;
}

export interface SubagentLoopResult {
  success: boolean;
  output: string;
  summary: string;
  turnCount: number;
  toolUseCount: number;
  error?: string;
  metadata?: JsonObject;
}

// executeSubagentByStrategy removed — not yet implemented
