import type { JsonObject } from "@crish/shared-types";
import type { WritableTextFileEncoding } from "../../encoding";

export const EDIT_OPERATION_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["replace", "replace_text", "insert_before", "insert_after", "insert_head", "insert_tail", "delete"]
    },
    startLine: { type: "number" },
    endLine: { type: "number" },
    line: { type: "number" },
    content: { type: "string" },
    old_string: {
      type: "string",
      description: "Exact/fuzzy text to find (replace_text). Prefer over line numbers when content may drift."
    },
    new_string: { type: "string", description: "Replacement text for replace_text (may be empty)." },
    oldString: { type: "string", description: "CamelCase alias of old_string." },
    newString: { type: "string", description: "CamelCase alias of new_string." }
  },
  required: ["op"],
  additionalProperties: false
};

export interface EditOperation {
  op: "replace" | "replace_text" | "insert_before" | "insert_after" | "insert_head" | "insert_tail" | "delete";
  startLine?: number;
  endLine?: number;
  line?: number;
  content?: string;
  oldString?: string;
  newString?: string;
}

export interface WorkspaceEditFileRequest {
  input: JsonObject;
  filePath: string;
  relativePath: string;
  fullContent?: string;
  edits: EditOperation[];
  encoding?: string;
}

export type WorkspaceEditSnapshotTagSource = "input" | "latest-read" | "none";

export interface PreparedWorkspaceEditFile extends WorkspaceEditFileRequest {
  existed: boolean;
  beforeBytes: Buffer | null;
  beforeText: string;
  afterText: string;
  changed: boolean;
  writeEncoding: WritableTextFileEncoding;
  snapshotTag: string | null;
  requestedSnapshotTag: string | null;
  snapshotTagSource: WorkspaceEditSnapshotTagSource;
  createdParentDirectories: boolean;
  parentDirectory: string;
}

export interface AppliedWorkspaceEditFile extends PreparedWorkspaceEditFile {
  newSnapshotTag: string;
  charsBefore: number;
  charsAfter: number;
}

export interface WorkspaceEditRollbackState {
  filePath: string;
  relativePath: string;
  existed: boolean;
  bytes: Buffer | null;
}

export interface WorkspaceEditRollbackSummary {
  restored: string[];
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

export type ApplyPreparedWorkspaceEditFilesResult =
  | { ok: true; files: AppliedWorkspaceEditFile[] }
  | {
      ok: false;
      error: string;
      failedPath?: string;
      rollback: WorkspaceEditRollbackSummary;
    };

export interface EditResultPreview {
  mode: "full" | "changed-range";
  summary: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  omittedLines: number;
}
