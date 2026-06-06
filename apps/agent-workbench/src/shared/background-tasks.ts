import {
  calculateCompletion,
  type WorkbenchBackgroundTask,
  type WorkbenchBackgroundTaskKind,
  type WorkbenchBackgroundTaskState,
  type WorkbenchContinuationDecision,
  type WorkbenchEvidenceItem,
  type WorkbenchTaskSnapshot
} from "./workbench-contract";
import { buildContinuationPrompt, createContinuationDecision } from "./task-controller";

export interface WorkbenchBackgroundTaskStartInput {
  id?: string;
  kind?: WorkbenchBackgroundTaskKind;
  title: string;
  cwd?: string;
  command?: string;
  detail?: string;
  now?: string;
}

export interface WorkbenchBackgroundTaskHeartbeatInput {
  taskId: string;
  detail?: string;
  outputPreview?: string;
  now?: string;
}

export interface WorkbenchBackgroundTaskEndInput {
  taskId: string;
  state?: Extract<WorkbenchBackgroundTaskState, "succeeded" | "failed" | "cancelled" | "timed-out">;
  exitCode?: number | null;
  signal?: string | null;
  summary?: string;
  outputPreview?: string;
  evidenceIds?: string[];
  now?: string;
}

export function startBackgroundTask(
  snapshot: WorkbenchTaskSnapshot,
  input: WorkbenchBackgroundTaskStartInput
): WorkbenchTaskSnapshot {
  const now = input.now ?? new Date().toISOString();
  const task: WorkbenchBackgroundTask = {
    id: input.id ?? createBackgroundTaskId(),
    kind: input.kind ?? "command",
    title: input.title,
    state: "running",
    cwd: input.cwd,
    command: input.command,
    detail: input.detail,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    heartbeatCount: 0
  };

  return {
    ...snapshot,
    state: "running",
    progressLabel: `正在处理：${task.title}`,
    backgroundTasks: [...snapshot.backgroundTasks, task],
    nextActions: ["等待处理完成", "查看计划", "必要时暂停"],
    health: {
      ...snapshot.health,
      state: "busy",
      summary: `正在处理：${task.title}`,
      lastEventAt: now
    }
  };
}

export function recordBackgroundTaskHeartbeat(
  snapshot: WorkbenchTaskSnapshot,
  input: WorkbenchBackgroundTaskHeartbeatInput
): WorkbenchTaskSnapshot {
  const now = input.now ?? new Date().toISOString();
  const nextTasks = snapshot.backgroundTasks.map((task) =>
    task.id === input.taskId
      ? {
          ...task,
          detail: input.detail ?? task.detail,
          outputPreview: input.outputPreview ? compactPreview(input.outputPreview) : task.outputPreview,
          updatedAt: now,
          heartbeatAt: now,
          heartbeatCount: task.heartbeatCount + 1
        }
      : task
  );
  const current = nextTasks.find((task) => task.id === input.taskId);

  return {
    ...snapshot,
    backgroundTasks: nextTasks,
    progressLabel: current ? `正在处理：${current.title}` : snapshot.progressLabel,
    health: {
      ...snapshot.health,
      state: "busy",
      summary: current ? `正在处理：${current.title}` : snapshot.health.summary,
      lastEventAt: now
    }
  };
}

