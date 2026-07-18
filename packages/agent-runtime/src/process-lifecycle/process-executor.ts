/**
 * 进程执行器 - 命令执行与输出捕获
 *
 * 负责实际的命令执行：
 * 1. 带有边界限制的输出捕获（BoundedProcessOutput）
 * 2. 跨平台进程树终止
 * 3. 环境变量安全清理
 * 4. Shell 适配（Windows PowerShell / Unix Bash）
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

// ─── Shell 配置 ───────────────────────────────────────────

export interface ProcessShell {
  command: string;
  args(command: string): string[];
}

// ─── 进程保护选项 ─────────────────────────────────────────

export interface ProcessGuardOptions {
  scrubEnvironment?: boolean;
  killProcessTree?: boolean;
}

// ─── 终止诊断 ─────────────────────────────────────────────

export interface ProcessTerminationDiagnostic {
  platform: NodeJS.Platform;
  strategy: "signal" | "process-tree" | "taskkill" | "powershell-process-tree" | "child-kill";
  ok: boolean;
  message?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

// ─── 运行结果 ─────────────────────────────────────────────

export interface ProcessRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  outputPreview: string;
  terminationDiagnostics: ProcessTerminationDiagnostic[];
}

// ─── 运行选项 ─────────────────────────────────────────────

export interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  shell: ProcessShell;
  guard: Required<ProcessGuardOptions>;
}

// ─── 有界输出捕获 ─────────────────────────────────────────

export class BoundedProcessOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = Buffer.alloc(0);
  private tailChunks: Buffer[] = [];
  private tailLength = 0;
  private fullChunks: Buffer[] = [];
  totalBytes = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {
    this.headLimit = Math.max(512, Math.floor(maxBytes * 0.55));
    this.tailLimit = Math.max(512, maxBytes - this.headLimit);
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (!this.truncated) {
      if (this.totalBytes <= this.maxBytes) {
        this.fullChunks.push(chunk);
        return;
      }
      this.truncated = true;
      const next = Buffer.concat([...this.fullChunks, chunk]);
      this.head = next.subarray(0, this.headLimit);
      const initialTail = next.subarray(-this.tailLimit);
      this.tailChunks = [initialTail];
      this.tailLength = initialTail.byteLength;
      this.fullChunks = [];
      return;
    }
    this.tailChunks.push(chunk);
    this.tailLength += chunk.byteLength;
    // 定期收缩 tail 缓冲，避免 tailChunks 数组无限增长
    if (this.tailLength > this.tailLimit * 2) {
      const consolidated = Buffer.concat(this.tailChunks).subarray(-this.tailLimit);
      this.tailChunks = [consolidated];
      this.tailLength = consolidated.byteLength;
    }
  }

  toText(): string {
    if (!this.truncated) {
      return Buffer.concat(this.fullChunks).toString("utf8");
    }
    const tail = Buffer.concat(this.tailChunks).subarray(-this.tailLimit);
    const omitted = Math.max(0, this.totalBytes - this.head.byteLength - tail.byteLength);
    return `${this.head.toString("utf8")}\n\n[output omitted: ${omitted} bytes]\n\n${tail.toString("utf8")}`;
  }
}

// ─── 核心执行函数 ─────────────────────────────────────────

export async function runProcessCommand(command: string, options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAtMs = Date.now();
  const stdout = new BoundedProcessOutput(options.maxOutputBytes);
  const stderr = new BoundedProcessOutput(options.maxOutputBytes);
  const terminationDiagnostics: ProcessTerminationDiagnostic[] = [];
  let timedOut = false;
  let cancelled = false;

  const child = spawn(options.shell.command, options.shell.args(command), {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.guard.scrubEnvironment ? createGuardedProcessEnv() : process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

  const terminate = (): void => {
    terminationDiagnostics.push(...terminateChild(child, options.guard));
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  const abort = (): void => {
    cancelled = true;
    terminate();
  };
  if (options.signal.aborted) {
    abort();
  } else {
    options.signal.addEventListener("abort", abort, { once: true });
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  });

  const finishedAtMs = Date.now();
  const stdoutText = stdout.toText();
  const stderrText = stderr.toText();
  return {
    command,
    cwd: options.cwd,
    exitCode: exit.code,
    signal: exit.signal,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    stdout: stdoutText,
    stderr: stderrText,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
    timedOut,
    cancelled,
    truncated: stdout.truncated || stderr.truncated,
    outputPreview: formatProcessPreview(stdoutText, stderrText),
    terminationDiagnostics
  };
}

// ─── 进程终止 ─────────────────────────────────────────────

export function terminateChild(child: ChildProcess, guard: Required<ProcessGuardOptions>): ProcessTerminationDiagnostic[] {
  if (!guard.killProcessTree) {
    let ok = true;
    try {
      child.kill("SIGTERM");
    } catch {
      ok = false;
    }
    // SIGTERM 升级到 SIGKILL：防止子进程忽略 SIGTERM 永久挂起
    scheduleKillEscalation(child, () => child.kill("SIGKILL"));
    return [{ platform: process.platform, strategy: "child-kill", ok, signal: "SIGTERM" }];
  }
  return terminateProcessTree(child);
}

export function normalizeProcessGuard(guard: ProcessGuardOptions | false | undefined): Required<ProcessGuardOptions> {
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

export function createGuardedProcessEnv(): NodeJS.ProcessEnv {
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

// ─── Shell 适配 ───────────────────────────────────────────

/**
 * Encode a PowerShell script for `powershell.exe -EncodedCommand` (UTF-16LE base64).
 * Avoids shell metacharacter breakage for | & > < and nested quotes.
 */
