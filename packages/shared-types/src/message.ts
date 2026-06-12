import type { JsonObject } from "./primitive-types";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThoughtBlock {
  type: "thought";
  text: string;
  redacted?: boolean;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  toolName: string;
  input: JsonObject;
}

export interface ToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: import("./tool").ToolOutput;
  isError: boolean;
}

export type AgentMessageBlock = TextBlock | ThoughtBlock | ToolCallBlock | ToolResultBlock;

export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  createdAt: string;
  blocks: AgentMessageBlock[];
  metadata?: JsonObject;
}
