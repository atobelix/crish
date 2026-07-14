import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { classifyTerminalCommand, getHardlineCommandBlock } from "./permission/command-classification";
import {
  BoundedProcessOutput,
  createGuardedProcessEnv,
  defaultProcessShell,
  formatProcessPreview,
  normalizeProcessGuard,
  terminateChild,
  type ProcessGuardOptions,
  type ProcessShell,
  type ProcessTerminationDiagnostic
} from "./process-lifecycle";
import { defineTool } from "./tools";
import type { JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "./types";
import {
  formatDuration,
  getSharedScriptWaitPolicy,
  type ScriptRunMode,
  type ScriptWaitPolicy,
  PARALLEL_SOFT_LIMIT_MS,
} from "./script-wait-policy";

export type BackgroundCommandState = "running" | "succeeded" | "failed" | "cancelled" | "timed-out";

export interface BackgroundCommandStartInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
}

export interface BackgroundCommandManagerOptions {
  workspaceRoot: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
  shell?: BackgroundCommandShell;
  guard?: BackgroundCommandGuardOptions | false;
}

export type BackgroundCommandShell = ProcessShell;

export type BackgroundCommandGuardOptions = ProcessGuardOptions;

export interface BackgroundCommandSnapshot {
  id: string;
  command: string;
  cwd: string;
  state: BackgroundCommandState;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  timeoutMs: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  outputPreview: string;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutBytes: number;
  stderrBytes: number;
  terminationDiagnostics: ProcessTerminationDiagnostic[];
  error?: string;
}

export type BackgroundCommandEvent =
  | { type: "task-start"; timestamp: string; task: BackgroundCommandSnapshot }
  | { type: "task-heartbeat"; timestamp: string; task: BackgroundCommandSnapshot }
  | { type: "task-output"; timestamp: string; task: BackgroundCommandSnapshot; stream: "stdout" | "stderr" }
  | { type: "task-end"; timestamp: string; task: BackgroundCommandSnapshot };

type BackgroundCommandListener = (event: BackgroundCommandEvent) => void;

interface BackgroundCommandRecord {
  id: string;
  command: string;
  cwd: string;
  state: BackgroundCommandState;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  timeoutMs: number;
  child?: ChildProcess;
  stdout: BoundedProcessOutput;
  stderr: BoundedProcessOutput;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  cancelRequested: boolean;
  terminationDiagnostics: ProcessTerminationDiagnostic[];
  error?: string;
  timeout?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
}

export class BackgroundCommandManager {
  private readonly tasks = new Map<string, BackgroundCommandRecord>();
  private readonly listeners = new Set<BackgroundCommandListener>();

  constructor(private readonly options: BackgroundCommandManagerOptions) {}

