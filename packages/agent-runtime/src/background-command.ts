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

  waitForTask(taskId: string, timeoutMs = 60_000): Promise<BackgroundCommandSnapshot> {
    const existing = this.get(taskId);
    if (!existing) return Promise.reject(new Error(`Background command not found: ${taskId}`));
    if (isTerminalState(existing.state)) return Promise.resolve(existing);

    return new Promise((resolveWait, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for background command: ${taskId}`));
      }, timeoutMs);
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
    this.emit({ type: "task-end", timestamp: nowIso(), task: this.toSnapshot(record) });
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

export function createBackgroundCommandTools(manager: BackgroundCommandManager): AgentTool[] {
  return [
    defineTool({
      name: "start_background_command",
      label: "Start background command",
      description: "Start a long-running local command and return immediately with a task id.",
      category: "terminal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
          maxOutputBytes: { type: "number" },
          heartbeatIntervalMs: { type: "number" }
        },
        required: ["command"],
        additionalProperties: false
      },
      isReadOnly(input) {
        const command = stringField(input, "command");
        return command ? classifyTerminalCommand(command).risk === "read" : false;
      },
      summarize(input) {
        return `start background command: ${stringField(input, "command") ?? "<missing command>"}`;
      },
      async execute(input) {
        const task = await manager.start({
          command: requireNonEmptyString(input.command, "command"),
          cwd: stringField(input, "cwd"),
          timeoutMs: numberField(input, "timeoutMs"),
          maxOutputBytes: numberField(input, "maxOutputBytes"),
          heartbeatIntervalMs: numberField(input, "heartbeatIntervalMs")
        });
        return backgroundTaskOutput("Background command started", task);
      }
    }),
    defineTool({
      name: "get_background_command",
      label: "Get background command",
      description: "Read the current status and output preview of a background command.",
      category: "internal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" }
        },
        required: ["taskId"],
        additionalProperties: false
      },
      isReadOnly: () => true,
      summarize(input) {
        return `get background command: ${stringField(input, "taskId") ?? "<missing task id>"}`;
      },
      async execute(input) {
        const task = manager.get(requireNonEmptyString(input.taskId, "taskId"));
        if (!task) throw new Error(`Background command not found: ${input.taskId}`);
        return backgroundTaskOutput("Background command status", task);
      }
    }),
    defineTool({
      name: "list_background_commands",
      label: "List background commands",
      description: "List all background commands in this runtime process.",
      category: "internal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      isReadOnly: () => true,
      summarize() {
        return "list background commands";
      },
      async execute() {
        const tasks = manager.list();
        return {
          text: tasks.length > 0 ? tasks.map(formatBackgroundCommandLine).join("\n") : "No background commands.",
          json: { tasks: tasks as unknown as JsonValue }
        };
      }
    }),
    defineTool({
      name: "cancel_background_command",
      label: "Cancel background command",
      description: "Cancel a running background command.",
      category: "terminal",
      concurrency: "exclusive",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" }
        },
        required: ["taskId"],
        additionalProperties: false
      },
      isReadOnly: () => false,
      summarize(input) {
        return `cancel background command: ${stringField(input, "taskId") ?? "<missing task id>"}`;
      },
      async execute(input) {
        const task = manager.cancel(requireNonEmptyString(input.taskId, "taskId"));
        return backgroundTaskOutput("Background command cancellation requested", task);
      }
    })
  ];
}

function backgroundTaskOutput(title: string, task: BackgroundCommandSnapshot): ToolOutput {
  return {
    text: [title, formatBackgroundCommandLine(task), "", task.outputPreview].filter(Boolean).join("\n"),
    json: task as unknown as JsonObject
  };
}

function formatBackgroundCommandLine(task: BackgroundCommandSnapshot): string {
  const exit = task.exitCode === undefined ? "" : ` exit=${task.exitCode}`;
  return `${task.id} ${task.state}${exit} ${(task.durationMs ?? 0) / 1000}s ${task.command}`;
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
