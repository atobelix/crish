import type { JsonObject } from "@crish/shared-types";
import type { DaemonRunStatus } from "./daemon-session";
import type {
  WorkbenchMode,
  WorkbenchRunState,
  WorkbenchPlanState,
  WorkbenchPlanItem,
  WorkbenchHealth,
  WorkbenchBackgroundTask,
  WorkbenchTaskSnapshot,
} from "./workbench-ui";
import { buildInitialTaskSnapshot } from "./ui-projections";

export type DaemonTaskMessageRole = "system" | "user" | "assistant";

export interface DaemonTaskMessageSnapshot {
  id: string;
  role: DaemonTaskMessageRole;
  content: string;
  createdAt: string;
  toolCalls?: DaemonTaskSnapshotToolCall[];
}

export interface DaemonTaskSnapshotToolCall {
  id: string;
  name: string;
  input: JsonObject;
  status: "pending" | "running" | "approval-required" | "completed" | "failed";
  summary?: string;
  metadata?: JsonObject;
  startedAt: string;
  updatedAt: string;
  output?: string;
}

export interface DaemonTaskSnapshotApproval {
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  summary: string;
  requestedAt: string;
  status: "pending";
  metadata?: JsonObject;
}

export interface DaemonBackgroundTaskSnapshot {
  id: string;
  kind: "command";
  title: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
  command: string;
  cwd?: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  outputPreview?: string;
}

export interface DaemonTaskSnapshotRunMetadata {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  metadata: JsonObject;
}

export interface DaemonTaskSnapshot {
  runId: string;
  sessionId: string;
  status: DaemonRunStatus;
  title: string;
  messages: DaemonTaskMessageSnapshot[];
  latestError?: string;
  approval?: DaemonTaskSnapshotApproval;
  pendingToolCalls: DaemonTaskSnapshotToolCall[];
  backgroundTasks: DaemonBackgroundTaskSnapshot[];
  progress?: DaemonTaskSnapshotProgress;
  usage?: DaemonTaskSnapshotUsage;
  cache?: DaemonTaskSnapshotCache;
  updatedAt: string;
  progressLabel: string;
  currentRun: DaemonTaskSnapshotRunMetadata;
}

export interface DaemonTaskSnapshotProgress {
  label: string;
  eventCount: number;
  turnCount: number;
  textDeltaCount: number;
  toolCallCount: number;
  completedToolCallCount: number;
  pendingToolCallCount: number;
  approvalPending: boolean;
  updatedAt: string;
}

