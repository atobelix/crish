import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { errorMessage } from "@crish/shared-utils";
import type { JsonObject } from "@crish/shared-types";
import {
  CheckpointManifestService,
  ConversationBoundaryManifestService,
  JsonlSessionStore,
  resolveConversationRewindTargetFacts,
  type CheckpointManifestRecord,
  type ConversationBoundaryManifestRecord,
  type ConversationRewindBoundaryTargetMode,
  type ConversationRewindMissingFact,
  type ConversationRewindTargetFacts,
  type SessionEntry,
} from "@crish/agent-runtime";
import {
  planConversationRewindFromTargetFacts,
  type AgentOrchestrator,
  type ConversationRewindPlanWithTargetFacts,
  type ConversationRewindRestorePolicy,
  type SessionTreeEntry,
} from "@crish/agent-orchestrator";
import type { ApprovalQueue } from "./approval-queue.js";
import type { ConversationRewindActiveSubagentRecord, DaemonConfig } from "./types.js";
import {
  resolveDaemonConversationBoundaryManifestPath,
  resolveDaemonCheckpointManifestPath,
  resolveDaemonRuntimeSessionDir,
} from "./persistence.js";

export type DaemonConversationRewindBoundaryMissingFact =
  | ConversationRewindMissingFact
  | "boundary-record"
  | "checkpoint-manifest-record"
  | "session-record"
  | "session-tree-entries";

export interface DaemonConversationRewindBoundaryDiagnostic {
  code: string;
  fact: DaemonConversationRewindBoundaryMissingFact;
  message: string;
  blocked: boolean;
  metadata?: JsonObject;
}

export interface ResolveConversationRewindBoundaryInput {
  config: Pick<DaemonConfig, "sessionEventLogDir">;
  sessionId: string;
  userMessageId?: string;
  latestUserMessage?: boolean;
  mode?: ConversationRewindBoundaryTargetMode;
}

export interface PreviewConversationRewindByBoundaryInput extends ResolveConversationRewindBoundaryInput {
  orchestrator: AgentOrchestrator;
  approvalQueue: ApprovalQueue;
  restorePolicy?: ConversationRewindRestorePolicy;
  activeSubagents?: ConversationRewindActiveSubagentRecord[];
}

export interface DaemonConversationRewindBoundaryResult {
  status: "ok" | "blocked";
  sessionId: string;
  userMessageId?: string;
  latestUserMessage: boolean;
  mode: ConversationRewindBoundaryTargetMode;
  boundary?: ConversationBoundaryManifestRecord;
  checkpoint?: CheckpointManifestRecord;
  target?: ConversationRewindTargetFacts;
  missingFacts: DaemonConversationRewindBoundaryMissingFact[];
  diagnostics: DaemonConversationRewindBoundaryDiagnostic[];
}

export interface DaemonConversationRewindBoundaryPreviewResult extends DaemonConversationRewindBoundaryResult {
  plan?: ConversationRewindPlanWithTargetFacts["plan"];
  runtimeTargetLeafId?: string;
}