  async start(input: BackgroundCommandStartInput): Promise<BackgroundCommandSnapshot> {
    const command = requireNonEmptyString(input.command, "command");
    const hardline = getHardlineCommandBlock(command);
    if (hardline) {
      throw new Error(hardline.reason);
    }

    const cwd = resolveWorkspacePath(this.options.workspaceRoot, input.cwd ?? ".");
    await access(cwd, constants.R_OK);

    const timeoutMs = Math.max(1, input.timeoutMs ?? this.options.defaultTimeoutMs ?? 30 * 60_000);
    const maxOutputBytes = Math.max(1024, input.maxOutputBytes ?? this.options.maxOutputBytes ?? 500_000);
    const now = Date.now();
    const record: BackgroundCommandRecord = {
      id: createBackgroundCommandId(),
      command,
      cwd,
      state: "running",
      startedAt: now,
      updatedAt: now,
      timeoutMs,
      stdout: new BoundedProcessOutput(maxOutputBytes),
      stderr: new BoundedProcessOutput(maxOutputBytes),
      timedOut: false,
      cancelRequested: false,
      terminationDiagnostics: []
    };
    this.tasks.set(record.id, record);

    const child = spawn(this.shell().command, this.shell().args(command), {
      cwd,
      detached: process.platform !== "win32",
      env: this.guard().scrubEnvironment ? createGuardedProcessEnv() : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    record.child = child;
    record.updatedAt = Date.now();
    this.emit({ type: "task-start", timestamp: nowIso(), task: this.toSnapshot(record) });

    child.stdout.on("data", (chunk: Buffer) => {
      record.stdout.append(chunk);
      record.updatedAt = Date.now();
      this.emit({ type: "task-output", timestamp: nowIso(), task: this.toSnapshot(record), stream: "stdout" });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      record.stderr.append(chunk);
      record.updatedAt = Date.now();
      this.emit({ type: "task-output", timestamp: nowIso(), task: this.toSnapshot(record), stream: "stderr" });
    });

    record.timeout = setTimeout(() => {
      if (isTerminalState(record.state)) return;
      record.timedOut = true;
      record.updatedAt = Date.now();
      record.terminationDiagnostics.push(...terminateChild(child, this.guard()));
    }, timeoutMs);
    record.heartbeat = setInterval(() => {
      if (isTerminalState(record.state)) return;
      record.updatedAt = Date.now();
      this.emit({ type: "task-heartbeat", timestamp: nowIso(), task: this.toSnapshot(record) });
    }, heartbeatIntervalMs(input.heartbeatIntervalMs, this.options.heartbeatIntervalMs));

    child.on("error", (cause) => {
      this.finish(record, {
        state: "failed",
        error: cause instanceof Error ? cause.message : String(cause)
      });
    });
    child.on("close", (exitCode, signal) => {
      const state = record.cancelRequested
        ? "cancelled"
        : record.timedOut
          ? "timed-out"
          : exitCode === 0
            ? "succeeded"
            : "failed";
      this.finish(record, { state, exitCode, signal });
    });

    return this.toSnapshot(record);
  }

  get(taskId: string): BackgroundCommandSnapshot | undefined {
    const record = this.tasks.get(taskId);
    return record ? this.toSnapshot(record) : undefined;
  }

  list(): BackgroundCommandSnapshot[] {
    return [...this.tasks.values()].map((record) => this.toSnapshot(record));
  }

  cancel(taskId: string): BackgroundCommandSnapshot {
    const record = this.requireRecord(taskId);
    if (isTerminalState(record.state)) return this.toSnapshot(record);
    record.cancelRequested = true;
    record.updatedAt = Date.now();
    if (record.child) {
      record.terminationDiagnostics.push(...terminateChild(record.child, this.guard()));
    }
    this.finish(record, { state: "cancelled", exitCode: null, signal: "cancelled" });
    return this.toSnapshot(record);
  }

  /**
   * Wait until the task ends, or until timeoutMs elapses.
   * Default timeout uses remaining task budget (not a tiny 60s) so long builds work.
   */
  waitForTask(taskId: string, timeoutMs?: number): Promise<BackgroundCommandSnapshot> {
    const existing = this.get(taskId);
    if (!existing) return Promise.reject(new Error(`Background command not found: ${taskId}`));
    if (isTerminalState(existing.state)) return Promise.resolve(existing);

    const startedMs = Date.parse(existing.startedAt) || Date.now();
    const remaining = Math.max(1_000, existing.timeoutMs - (Date.now() - startedMs));
    const waitBudget = Math.max(1_000, timeoutMs ?? remaining);

    return new Promise((resolveWait, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        // Soft timeout: return current snapshot, do NOT kill the process
        const current = this.get(taskId);
        if (current) resolveWait(current);
        else reject(new Error(`Timed out waiting for background command: ${taskId}`));
      }, waitBudget);
      const unsubscribe = this.subscribe((event) => {
        if (event.task.id !== taskId || event.type !== "task-end") return;
        clearTimeout(timeout);
        unsubscribe();
        resolveWait(event.task);
      });
    });
  }

