import type { JsonObject } from './primitive-types';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThoughtBlock {
  type: 'thought';
  text: string;
  redacted?: boolean;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResultBlock {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: import('./tool').ToolOutput;
  isError: boolean;
}

export type AgentMessageBlock =
  TextBlock | ThoughtBlock | ToolCallBlock | ToolResultBlock;

export interface AgentMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  createdAt: string;
  blocks: AgentMessageBlock[];
  metadata?: JsonObject;
  /**
   * UI 发送前生成的客户端幂等键（可选）。
   * 用户消息：= 本地乐观 id；助手：= 本地 stream placeholder id。
   * hydrate / upsert 优先此字段，避免 hyd-* 与 assistant-msg-* 双气泡。
   */
  clientMessageId?: string;
}
