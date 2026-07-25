/**
 * Durable orchestrator state snapshot for cold-start restore.
 *
 * Snapshot sits beside the JSONL event log (sidecar file) and captures enough
 * session/run/pending-input projection state to resume service after loading
 * only events with sequence > lastSequence.
 *
 * Write policy (callers):
 * - After successful restore (full or incremental)
 * - After run terminal events (completed / failed / cancelled)
 * - On event-store close when orchestrator can flush
 * Do NOT write on every message-delta / runtime-event.
 *
 * Atomicity: tmp file + rename (same pattern as session-summary / byte-index).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, retryWithBackoff } from "@crish/shared-utils";
import type {
  OrchestratorEventLogMetadata,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  PendingInputRecord
} from "./types";

export const ORCHESTRATOR_STATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ORCHESTRATOR_STATE_SNAPSHOT_TYPE = "orchestrator-state-snapshot" as const;

/** Runtime-event payloads collected during restore for daemon subagent rebuild (single scan). */
export interface RestoredSubagentRuntimeEvent {
  runId: string;
  /** AgentEvent embedded in orchestrator runtime-event payload.event */
  agentEvent: unknown;
}

export interface OrchestratorStateSnapshot {
  type: typeof ORCHESTRATOR_STATE_SNAPSHOT_TYPE;
  schemaVersion: typeof ORCHESTRATOR_STATE_SNAPSHOT_SCHEMA_VERSION;
  eventLogId: string;
  generation: number;
  /** Highest applied event sequence covered by this snapshot. */
  lastSequence: number;
  writtenAt: string;
  sessions: OrchestratorSessionRecord[];
  runs: OrchestratorRunRecord[];
  pendingInputs: PendingInputRecord[];
  /**
   * Optional active-subagent projections at snapshot time.
   * Daemon may restore these without re-scanning the event log.
   */
  activeSubagentProjections?: RestoredSubagentRuntimeEvent[];
}

export function defaultStateSnapshotPath(eventLogPath: string): string {
  return `${eventLogPath}.state-snapshot.json`;
}

/**
 * Validate and return a snapshot, or null if missing/corrupt/mismatched metadata.
 * Callers must fall back to full event replay when this returns null.
 */
export function parseStateSnapshot(
  raw: unknown,
  expected?: Pick<OrchestratorEventLogMetadata, "eventLogId" | "generation">
): OrchestratorStateSnapshot | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== ORCHESTRATOR_STATE_SNAPSHOT_TYPE) return null;
  if (raw.schemaVersion !== ORCHESTRATOR_STATE_SNAPSHOT_SCHEMA_VERSION) return null;
  if (typeof raw.eventLogId !== "string" || raw.eventLogId.length === 0) return null;
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation <= 0) {
    return null;
  }
  if (typeof raw.lastSequence !== "number" || !Number.isInteger(raw.lastSequence) || raw.lastSequence < 0) {
    return null;
  }
  if (typeof raw.writtenAt !== "string" || raw.writtenAt.length === 0) return null;
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.runs) || !Array.isArray(raw.pendingInputs)) {
    return null;
  }
  if (expected) {
    if (raw.eventLogId !== expected.eventLogId || raw.generation !== expected.generation) {
      return null;
    }
  }

  const sessions = raw.sessions.filter(isSessionRecord);
  const runs = raw.runs.filter(isRunRecord);
  const pendingInputs = raw.pendingInputs.filter(isPendingInputRecord);
  // Reject if structural filter dropped entries — snapshot is incomplete/corrupt.
  if (sessions.length !== raw.sessions.length) return null;
  if (runs.length !== raw.runs.length) return null;
  if (pendingInputs.length !== raw.pendingInputs.length) return null;

  let activeSubagentProjections: RestoredSubagentRuntimeEvent[] | undefined;
  if (raw.activeSubagentProjections !== undefined) {
    if (!Array.isArray(raw.activeSubagentProjections)) return null;
    activeSubagentProjections = [];
    for (const item of raw.activeSubagentProjections) {
      if (!isRecord(item) || typeof item.runId !== "string" || item.runId.length === 0) return null;
      activeSubagentProjections.push({ runId: item.runId, agentEvent: item.agentEvent });
    }
  }

  return {
    type: ORCHESTRATOR_STATE_SNAPSHOT_TYPE,
    schemaVersion: ORCHESTRATOR_STATE_SNAPSHOT_SCHEMA_VERSION,
    eventLogId: raw.eventLogId,
    generation: raw.generation,
    lastSequence: raw.lastSequence,
    writtenAt: raw.writtenAt,
    sessions,
    runs,
    pendingInputs,
    ...(activeSubagentProjections ? { activeSubagentProjections } : {})
  };
}

export async function loadStateSnapshotFile(
  snapshotPath: string,
  expected?: Pick<OrchestratorEventLogMetadata, "eventLogId" | "generation">
): Promise<OrchestratorStateSnapshot | null> {
  const raw = await readFile(snapshotPath, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (!raw?.trim()) return null;
  try {
    return parseStateSnapshot(JSON.parse(raw) as unknown, expected);
  } catch {
    return null;
  }
}

/** Atomic write: tmp + rename. */
export async function writeStateSnapshotFile(
  snapshotPath: string,
  snapshot: OrchestratorStateSnapshot
): Promise<void> {
  const body = `${JSON.stringify(snapshot)}\n`;
  await retryWithBackoff(
    async () => {
      await mkdir(dirname(snapshotPath), { recursive: true });
      const tempPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, body, "utf8");
      await rename(tempPath, snapshotPath);
    },
    { maxAttempts: 3, baseMs: 200, maxMs: 1500 }
  );
}

function isSessionRecord(value: unknown): value is OrchestratorSessionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.status === "open" || value.status === "closed" || value.status === "archived")
  );
}

function isRunRecord(value: unknown): value is OrchestratorRunRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isPendingInputRecord(value: unknown): value is PendingInputRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.text === "string" &&
    (value.mode === "after-current-run" || value.mode === "steer") &&
    (value.status === "pending" || value.status === "cancelled" || value.status === "dispatched") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/** Structural probe for event stores that support durable state snapshots. */
export interface StateSnapshotStore {
  loadStateSnapshot(): Promise<OrchestratorStateSnapshot | null>;
  writeStateSnapshot(snapshot: OrchestratorStateSnapshot): Promise<void>;
}

export function asStateSnapshotStore(store: unknown): StateSnapshotStore | undefined {
  if (!isRecord(store)) return undefined;
  if (typeof store.loadStateSnapshot !== "function" || typeof store.writeStateSnapshot !== "function") {
    return undefined;
  }
  return store as unknown as StateSnapshotStore;
}