export interface DaemonTaskSnapshotUsage {
  sampleCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface DaemonTaskSnapshotCache {
  sampleCount: number;
  promptTokens: number;
  readTokens: number;
  writeTokens: number;
  missTokens: number;
  hitRatio: number;
  writeRatio: number;
  stablePrefixHash?: string;
  cacheKey?: string;
  cacheStrategy?: string;
}

export interface DaemonTaskProjectionOptions {
  previous?: WorkbenchTaskSnapshot | null;
  now?: number;
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseDateMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function projectNameFromPath(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "当前项目";
}

function workbenchModeFromMetadata(metadata?: JsonObject): WorkbenchMode {
  const mode = metadataString(metadata, "mode");
  return mode === "execute" || mode === "review" || mode === "discuss" || mode === "plan" ? mode : "plan";
}

function workbenchStateFromDaemonStatus(status: DaemonRunStatus): WorkbenchRunState {
  switch (status) {
    case "queued":
      return "planning";
    case "running":
      return "running";
    case "awaiting-approval":
    case "cancelling":
      return "waiting";
    case "completed":
      return "done";
    case "cancelled":
    case "failed":
      return "blocked";
    default:
      return "idle";
  }
}

function completionForDaemonStatus(status: DaemonRunStatus, previous: number): number {
  const fallback: Record<DaemonRunStatus, number> = {
    queued: 10,
    running: 45,
    "awaiting-approval": 60,
    cancelling: 70,
    cancelled: 70,
    completed: 100,
    failed: 75
  };
  return Math.max(previous, fallback[status] ?? previous);
}

function progressLabelForDaemonStatus(status: DaemonRunStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "awaiting-approval":
      return "Awaiting approval";
    case "cancelling":
      return "Cancelling";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

function nextActionsForDaemonStatus(status: DaemonRunStatus, hasConfirmation: boolean): string[] {
  if (hasConfirmation) return ["Review approval", "Approve or deny", "Continue after decision"];
  switch (status) {
    case "completed":
      return ["Review result", "Inspect changes", "Start next task"];
    case "failed":
      return ["Inspect error", "Retry with context", "Open event log"];
    case "cancelled":
      return ["Review partial output", "Resume if needed", "Start next task"];
    default:
      return ["Monitor progress", "Review events", "Cancel if needed"];
  }
}

function healthForDaemonStatus(
  status: DaemonRunStatus,
  latestError?: string
): Pick<WorkbenchHealth, "state" | "summary"> {
  if (latestError || status === "failed") return { state: "degraded", summary: latestError ?? "Run failed" };
  if (status === "running" || status === "queued" || status === "cancelling") {
    return { state: "busy", summary: progressLabelForDaemonStatus(status) };
  }
  return { state: "good", summary: progressLabelForDaemonStatus(status) };
}

function advancePlanForDaemonStatus(plan: WorkbenchPlanItem[], status: DaemonRunStatus): WorkbenchPlanItem[] {
  const next = plan.map((item) => ({ ...item }));
  const mark = (id: string, state: WorkbenchPlanState) => {
    const item = next.find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.state === "done" && state !== "blocked") return;
    item.state = state;
  };

  if (status === "queued") {
    mark("understand", "doing");
    return next;
  }
  if (status === "running" || status === "awaiting-approval" || status === "cancelling") {
    mark("understand", "done");
    mark("inspect", "done");
    mark("execute", status === "awaiting-approval" ? "blocked" : "doing");
    return next;
  }
  if (status === "completed") {
    return next.map((item) => ({ ...item, state: "done" }));
  }
  if (status === "failed" || status === "cancelled") {
    mark("understand", "done");
    mark("inspect", "done");
    mark("execute", "blocked");
  }
  return next;
}

function projectDaemonBackgroundTask(
  task: DaemonBackgroundTaskSnapshot,
  previous?: WorkbenchBackgroundTask
): WorkbenchBackgroundTask {
  return {
    id: task.id,
    kind: "command",
    title: task.title,
    state: task.state,
    ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
    command: task.command,
    ...(task.outputPreview !== undefined ? { detail: task.outputPreview } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    updatedAt: task.updatedAt,
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    heartbeatAt: previous?.heartbeatAt ?? task.updatedAt,
    heartbeatCount: previous?.heartbeatCount ?? (task.state === "running" ? 1 : 0),
    ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
    ...(task.outputPreview !== undefined ? { summary: task.outputPreview } : {}),
    ...(task.outputPreview !== undefined ? { outputPreview: task.outputPreview } : {}),
    ...(previous?.evidenceIds !== undefined ? { evidenceIds: previous.evidenceIds } : {}),
  };
}

export function projectDaemonTaskSnapshotToWorkbench(
  snapshot: DaemonTaskSnapshot,
  options: DaemonTaskProjectionOptions = {}
): WorkbenchTaskSnapshot {
  const now = options.now ?? Date.now();
  const cwd = snapshot.currentRun.cwd || options.previous?.project.path || "";
  const previous = options.previous ?? buildInitialTaskSnapshot(cwd, now);
  const updatedAt = parseDateMs(snapshot.updatedAt, now);
  const metadata = snapshot.currentRun.metadata;
  const mode = workbenchModeFromMetadata(metadata);
  const userGoal = metadataString(metadata, "prompt") ?? previous.userGoal;
  const title = snapshot.title || userGoal || previous.title;
  const statusState = workbenchStateFromDaemonStatus(snapshot.status);
  const confirmations = snapshot.approval
    ? [
        {
          id: snapshot.approval.toolCallId,
          kind: "write" as const,
          title: `Approve ${snapshot.approval.toolName}`,
          detail: snapshot.approval.summary,
          primaryAction: "Approve",
          secondaryAction: "Deny"
        }
      ]
    : [];

  return {
    ...previous,
    id: snapshot.runId,
    project: {
      id: snapshot.sessionId,
      name: projectNameFromPath(cwd),
      path: cwd,
      updatedAt
    },
    mode,
    state: confirmations.length > 0 ? "waiting" : statusState,
    title,
    userGoal,
    progressLabel: snapshot.progressLabel || progressLabelForDaemonStatus(snapshot.status),
    completionPercent: completionForDaemonStatus(snapshot.status, previous.completionPercent),
    plan: advancePlanForDaemonStatus(previous.plan, snapshot.status),
    confirmations,
    backgroundTasks: snapshot.backgroundTasks.map((task) =>
      projectDaemonBackgroundTask(task, previous.backgroundTasks.find((item) => item.id === task.id))
    ),
    nextActions: nextActionsForDaemonStatus(snapshot.status, confirmations.length > 0),
    health: {
      ...previous.health,
      ...healthForDaemonStatus(snapshot.status, snapshot.latestError),
      lastEventAt: snapshot.updatedAt
    }
  };
}
