import { relative, resolve } from "node:path";
import {
  BackgroundCommandManager,
  type BackgroundCommandManagerOptions,
  type BackgroundCommandSnapshot,
  type BackgroundCommandStartInput,
} from "@crish/agent-runtime";
import { BoundedMap } from "@crish/shared-utils";
import { getDaemonLogger, toLogErr } from "./daemon-logger.js";
import type {
  DaemonBackgroundTaskDiagnostic,
  DaemonBackgroundTaskSnapshot,
} from "./types.js";

/** workspace manager 上限：daemon 长跑场景下可能切换多个 workspace，按 FIFO 淘汰最旧。 */
const MAX_WORKSPACE_MANAGERS = 50;

export interface DaemonBackgroundTaskStartInput extends BackgroundCommandStartInput {
  workspaceRoot?: string;
}

export interface DaemonBackgroundTaskQuery {
  includeHistory?: boolean;
  state?: DaemonBackgroundTaskSnapshot["state"];
  limit?: number;
}

export class DaemonBackgroundTaskError extends Error {
  constructor(
    readonly code: "BACKGROUND_TASK_NOT_FOUND" | "BACKGROUND_TASK_START_FAILED" | "BACKGROUND_TASK_CANCEL_FAILED",
    message: string
  ) {
    super(message);
    this.name = "DaemonBackgroundTaskError";
  }
}

export class DaemonBackgroundTaskManager {
  private readonly managers = new BoundedMap<string, BackgroundCommandManager>(MAX_WORKSPACE_MANAGERS, undefined);

  constructor(
    private readonly options: {
      defaultWorkspaceRoot: string;
      managerOptions?: Omit<BackgroundCommandManagerOptions, "workspaceRoot">;
    }
  ) {}

  getManagerForWorkspace(workspaceRoot: string): BackgroundCommandManager {
    const root = normalizeWorkspaceRoot(workspaceRoot);
    let manager = this.managers.get(root);
    if (!manager) {
      manager = new BackgroundCommandManager({
        workspaceRoot: root,
        ...this.options.managerOptions,
      });
      this.managers.set(root, manager);
    }
    return manager;
  }

  getManagerForCwd(cwd: string): BackgroundCommandManager {
    return this.getManagerForWorkspace(cwd);
  }

