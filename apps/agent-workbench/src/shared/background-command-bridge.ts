import type { BackgroundCommandEvent, BackgroundCommandSnapshot } from "@crish/agent-runtime";
import {
  createBackgroundTaskContinuationDecision,
  finishBackgroundTask,
  recordBackgroundTaskHeartbeat,
  startBackgroundTask
} from "./background-tasks";
import { applyRuntimeEvidenceInference, isVerificationCommandText, type RuntimeEvidenceSignal } from "./progress-inference";
import { createRunEvent } from "./runtime-bridge";
import type {
  WorkbenchContinuationDecision,
  WorkbenchRunEvent,
  WorkbenchTaskSnapshot,
  WorkbenchBackgroundTaskState
} from "./workbench-contract";

export interface WorkbenchBackgroundCommandBridgeResult {
  snapshot: WorkbenchTaskSnapshot;
  events: WorkbenchRunEvent[];
  continuation?: WorkbenchContinuationDecision;
}

export function applyBackgroundCommandEventToWorkbench(
  snapshot: WorkbenchTaskSnapshot,
  event: BackgroundCommandEvent
): WorkbenchBackgroundCommandBridgeResult {
  if (event.type === "task-start") {
    const nextSnapshot = startBackgroundTask(snapshot, {
      id: event.task.id,
      kind: "command",
      title: commandTitle(event.task),
      cwd: event.task.cwd,
      command: event.task.command,
      detail: "命令已经开始执行。",
      now: event.timestamp
    });
    return {
      snapshot: nextSnapshot,
      events: [
        createRunEvent("background-task-start", `开始处理：${commandTitle(event.task)}`, {
          backgroundTask: nextSnapshot.backgroundTasks.find((task) => task.id === event.task.id),
          commandTask: compactCommandTask(event.task)
        })
      ]
    };
  }

  if (event.type === "task-output") {
    const nextSnapshot = recordBackgroundTaskHeartbeat(snapshot, {
      taskId: event.task.id,
      detail: event.stream === "stdout" ? "收到新的输出进度。" : "收到新的错误输出。",
      outputPreview: event.task.outputPreview,
      now: event.timestamp
    });
    return {
      snapshot: nextSnapshot,
      events: [
        createRunEvent("background-task-heartbeat", `处理进度：${commandTitle(event.task)}`, {
          stream: event.stream,
          backgroundTask: nextSnapshot.backgroundTasks.find((task) => task.id === event.task.id),
          commandTask: compactCommandTask(event.task)
        })
      ]
    };
  }

  if (event.type === "task-heartbeat") {
    const nextSnapshot = recordBackgroundTaskHeartbeat(snapshot, {
      taskId: event.task.id,
      detail: "命令仍在运行。",
      now: event.timestamp
    });
    return {
      snapshot: nextSnapshot,
      events: [
        createRunEvent("background-task-heartbeat", `处理进度：${commandTitle(event.task)}`, {
          heartbeatOnly: true,
          backgroundTask: nextSnapshot.backgroundTasks.find((task) => task.id === event.task.id),
          commandTask: compactCommandTask(event.task)
        })
      ]
    };
  }

  const finishedSnapshot = finishBackgroundTask(snapshot, {
    taskId: event.task.id,
    state: mapBackgroundCommandState(event.task),
    exitCode: event.task.exitCode,
    signal: event.task.signal,
    summary: summarizeBackgroundCommand(event.task),
    outputPreview: event.task.outputPreview,
    now: event.timestamp
  });
  const nextSnapshot = applyRuntimeEvidenceInference(finishedSnapshot, {
    signals: evidenceSignalsForBackgroundCommand(event.task),
    evidenceIds: [`evidence-${event.task.id}`]
  });
  const continuation = createBackgroundTaskContinuationDecision(nextSnapshot, event.task.id);
  const snapshotWithContinuation = continuation.prompt
    ? {
        ...nextSnapshot,
        backgroundTasks: nextSnapshot.backgroundTasks.map((task) =>
          task.id === event.task.id ? { ...task, continuationPrompt: continuation.prompt } : task
        )
      }
    : nextSnapshot;
  const events = [
    createRunEvent("background-task-end", `处理结束：${commandTitle(event.task)}`, {
      backgroundTask: snapshotWithContinuation.backgroundTasks.find((task) => task.id === event.task.id),
      commandTask: compactCommandTask(event.task),
      continuation
    })
  ];
  if (continuation.action === "continue") {
    events.push(
      createRunEvent("resume-requested", "处理已经结束，可以继续当前任务。", {
        taskId: event.task.id,
        continuation
      })
    );
  }
  return {
    snapshot: snapshotWithContinuation,
    events,
    continuation
  };
}

export function summarizeBackgroundCommand(task: BackgroundCommandSnapshot): string {
  if (task.state === "succeeded") {
    return `命令执行成功，退出码 ${task.exitCode ?? 0}。`;
  }
  if (task.state === "timed-out") {
    return `命令执行超时，已等待 ${(task.timeoutMs / 60_000).toFixed(1)} 分钟。`;
  }
  if (task.state === "cancelled") {
    return "命令已经取消。";
  }
  return `命令执行失败，退出码 ${task.exitCode ?? "未知"}。`;
}

function mapBackgroundCommandState(task: BackgroundCommandSnapshot): Extract<
  WorkbenchBackgroundTaskState,
  "succeeded" | "failed" | "cancelled" | "timed-out"
> {
  if (task.state === "succeeded" || task.state === "cancelled" || task.state === "timed-out") {
    return task.state;
  }
  return "failed";
}

function compactCommandTask(task: BackgroundCommandSnapshot): Record<string, unknown> {
  return {
    id: task.id,
    command: task.command,
    cwd: task.cwd,
    state: task.state,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
    truncated: task.truncated
  };
}

function evidenceSignalsForBackgroundCommand(task: BackgroundCommandSnapshot): RuntimeEvidenceSignal[] {
  if (task.state !== "succeeded" || task.exitCode !== 0) return [];
  const signals = new Set<RuntimeEvidenceSignal>(["execute"]);
  if (isVerificationCommandText(task.command)) signals.add("check");
  return [...signals];
}

function commandTitle(task: BackgroundCommandSnapshot): string {
  return task.command.length <= 80 ? task.command : `${task.command.slice(0, 77)}...`;
}