export async function resolveConversationRewindBoundary(
  input: ResolveConversationRewindBoundaryInput
): Promise<DaemonConversationRewindBoundaryResult> {
  const mode = input.mode ?? "keep-user-message";
  const latestUserMessage = input.latestUserMessage ?? input.userMessageId === undefined;
  const diagnostics: DaemonConversationRewindBoundaryDiagnostic[] = [];

  if (!latestUserMessage && !input.userMessageId) {
    diagnostics.push(diagnostic("REWIND_BOUNDARY_SELECTOR_MISSING", "boundary-record", "userMessageId is required unless latestUserMessage is true."));
    return boundaryResult(input, mode, latestUserMessage, diagnostics);
  }

  const boundaryManifest = new ConversationBoundaryManifestService({
    manifestPath: resolveDaemonConversationBoundaryManifestPath(input.config),
  });
  const boundary = latestUserMessage
    ? await boundaryManifest.findLatest({ sessionId: input.sessionId })
    : await boundaryManifest.findLatest({ sessionId: input.sessionId, userMessageId: input.userMessageId });

  if (!boundary) {
    diagnostics.push(
      diagnostic("REWIND_BOUNDARY_NOT_FOUND", "boundary-record", "No conversation rewind boundary record matches the request.", {
        sessionId: input.sessionId,
        ...(input.userMessageId !== undefined ? { userMessageId: input.userMessageId } : {}),
        latestUserMessage,
      })
    );
    return boundaryResult(input, mode, latestUserMessage, diagnostics);
  }

  const checkpointManifest = new CheckpointManifestService({
    manifestPath: resolveDaemonCheckpointManifestPath(input.config),
  });
  const checkpoint = await checkpointManifest.findLatestForRewindBoundary({
    sessionId: boundary.sessionId,
    userMessageId: boundary.userMessageId,
  });

  let target: ConversationRewindTargetFacts | undefined;
  try {
    target = resolveConversationRewindTargetFacts({
      boundary,
      checkpoint,
      mode,
    });
  } catch (error) {
    diagnostics.push(
      diagnostic("REWIND_BOUNDARY_CHECKPOINT_MISMATCH", "checkpoint-manifest-record", errorMessage(error), {
        sessionId: boundary.sessionId,
        userMessageId: boundary.userMessageId,
      })
    );
    return boundaryResult(input, mode, latestUserMessage, diagnostics, boundary, checkpoint);
  }

  for (const fact of target.missingFacts) {
    diagnostics.push(diagnostic(codeForMissingFact(fact), fact, messageForMissingFact(fact)));
  }

  return boundaryResult(input, mode, latestUserMessage, diagnostics, boundary, checkpoint, target);
}

export async function previewConversationRewindByBoundary(
  input: PreviewConversationRewindByBoundaryInput
): Promise<DaemonConversationRewindBoundaryPreviewResult> {
  const resolved = await resolveConversationRewindBoundary(input);
  const diagnostics = [...resolved.diagnostics];

  const session = input.orchestrator.getSession(input.sessionId);
  if (!session) {
    diagnostics.push(diagnostic("REWIND_SESSION_NOT_FOUND", "session-record", `Session not found: ${input.sessionId}`));
  }

  const entries = session ? await readSessionTreeEntries(input.config, session.cwd, session.id) : [];
  if (session && entries.length === 0) {
    diagnostics.push(
      diagnostic("REWIND_SESSION_TREE_ENTRIES_MISSING", "session-tree-entries", "Runtime session entries are missing; cannot preview a rewind plan.")
    );
  }

  if (!resolved.target?.sessionTreeTargetLeafId) {
    if (!resolved.missingFacts.includes("session-tree-target-leaf")) {
      diagnostics.push(diagnostic("REWIND_SESSION_TREE_TARGET_MISSING", "session-tree-target-leaf", messageForMissingFact("session-tree-target-leaf")));
    }
  } else if (entries.length > 0 && !entries.some((entry) => entry.id === resolved.target?.sessionTreeTargetLeafId)) {
    diagnostics.push(
      diagnostic("REWIND_SESSION_TREE_TARGET_NOT_FOUND", "session-tree-target-leaf", "The resolved session tree target leaf is not present in the runtime session entries.", {
        targetLeafId: resolved.target.sessionTreeTargetLeafId,
      })
    );
  }

  if (diagnostics.some((item) => item.blocked)) {
    return {
      ...resolved,
      status: "blocked",
      missingFacts: mergeMissingFacts(resolved.missingFacts, diagnostics),
      diagnostics,
    };
  }

  const planned = planConversationRewindFromTargetFacts({
    session: session!,
    entries,
    target: resolved.target!,
    runs: input.orchestrator.listRuns(),
    pendingApprovals: input.approvalQueue.getPendingApprovals().map((approval) => ({
      toolCallId: approval.toolCallId,
      runId: approval.runId,
    })),
    activeSubagents: input.activeSubagents ?? [],
    ...(input.restorePolicy !== undefined ? { restorePolicy: input.restorePolicy } : {}),
  });

  return {
    ...resolved,
    status: "ok",
    diagnostics,
    missingFacts: mergeMissingFacts(resolved.missingFacts, diagnostics),
    plan: planned.plan,
    ...(planned.runtimeTargetLeafId !== undefined ? { runtimeTargetLeafId: planned.runtimeTargetLeafId } : {}),
  };
}

