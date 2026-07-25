import type { AgentMessage } from "@crish/shared-types";
import type { SessionEntry, SessionHeader } from "../types";

export type SessionLeafPointerEntry = Extract<SessionEntry, { type: "leaf-pointer" }>;
export type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
export type SessionCheckpointEntry = Extract<SessionEntry, { type: "checkpoint" }>;
export type SessionCompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

export interface MoveSessionLeafOptions {
  reason?: string;
  metadata?: AgentMessage["metadata"];
}

export interface MoveSessionLeafResult {
  previousLeafId: string | null;
  targetLeafId: string | null;
  pointerEntry: SessionLeafPointerEntry;
}

export type JsonlSessionStoreMode = "create" | "append" | "resume-or-create";

export interface JsonlSessionStoreOptions {
  mode?: JsonlSessionStoreMode;
}

export interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
  needsRewrite: boolean;
}