export function encodePowerShellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Build the full Windows PowerShell wrapper script for a user command.
 * The user command is embedded as UTF-8 base64 so quotes/operators/braces never
 * break the wrapper script source.
 */
export function buildWindowsPowerShellScript(userCommand: string): string {
  const prelude = [
    "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$env:PYTHONUTF8='1'",
    "$env:PYTHONIOENCODING='utf-8'"
  ].join("; ");
  const normalized = normalizePowerShellCommand(userCommand);
  const payload = Buffer.from(normalized, "utf8").toString("base64");
  return [
    prelude,
    "$global:LASTEXITCODE=$null",
    `$__conexCmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}'))`,
    "& ([scriptblock]::Create($__conexCmd))",
    "$success=$?",
    "$exitCode=$LASTEXITCODE",
    "if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode }",
    "if (-not $success) { exit 1 }"
  ].join("; ");
}

export function defaultProcessShell(): ProcessShell {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: (command) => [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShellEncodedCommand(buildWindowsPowerShellScript(command))
      ]
    };
  }
  return {
    command: "bash",
    args: (command) => ["-lc", command]
  };
}

// ─── 格式化工具 ───────────────────────────────────────────

export function formatProcessPreview(stdout: string, stderr: string): string {
  return [
    stdout.trimEnd() ? `stdout:\n${stdout.trimEnd()}` : "",
    stderr.trimEnd() ? `stderr:\n${stderr.trimEnd()}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 规范化 Windows 命令。
 * - cmd 风格管道（findstr / dir | / 2>）走 cmd.exe，避免 PowerShell 包装破坏 |
 * - 其余用 PowerShell，并把 && 拆成可失败退出的分段
 */
export function normalizePowerShellCommand(command: string): string {
  const trimmed = command.trim();
  if (shouldRunViaCmdExe(trimmed)) {
    // 双引号转义后交给 cmd /s /c
    const escaped = trimmed.replace(/"/g, '""');
    return `cmd.exe /d /s /c "${escaped}"`;
  }
  const segments = splitPowerShellAndOperators(trimmed);
  if (segments.length <= 1) return trimmed;
  return segments
    .map((segment, index) =>
      index === 0
        ? segment
        : `if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }; ${segment}`
    )
    .join("; ");
}

/** 典型 cmd 管道 / 重定向：用 cmd.exe 执行更可靠 */
function shouldRunViaCmdExe(command: string): boolean {
  // 已是显式 powershell 则不转
  if (/^\s*(powershell|pwsh)(\.exe)?\b/i.test(command)) return false;
  // findstr / find 管道
  if (/\|\s*(findstr|find)(\.exe)?\b/i.test(command)) return true;
  if (/\b(findstr|find)(\.exe)?\b/i.test(command) && /\|/.test(command)) return true;
  // 经典 cmd 重定向
  if (/\b2>&?1\b/.test(command) || /\b1>\s*2\b/.test(command)) return true;
  // dir/type/echo 带管道
  if (/^(dir|type|echo|copy|move|del|mkdir|rmdir)\b/i.test(command) && /\|/.test(command)) return true;
  // head 在 PowerShell 不是原生命令，管道时常失败
  if (/\|\s*head\b/i.test(command)) return true;
  return false;
}

// ─── 内部工具 ─────────────────────────────────────────────

const PROCESS_KILL_ESCALATION_MS = 5_000;

/**
 * 调度 SIGKILL 升级：在 SIGTERM 发出后，若进程在升级窗口内仍未退出，则发送 SIGKILL。
 *
 * 两阶段终止模式：给子进程优雅退出的机会，但防止其忽略 SIGTERM 永久挂起。
 * 当子进程退出时（'exit' 事件）自动取消 SIGKILL 定时器，避免不必要的强制终止。
 * 定时器调用 unref()，不会阻止 Node.js 进程优雅退出。
 */
function scheduleKillEscalation(child: ChildProcess, sendKill: () => void): void {
  // 子进程已退出则无需升级
  if (child.exitCode !== null || child.signalCode !== null) return;

  const timer = setTimeout(() => {
    try {
      sendKill();
    } catch {
      // 进程可能在定时器触发前已退出
    }
  }, PROCESS_KILL_ESCALATION_MS);
  timer.unref();
  child.once("exit", () => {
    clearTimeout(timer);
  });
}

function terminateProcessTree(child: ChildProcess): ProcessTerminationDiagnostic[] {
  if (!child.pid) {
    const ok = child.kill();
    return [{ platform: process.platform, strategy: "child-kill", ok, message: "Process has no pid; killed direct child only." }];
  }
  if (process.platform === "win32") {
    const diagnostics = [terminateWindowsProcessTree(child.pid)];
    const taskkill = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000
    });
    diagnostics.push({
      platform: process.platform,
      strategy: "taskkill",
      ok: !taskkill.error,
      exitCode: taskkill.status,
      signal: taskkill.signal,
      ...(taskkill.error ? { message: taskkill.error.message } : {})
    });
    if (taskkill.error) {
      diagnostics.push({ platform: process.platform, strategy: "child-kill", ok: child.kill(), message: "taskkill failed; killed direct child only." });
    }
    return diagnostics;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
    // 进程组 SIGTERM 升级到 SIGKILL：防止子进程树忽略信号永久挂起
    scheduleKillEscalation(child, () => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    });
    return [{ platform: process.platform, strategy: "process-tree", ok: true, signal: "SIGTERM" }];
  } catch (cause) {
    // 进程组信号失败，回退到直接 kill 子进程并同样调度 SIGKILL 升级
    const childKillOk = child.kill("SIGTERM");
    scheduleKillEscalation(child, () => child.kill("SIGKILL"));
    return [
      {
        platform: process.platform,
        strategy: "process-tree",
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        signal: "SIGTERM"
      },
      { platform: process.platform, strategy: "child-kill", ok: childKillOk }
    ];
  }
}

function terminateWindowsProcessTree(rootPid: number): ProcessTerminationDiagnostic {
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
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000
  });
  return {
    platform: process.platform,
    strategy: "powershell-process-tree",
    ok: !result.error,
    exitCode: result.status,
    signal: result.signal,
    ...(result.error ? { message: result.error.message } : {})
  };
}

function splitPowerShellAndOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (quote === "\"" && char === "`") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&" && next === "&") {
      segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }

  segments.push(current.trim());
  return segments.filter((segment) => segment.length > 0);
}

function isSensitiveEnvName(name: string): boolean {
  return /(^|_)(token|secret|password|credential|api[_-]?key|auth|cookie|session)(_|\b)/i.test(name);
}
