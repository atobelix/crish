/**
 * ProcessManager - 进程生命周期加固
 *
 * 解决的问题：
 * 1. 子进程退出后未清理资源
 * 2. 强制 kill 导致数据丢失
 * 3. 进程泄漏（僵尸进程）
 * 4. 缺乏统一的进程状态管理
 *
 * 设计原则：
 * 1. 两阶段终止：先 SIGTERM（优雅终止），超时后 SIGKILL（强制终止）
 * 2. 进程注册表：所有子进程必须注册，确保可追踪
 * 3. 生命周期钩子：支持 onSpawn / onExit / onError / onTimeout
 * 4. 资源清理：进程退出后自动清理相关资源
 */

import { spawn, type ChildProcess } from "node:child_process";

// ─── 进程状态 ─────────────────────────────────────────────

export type ManagedProcessState =
  | "spawning"
  | "running"
  | "terminating"     // 已发送 SIGTERM，等待优雅退出
  | "force-killing"   // SIGTERM 超时，发送 SIGKILL
  | "exited"
  | "error";

export type ProcessExitKind =
  | "clean-exit"      // 正常退出
  | "error-exit"      // 非零退出码
  | "signal-exit"     // 被信号终止
  | "timeout-kill"    // SIGTERM 超时后被 SIGKILL
  | "spawn-error";    // 启动失败

// ─── 进程配置 ─────────────────────────────────────────────

export interface ManagedProcessOptions {
  /** 进程标签（用于标识） */
  label: string;
  /** 命令 */
  command: string;
  /** 参数 */
  args?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 优雅终止超时（ms），默认 5000 */
  gracefulTimeoutMs?: number;
  /** 最大运行时间（ms），0 表示无限制 */
  maxRuntimeMs?: number;
  /** 是否继承 stdio */
  stdio?: "inherit" | "pipe" | "ignore";
}

// ─── 进程记录 ─────────────────────────────────────────────

export interface ManagedProcessRecord {
  /** 进程 ID */
  processId: string;
  /** 标签 */
  label: string;
  /** 状态 */
  state: ManagedProcessState;
  /** PID */
  pid?: number;
  /** 启动时间 */
  startedAt?: string;
  /** 退出时间 */
  exitedAt?: string;
  /** 退出码 */
  exitCode?: number | null;
  /** 退出信号 */
  exitSignal?: string | null;
  /** 退出类型 */
  exitKind?: ProcessExitKind;
  /** 配置 */
  options: ManagedProcessOptions;
  /** 子进程引用 */
  childProcess?: ChildProcess;
  /** 终止定时器 */
  terminationTimer?: ReturnType<typeof setTimeout>;
  /** 运行时间定时器 */
  runtimeTimer?: ReturnType<typeof setTimeout>;
}

// ─── 生命周期钩子 ─────────────────────────────────────────

export interface ProcessLifecycleHooks {
  onSpawn?: (record: ManagedProcessRecord) => void;
  onExit?: (record: ManagedProcessRecord) => void;
  onError?: (record: ManagedProcessRecord, error: Error) => void;
  onTimeout?: (record: ManagedProcessRecord) => void;
  onForceKill?: (record: ManagedProcessRecord) => void;
}

// ─── ProcessManager ───────────────────────────────────────

export class ProcessManager {
  private processes = new Map<string, ManagedProcessRecord>();
  private hooks: ProcessLifecycleHooks;
  private nextId = 1;

  constructor(hooks?: ProcessLifecycleHooks) {
    this.hooks = hooks ?? {};
  }

  /**
   * 启动一个受管理的子进程
   */
  spawn(options: ManagedProcessOptions): ManagedProcessRecord {
    const processId = `proc-${this.nextId++}`;
    const record: ManagedProcessRecord = {
      processId,
      label: options.label,
      state: "spawning",
      options,
    };

    this.processes.set(processId, record);

    try {
      const child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: options.stdio ?? "pipe",
        detached: false,
      });