function boundaryResult(
  input: ResolveConversationRewindBoundaryInput,
  mode: ConversationRewindBoundaryTargetMode,
  latestUserMessage: boolean,
  diagnostics: DaemonConversationRewindBoundaryDiagnostic[],
  boundary?: ConversationBoundaryManifestRecord,
  checkpoint?: CheckpointManifestRecord,
  target?: ConversationRewindTargetFacts
): DaemonConversationRewindBoundaryResult {
  return {
    status: diagnostics.some((item) => item.blocked) ? "blocked" : "ok",
    sessionId: input.sessionId,
    userMessageId: boundary?.userMessageId ?? input.userMessageId,
    latestUserMessage,
    mode,
    ...(boundary !== undefined ? { boundary } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(target !== undefined ? { target } : {}),
    missingFacts: mergeMissingFacts(target?.missingFacts ?? [], diagnostics),
    diagnostics,
  };
}

export async function readSessionTreeEntries(
  config: Pick<DaemonConfig, "sessionEventLogDir">,
  cwd: string,
  sessionId: string
): Promise<SessionTreeEntry[]> {
  const store = new JsonlSessionStore(runtimeSessionStorePath(config, sessionId, cwd), { mode: "append" });
  const entries = await store.readAll();
  return entries.flatMap(sessionEntryToTreeEntry);
}

function sessionEntryToTreeEntry(entry: SessionEntry): SessionTreeEntry[] {
  if (entry.type === "message") {
    return [
      {
        type: "node",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        payload: {
          source: "runtime-session",
          entryType: entry.type,
          messageId: entry.message.id,
          role: entry.message.role,
          blockTypes: entry.message.blocks.map((block) => block.type),
          summary: summarizeSessionEntry(entry),
        },
      },
    ];
  }
  if (entry.type === "checkpoint") {
    return [
      {
        type: "node",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        payload: { label: entry.label, ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}) },
      },
    ];
  }
  if (entry.type === "compaction") {
    return [
      {
        type: "branch_summary",
        id: entry.id,
        parentId: entry.parentId,
        createdAt: entry.timestamp,
        summary: entry.record.summary,
        abandonedLeafId: entry.parentId,
        details: { source: "runtime-session", entryType: entry.type, compactionId: entry.record.id },
      },
    ];
  }
  return [];
}

export function runtimeSessionStorePath(
  config: Pick<DaemonConfig, "sessionEventLogDir">,
  sessionId: string,
  cwd: string
): string {
  const root = resolveDaemonRuntimeSessionDir(config);
  const cwdHash = createHash("sha256").update(workspaceCoordinatorKey(cwd)).digest("hex").slice(0, 16);
  return join(root, `${safePathSegment(sessionId)}-${cwdHash}.jsonl`);
}

function workspaceCoordinatorKey(cwd: string): string {
  return process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}

function summarizeSessionEntry(entry: Extract<SessionEntry, { type: "message" }>): string {
  const text = entry.message.blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool-call") return `tool-call:${block.toolName}`;
      if (block.type === "tool-result") return `tool-result:${block.toolCallId}`;
      return block.type;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 160) || entry.message.role;
}

function diagnostic(
  code: string,
  fact: DaemonConversationRewindBoundaryMissingFact,
  message: string,
  metadata?: JsonObject
): DaemonConversationRewindBoundaryDiagnostic {
  return {
    code,
    fact,
    message,
    blocked: true,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function mergeMissingFacts(
  missingFacts: readonly DaemonConversationRewindBoundaryMissingFact[],
  diagnostics: readonly DaemonConversationRewindBoundaryDiagnostic[]
): DaemonConversationRewindBoundaryMissingFact[] {
  return [...new Set([...missingFacts, ...diagnostics.filter((item) => item.blocked).map((item) => item.fact)])];
}

function codeForMissingFact(fact: ConversationRewindMissingFact): string {
  if (fact === "session-tree-target-leaf") return "REWIND_SESSION_TREE_TARGET_MISSING";
  if (fact === "runtime-target-leaf") return "REWIND_RUNTIME_TARGET_MISSING";
  return "REWIND_WORKSPACE_CHECKPOINT_MISSING";
}

function messageForMissingFact(fact: ConversationRewindMissingFact): string {
  if (fact === "session-tree-target-leaf") return "Boundary record is missing the session tree target leaf.";
  if (fact === "runtime-target-leaf") return "Boundary record is missing the runtime target leaf.";
  return "Boundary and checkpoint manifests do not provide a workspace checkpoint.";
}