  subscribe(listener: BackgroundCommandListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private finish(
    record: BackgroundCommandRecord,
    input: { state: BackgroundCommandState; exitCode?: number | null; signal?: string | null; error?: string }
  ): void {
    if (isTerminalState(record.state)) return;
    if (record.timeout) clearTimeout(record.timeout);
    if (record.heartbeat) clearInterval(record.heartbeat);
    record.state = input.state;
    record.exitCode = input.exitCode;
    record.signal = input.signal;
    record.error = input.error;
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    const snapshot = this.toSnapshot(record);
    this.emit({ type: "task-end", timestamp: nowIso(), task: snapshot });
    // Feed duration stats for simple wait hints (shared policy)
    try {
      getSharedScriptWaitPolicy().registerEnd(record.id, snapshot.durationMs);
    } catch {
      // never break process lifecycle on policy bookkeeping
    }
  }

  private requireRecord(taskId: string): BackgroundCommandRecord {
    const record = this.tasks.get(taskId);
    if (!record) throw new Error(`Background command not found: ${taskId}`);
    return record;
  }

  private toSnapshot(record: BackgroundCommandRecord): BackgroundCommandSnapshot {
    const stdoutPreview = record.stdout.toText();
    const stderrPreview = record.stderr.toText();
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      state: record.state,
      ...(record.child?.pid ? { pid: record.child.pid } : {}),
      startedAt: new Date(record.startedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      ...(record.finishedAt ? { finishedAt: new Date(record.finishedAt).toISOString() } : {}),
      durationMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      timeoutMs: record.timeoutMs,
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      cancelled: record.cancelRequested,
      truncated: record.stdout.truncated || record.stderr.truncated,
      outputPreview: formatProcessPreview(stdoutPreview, stderrPreview),
      stdoutPreview,
      stderrPreview,
      stdoutBytes: record.stdout.totalBytes,
      stderrBytes: record.stderr.totalBytes,
      terminationDiagnostics: record.terminationDiagnostics,
      ...(record.error ? { error: record.error } : {})
    };
  }

  private emit(event: BackgroundCommandEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private shell(): BackgroundCommandShell {
    return this.options.shell ?? defaultProcessShell();
  }

  private guard(): Required<BackgroundCommandGuardOptions> {
    return normalizeProcessGuard(this.options.guard);
  }
}

export interface BackgroundCommandToolsOptions {
  /** Optional policy instance; defaults to process-shared policy. */
  policy?: ScriptWaitPolicy;
}

/**
 * Clear AI-facing task tools (single surface — do not also put background APIs on shell_command).
 *
 * Mental model for the model:
 *   shell_command     → run & wait (default for short work)
 *   run_background    → start long work, get taskId
 *   wait_for_task     → block until done (preferred)
 *   check_task        → peek (rarely)
 *   stop_task         → only if user asks / clearly stuck
 *   list_tasks        → see what's running
 */
export function createBackgroundCommandTools(
  manager: BackgroundCommandManager,
  options: BackgroundCommandToolsOptions = {},
): AgentTool[] {
  const policy = options.policy ?? getSharedScriptWaitPolicy();

  return [
    defineTool({
      name: "run_background",
      label: "后台运行",
      description:
        "Start a long-running command without blocking (build/test/install/dev server). Returns taskId. " +
        "When you need the result, call wait_for_task. Do not call check_task every few seconds. " +
        "For short commands, prefer shell_command instead.",
      category: "terminal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run." },
          cwd: { type: "string", description: "Working directory relative to the project." },
          timeoutMs: { type: "number", description: "Max lifetime of the process (ms)." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      isReadOnly(input) {
        const command = stringField(input, "command");
        return command ? classifyTerminalCommand(command).risk === "read" : false;
      },
      summarize(input) {
        return `run_background: ${stringField(input, "command") ?? "?"}`;
      },
      async execute(input) {
        const command = requireNonEmptyString(input.command, "command");
        const task = await manager.start({
          command,
          cwd: stringField(input, "cwd"),
          timeoutMs: numberField(input, "timeoutMs"),
        });
        const meta = policy.registerStart(task.id, command, "continue");
        return backgroundTaskOutput("后台任务已启动", task, policy.startGuidance(meta));
      },
    }),
    defineTool({
      name: "wait_for_task",
      label: "等待任务",
      description:
        "Wait until a background task finishes (or optional timeout). Prefer this over repeated check_task. " +
        "A wait timeout only stops waiting — it does NOT kill a healthy process.",
      category: "terminal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          timeoutMs: {
            type: "number",
            description: "Optional max wait (ms). Omit to wait up to the task's own budget.",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      isReadOnly: () => true,
      summarize(input) {
        return `wait_for_task: ${stringField(input, "taskId") ?? "?"}`;
      },
      async execute(input) {
        const taskId = requireNonEmptyString(input.taskId, "taskId");
        const finished = await manager.waitForTask(taskId, numberField(input, "timeoutMs"));
        if (isTerminalState(finished.state)) {
          policy.registerEnd(taskId, finished.durationMs);
          return backgroundTaskOutput("任务已结束", finished);
        }
        return backgroundTaskOutput(
          "等待超时，任务仍在运行",
          finished,
          "进程未被终止。可稍后再 wait_for_task，或先做不依赖该结果的其它工作。",
        );
      },
    }),
    defineTool({
      name: "check_task",
      label: "查看任务",
      description:
        "Peek at status/output of a background task. Use sparingly. Prefer wait_for_task when you need the final result.",
      category: "terminal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      isReadOnly: () => true,
      summarize(input) {
        return `check_task: ${stringField(input, "taskId") ?? "?"}`;
      },
      async execute(input) {
        const taskId = requireNonEmptyString(input.taskId, "taskId");
        let task = manager.get(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        if (isTerminalState(task.state)) {
          policy.registerEnd(taskId, task.durationMs);
          return backgroundTaskOutput("任务状态", task);
        }

        const runningMs = task.durationMs ?? 0;
        const advice = policy.recordPoll(taskId, runningMs);

        if (advice.forceWait) {
          const finished = await manager.waitForTask(taskId);
          if (isTerminalState(finished.state)) {
            policy.registerEnd(taskId, finished.durationMs);
          }
          return backgroundTaskOutput(
            isTerminalState(finished.state) ? "任务已结束" : "等待后仍在运行",
            finished,
            advice.hint,
          );
        }

        const soft =
          runningMs >= PARALLEL_SOFT_LIMIT_MS
            ? `已运行 ${formatDuration(runningMs)}。若需要结果请 wait_for_task，不要继续频繁 check。`
            : advice.hint;
        return backgroundTaskOutput("任务仍在运行", task, soft);
      },
    }),
    defineTool({
      name: "list_tasks",
      label: "任务列表",
      description: "List background tasks in this workspace/process.",
      category: "terminal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isReadOnly: () => true,
      summarize() {
        return "list_tasks";
      },
      async execute() {
        const tasks = manager.list();
        return {
          text:
            tasks.length > 0
              ? tasks.map(formatBackgroundCommandLine).join("\n")
              : "当前没有后台任务。",
          json: { tasks: tasks as unknown as JsonValue },
        };
      },
    }),
    defineTool({
      name: "stop_task",
      label: "停止任务",
      description:
        "Stop a running background task. Only when the user asks to stop, or the process is clearly stuck. " +
        "Never stop a healthy long job just so you can keep chatting.",
      category: "terminal",
      concurrency: "exclusive",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      summarize(input) {
        return `stop_task: ${stringField(input, "taskId") ?? "?"}`;
      },
      async execute(input) {
        const task = manager.cancel(requireNonEmptyString(input.taskId, "taskId"));
        policy.registerEnd(task.id, task.durationMs);
        return backgroundTaskOutput("已请求停止任务", task);
      },
    }),
  ];
}

/** @deprecated Use createBackgroundCommandTools (clear names: run_background / wait_for_task / …). */
export const createBackgroundCommandToolsLegacy = createBackgroundCommandTools;

function backgroundTaskOutput(
  title: string,
  task: BackgroundCommandSnapshot,
  hint?: string,
): ToolOutput {
  const lines = [
    title,
    formatBackgroundCommandLine(task),
    hint ? `提示: ${hint}` : "",
    "",
    task.outputPreview,
  ].filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""));
  return {
    text: lines.join("\n").trim(),
    json: {
      ...(task as unknown as JsonObject),
      ...(hint ? { hint } : {}),
    },
  };
}

function formatBackgroundCommandLine(task: BackgroundCommandSnapshot): string {
  const exit = task.exitCode === undefined || task.exitCode === null ? "" : ` exit=${task.exitCode}`;
  const dur = formatDuration(task.durationMs ?? 0);
  return `${task.id} · ${task.state}${exit} · ${dur} · ${task.command}`;
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return candidate;
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isTerminalState(state: BackgroundCommandState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed-out";
}

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function booleanField(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function heartbeatIntervalMs(inputValue: number | undefined, defaultValue: number | undefined): number {
  return Math.max(1_000, inputValue ?? defaultValue ?? 30_000);
}

function createBackgroundCommandId(): string {
  return `bgcmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