      record.childProcess = child;
      record.pid = child.pid;
      record.state = "running";
      record.startedAt = new Date().toISOString();

      // 监听退出
      child.on("exit", (code, signal) => {
        this.handleProcessExit(processId, code, signal);
      });

      // 监听错误
      child.on("error", (error) => {
        this.handleProcessError(processId, error);
      });

      this.hooks.onSpawn?.(record);

      // 设置最大运行时间
      if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
        record.runtimeTimer = setTimeout(() => {
          this.hooks.onTimeout?.(record);
          this.terminate(processId);
        }, options.maxRuntimeMs);
      }
    } catch (error) {
      record.state = "error";
      record.exitKind = "spawn-error";
      this.hooks.onError?.(record, error instanceof Error ? error : new Error(String(error)));
    }

    return record;
  }

  /**
   * 优雅终止进程（两阶段终止）
   */
  terminate(processId: string): void {
    const record = this.processes.get(processId);
    if (!record || record.state === "exited" || record.state === "error") return;

    const child = record.childProcess;
    if (!child || child.killed) {
      record.state = "exited";
      return;
    }

    // 阶段1：SIGTERM（优雅终止）
    record.state = "terminating";
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }

    // 阶段2：超时后 SIGKILL
    const timeout = record.options.gracefulTimeoutMs ?? 5000;
    record.terminationTimer = setTimeout(() => {
      if (record.state === "terminating" && child.pid && !child.killed) {
        record.state = "force-killing";
        this.hooks.onForceKill?.(record);
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已退出
        }
      }
    }, timeout);
  }

  /**
   * 终止所有进程
   */
  terminateAll(): void {
    for (const [processId, record] of this.processes) {
      if (record.state === "running" || record.state === "spawning") {
        this.terminate(processId);
      }
    }
  }

  /**
   * 获取进程记录
   */
  getProcess(processId: string): ManagedProcessRecord | undefined {
    return this.processes.get(processId);
  }

  /**
   * 列出所有进程
   */
  listProcesses(filter?: { state?: ManagedProcessState; label?: string }): ManagedProcessRecord[] {
    let records = [...this.processes.values()];
    if (filter?.state) {
      records = records.filter((r) => r.state === filter.state);
    }
    if (filter?.label) {
      records = records.filter((r) => r.label === filter.label);
    }
    return records;
  }

  /**
   * 获取运行中的进程数
   */
  getRunningCount(): number {
    let count = 0;
    for (const record of this.processes.values()) {
      if (record.state === "running") count++;
    }
    return count;
  }

  /**
   * 清理已退出的进程记录
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [processId, record] of this.processes) {
      if (record.state === "exited" || record.state === "error") {
        this.processes.delete(processId);
        cleaned++;
      }
    }
    return cleaned;
  }

  // ─── 内部方法 ────────────────────────────────────────────

  private handleProcessExit(processId: string, code: number | null, signal: string | null): void {
    const record = this.processes.get(processId);
    if (!record) return;

    // 清理定时器
    if (record.terminationTimer) clearTimeout(record.terminationTimer);
    if (record.runtimeTimer) clearTimeout(record.runtimeTimer);

    // 先保存终止前的状态，用于判断退出类型
    const stateBeforeExit = record.state;

    record.state = "exited";
    record.exitedAt = new Date().toISOString();
    record.exitCode = code;
    record.exitSignal = signal;

    // 确定退出类型（基于终止前的状态）
    if (stateBeforeExit === "force-killing" || signal === "SIGKILL") {
      record.exitKind = "timeout-kill";
    } else if (signal) {
      record.exitKind = "signal-exit";
    } else if (code === 0) {
      record.exitKind = "clean-exit";
    } else {
      record.exitKind = "error-exit";
    }

    this.hooks.onExit?.(record);
  }

  private handleProcessError(processId: string, error: Error): void {
    const record = this.processes.get(processId);
    if (!record) return;

    record.state = "error";
    record.exitKind = "spawn-error";
    record.exitedAt = new Date().toISOString();

    this.hooks.onError?.(record, error);
  }
}