  async start(input: DaemonBackgroundTaskStartInput): Promise<DaemonBackgroundTaskSnapshot> {
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot ?? input.cwd ?? this.options.defaultWorkspaceRoot);
    const manager = this.getManagerForWorkspace(workspaceRoot);
    const cwd = input.cwd ? cwdForManager(workspaceRoot, input.cwd) : ".";
    try {
      const task = await manager.start({
        command: input.command,
        cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        heartbeatIntervalMs: input.heartbeatIntervalMs,
      });
      return daemonTaskFromRuntimeTask(task);
    } catch (error) {
      throw new DaemonBackgroundTaskError(
        "BACKGROUND_TASK_START_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  get(taskId: string): DaemonBackgroundTaskSnapshot | undefined {
    const task = this.findRuntimeTask(taskId);
    return task ? daemonTaskFromRuntimeTask(task.task) : undefined;
  }

  list(query: DaemonBackgroundTaskQuery = {}): DaemonBackgroundTaskSnapshot[] {
    const includeHistory = query.includeHistory ?? true;
    const tasks = this.allRuntimeTasks()
      .map(daemonTaskFromRuntimeTask)
      .filter((task) => (includeHistory || task.state === "running") && (query.state ? task.state === query.state : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return limitTasks(tasks, query.limit);
  }

  history(query: Omit<DaemonBackgroundTaskQuery, "includeHistory"> = {}): DaemonBackgroundTaskSnapshot[] {
    const terminal = new Set<DaemonBackgroundTaskSnapshot["state"]>([
      "succeeded",
      "failed",
      "cancelled",
      "timed-out",
    ]);
    const tasks = this.allRuntimeTasks()
      .map(daemonTaskFromRuntimeTask)
      .filter((task) => terminal.has(task.state) && (query.state ? task.state === query.state : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return limitTasks(tasks, query.limit);
  }

  cancel(taskId: string): DaemonBackgroundTaskSnapshot {
    const found = this.findRuntimeTask(taskId);
    if (!found) {
      throw new DaemonBackgroundTaskError("BACKGROUND_TASK_NOT_FOUND", `Background task not found: ${taskId}`);
    }
    try {
      return daemonTaskFromRuntimeTask(found.manager.cancel(taskId));
    } catch (error) {
      throw new DaemonBackgroundTaskError(
        "BACKGROUND_TASK_CANCEL_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * 关停全部 workspace 的全部后台任务并清理追踪状态。
   *
   * 异常路径兜底：daemon 关停时调用。逐个 dispose 每个 workspace 的
   * BackgroundCommandManager，终止运行中子进程 + 清理定时器 + 清空 Map。
   * 幂等：多次调用安全（managers Map dispose 后清空）。
   */
  dispose(): void {
    for (const manager of this.managers.values()) {
      try {
        manager.dispose();
      } catch (error) {
        getDaemonLogger().error('Background task manager dispose failed', { module: 'DaemonBackgroundTaskManager', err: toLogErr(error) });
      }
    }
    this.managers.clear();
  }

  private allRuntimeTasks(): BackgroundCommandSnapshot[] {
    return [...this.managers.values()].flatMap((manager) => manager.list());
  }

  private findRuntimeTask(taskId: string): { manager: BackgroundCommandManager; task: BackgroundCommandSnapshot } | undefined {
    for (const manager of this.managers.values()) {
      const task = manager.get(taskId);
      if (task) return { manager, task };
    }
    return undefined;
  }
}

export function daemonBackgroundDiagnostics(tasks: DaemonBackgroundTaskSnapshot[]): DaemonBackgroundTaskDiagnostic[] {
  const now = new Date().toISOString();
  return [
    {
      code: "BACKGROUND_TASK_SNAPSHOT_READY",
      message: "Daemon background task snapshot is backed by the shared background command manager.",
      severity: "info",
      updatedAt: now,
      detail: undefined,
      metadata: {
        taskCount: tasks.length,
        runningCount: tasks.filter((task) => task.state === "running").length,
      },
    },
  ];
}

function daemonTaskFromRuntimeTask(task: BackgroundCommandSnapshot): DaemonBackgroundTaskSnapshot {
  const diagnostics: DaemonBackgroundTaskDiagnostic[] = task.terminationDiagnostics.map((diagnostic) => ({
    code: diagnostic.ok ? "PROCESS_TERMINATION_OK" : "PROCESS_TERMINATION_FAILED",
    message: diagnostic.message ?? `${diagnostic.strategy} ${diagnostic.ok ? "succeeded" : "failed"}`,
    severity: diagnostic.ok ? "info" : "warning",
    updatedAt: task.updatedAt,
    detail: undefined,
    metadata: {
      platform: diagnostic.platform,
      strategy: diagnostic.strategy,
      ok: diagnostic.ok,
      ...(diagnostic.exitCode !== undefined ? { exitCode: diagnostic.exitCode } : {}),
      ...(diagnostic.signal !== undefined ? { signal: diagnostic.signal } : {}),
    },
  }));
  if (task.error) {
    diagnostics.push({
      code: "BACKGROUND_TASK_ERROR",
      message: task.error,
      severity: "error",
      updatedAt: task.updatedAt,
      detail: undefined,
      metadata: undefined,
    });
  }
  if (task.timedOut) {
    diagnostics.push({
      code: "BACKGROUND_TASK_TIMED_OUT",
      message: `Background task timed out after ${task.timeoutMs}ms.`,
      severity: "warning",
      updatedAt: task.updatedAt,
      detail: undefined,
      metadata: { timeoutMs: task.timeoutMs },
    });
  }

  return {
    id: task.id,
    kind: "command",
    title: task.command,
    state: task.state,
    command: task.command,
    cwd: task.cwd,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    durationMs: task.durationMs,
    timeoutMs: task.timeoutMs,
    exitCode: task.exitCode,
    signal: task.signal,
    timedOut: task.timedOut,
    cancelled: task.cancelled,
    truncated: task.truncated,
    stdoutBytes: task.stdoutBytes,
    stderrBytes: task.stderrBytes,
    outputPreview: task.outputPreview,
    diagnostics,
  };
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot);
}

function cwdForManager(workspaceRoot: string, cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const relativeCwd = relative(workspaceRoot, resolvedCwd);
  if (!relativeCwd || relativeCwd === "") return ".";
  if (!relativeCwd.startsWith("..")) return relativeCwd;
  return cwd;
}

function limitTasks(tasks: DaemonBackgroundTaskSnapshot[], limit: number | undefined): DaemonBackgroundTaskSnapshot[] {
  if (limit === undefined) return tasks;
  return tasks.slice(0, Math.max(0, limit));
}