export function finishBackgroundTask(
  snapshot: WorkbenchTaskSnapshot,
  input: WorkbenchBackgroundTaskEndInput
): WorkbenchTaskSnapshot {
  const now = input.now ?? new Date().toISOString();
  const previous = snapshot.backgroundTasks.find((task) => task.id === input.taskId);
  const nextState = input.state ?? (input.exitCode === undefined || input.exitCode === 0 ? "succeeded" : "failed");
  const nextTasks = snapshot.backgroundTasks.map((task) =>
    task.id === input.taskId
      ? {
          ...task,
          state: nextState,
          exitCode: input.exitCode ?? task.exitCode,
          signal: input.signal ?? task.signal,
          summary: input.summary ?? task.summary,
          outputPreview: input.outputPreview ? compactPreview(input.outputPreview) : task.outputPreview,
          evidenceIds: input.evidenceIds ?? task.evidenceIds,
          updatedAt: now,
          finishedAt: now,
          durationMs: task.startedAt ? Math.max(0, Date.parse(now) - Date.parse(task.startedAt)) : task.durationMs
        }
      : task
  );
  const finished = nextTasks.find((task) => task.id === input.taskId);
  const evidence = finished ? [...snapshot.evidence, createBackgroundTaskEvidence(finished, now)] : snapshot.evidence;
  const hasRunningTask = nextTasks.some((task) => task.state === "queued" || task.state === "running");

  return {
    ...snapshot,
    state: hasRunningTask ? "running" : nextState === "succeeded" ? "planning" : "blocked",
    progressLabel: finished
      ? nextState === "succeeded"
        ? `处理完成：${finished.title}`
        : `处理异常：${finished.title}`
      : snapshot.progressLabel,
    completionPercent: calculateCompletion(snapshot),
    evidence,
    backgroundTasks: nextTasks,
    nextActions: previous ? ["继续处理", "查看结果", "必要时暂停"] : snapshot.nextActions,
    health: {
      ...snapshot.health,
      state: nextState === "succeeded" ? "good" : "degraded",
      summary: finished
        ? nextState === "succeeded"
          ? `处理完成：${finished.title}`
          : `处理异常：${finished.title}`
        : snapshot.health.summary,
      lastEventAt: now
    }
  };
}

export function createBackgroundTaskContinuationDecision(
  snapshot: WorkbenchTaskSnapshot,
  taskId: string
): WorkbenchContinuationDecision {
  const task = snapshot.backgroundTasks.find((item) => item.id === taskId);
  if (!task) {
    return {
      action: "pause",
      reason: "没有找到对应的后台处理任务。"
    };
  }
  if (task.state === "queued" || task.state === "running") {
    return {
      action: "pause",
      reason: `后台处理仍在进行：${task.title}`
    };
  }
  if (task.state === "cancelled") {
    return {
      action: "pause",
      reason: `后台处理已取消：${task.title}`
    };
  }

  const base = createContinuationDecision(snapshot);
  if (base.action === "complete") return base;
  if (base.action === "pause" && task.state === "succeeded") return base;

  return {
    action: "continue",
    reason: task.state === "succeeded" ? "后台处理已经完成，可以继续剩余任务。" : "后台处理出现异常，需要先分析结果再继续。",
    prompt: buildBackgroundTaskResumePrompt(snapshot, task)
  };
}

export function buildBackgroundTaskResumePrompt(snapshot: WorkbenchTaskSnapshot, task: WorkbenchBackgroundTask): string {
  return [
    "后台处理已经结束，请根据结果继续当前任务。",
    "",
    "处理项：",
    task.title,
    "",
    "处理状态：",
    summarizeBackgroundTaskState(task.state),
    "",
    "结果摘要：",
    task.summary ?? task.detail ?? "暂无摘要",
    "",
    "输出预览：",
    task.outputPreview ?? "暂无输出预览",
    "",
    buildContinuationPrompt(snapshot)
  ].join("\n");
}

export function summarizeBackgroundTaskState(state: WorkbenchBackgroundTaskState): string {
  switch (state) {
    case "queued":
      return "等待开始";
    case "running":
      return "正在处理";
    case "succeeded":
      return "处理成功";
    case "failed":
      return "处理失败";
    case "cancelled":
      return "已经取消";
    case "timed-out":
      return "处理超时";
  }
}

function createBackgroundTaskEvidence(task: WorkbenchBackgroundTask, now: string): WorkbenchEvidenceItem {
  return {
    id: `evidence-${task.id}`,
    kind: task.kind === "command" ? "command" : "check",
    title: `后台处理：${task.title}`,
    detail: task.summary ?? summarizeBackgroundTaskState(task.state),
    createdAt: now
  };
}

function compactPreview(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= 2_000) return normalized;
  return `${normalized.slice(0, 1_100)}\n\n[中间省略 ${normalized.length - 2_000} 字]\n\n${normalized.slice(-900)}`;
}

function createBackgroundTaskId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
