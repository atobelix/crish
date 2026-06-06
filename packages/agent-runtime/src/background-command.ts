import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { classifyTerminalCommand, getHardlineCommandBlock } from "./permissions";
import { defineTool } from "./tools";
import type { AgentTool, JsonObject, JsonValue, ToolOutput } from "./types";

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

export interface BackgroundCommandShell {
  command: string;
  args(command: string): string[];
}

export interface BackgroundCommandGuardOptions {
  scrubEnvironment?: boolean;
  killProcessTree?: boolean;
}

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
  truncated: boolean;
  outputPreview: string;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutBytes: number;
  stderrBytes: number;
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
  stdout: BoundedBuffer;
  stderr: BoundedBuffer;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  cancelRequested: boolean;
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
      stdout: new BoundedBuffer(maxOutputBytes),
      stderr: new BoundedBuffer(maxOutputBytes),
      timedOut: false,
      cancelRequested: false
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
      terminateChild(child, this.guard());
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
      terminateChild(record.child, this.guard());
    }
    if (process.platform === "win32") {
      sleepSync(150);
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
      truncated: record.stdout.truncated || record.stderr.truncated,
      outputPreview: formatCommandPreview(stdoutPreview, stderrPreview),
      stdoutPreview,
      stderrPreview,
      stdoutBytes: record.stdout.totalBytes,
      stderrBytes: record.stderr.totalBytes,
      ...(record.error ? { error: record.error } : {})
    };
  }

  private emit(event: BackgroundCommandEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private shell(): BackgroundCommandShell {
    return this.options.shell ?? defaultShell();
  }

  private guard(): Required<BackgroundCommandGuardOptions> {
    return normalizeGuard(this.options.guard);
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

function formatCommandPreview(stdout: string, stderr: string): string {
  return [
    stdout.trimEnd() ? `stdout:\n${stdout.trimEnd()}` : "",
    stderr.trimEnd() ? `stderr:\n${stderr.trimEnd()}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

class BoundedBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private full = Buffer.alloc(0);
  totalBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {
    this.headLimit = Math.max(512, Math.floor(maxBytes * 0.55));
    this.tailLimit = Math.max(512, maxBytes - this.headLimit);
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (!this.truncated) {
      const next = Buffer.concat([this.full, chunk]);
      if (next.byteLength <= this.maxBytes) {
        this.full = next;
        return;
      }
      this.truncated = true;
      this.head = next.subarray(0, this.headLimit);
      this.tail = next.subarray(-this.tailLimit);
      this.full = Buffer.alloc(0);
      return;
    }
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.tailLimit);
  }

  toText(): string {
    if (!this.truncated) return this.full.toString("utf8");
    const omitted = Math.max(0, this.totalBytes - this.head.byteLength - this.tail.byteLength);
    return `${this.head.toString("utf8")}\n\n[output omitted: ${omitted} bytes]\n\n${this.tail.toString("utf8")}`;
  }
}

function normalizeGuard(guard: BackgroundCommandGuardOptions | false | undefined): Required<BackgroundCommandGuardOptions> {
  if (guard === false) {
    return {
      scrubEnvironment: false,
      killProcessTree: false
    };
  }
  return {
    scrubEnvironment: guard?.scrubEnvironment ?? true,
    killProcessTree: guard?.killProcessTree ?? true
  };
}

function createGuardedProcessEnv(): NodeJS.ProcessEnv {
  const guarded: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvName(key)) continue;
    guarded[key] = value;
  }
  guarded.PYTHONUTF8 = "1";
  guarded.PYTHONIOENCODING = "utf-8";
  return guarded;
}

function isSensitiveEnvName(name: string): boolean {
  return /(^|_)(token|secret|password|credential|api[_-]?key|auth|cookie|session)(_|\b)/i.test(name);
}

function terminateChild(child: ChildProcess, guard: Required<BackgroundCommandGuardOptions>): void {
  if (!guard.killProcessTree) {
    child.kill();
    return;
  }
  terminateProcessTree(child);
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    terminateWindowsProcessTree(child.pid);
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000
    });
    if (result.error) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

function terminateWindowsProcessTree(rootPid: number): void {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${rootPid}`,
    "$items = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId",
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]'",
    "[void]$ids.Add([int]$root)",
    "do {",
    "  $added = $false",
    "  foreach ($p in $items) {",
    "    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {",
    "      [void]$ids.Add([int]$p.ProcessId)",
    "      $added = $true",
    "    }",
    "  }",
    "} while ($added)",
    "$ids | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
  ].join("; ");
  spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000
  });
}

function defaultShell(): BackgroundCommandShell {
  if (process.platform === "win32") {
    const prelude = [
      "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "$env:PYTHONUTF8='1'",
      "$env:PYTHONIOENCODING='utf-8'"
    ].join("; ");
    return {
      command: "powershell.exe",
      args: (command) => [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${prelude}; $global:LASTEXITCODE=$null; & { ${command} }; $success=$?; $exitCode=$LASTEXITCODE; if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode }; if (-not $success) { exit 1 }`
      ]
    };
  }
  return {
    command: "bash",
    args: (command) => ["-lc", command]
  };
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

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, Math.max(0, milliseconds));
}
