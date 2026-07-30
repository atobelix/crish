/**
 * CrashHandler — 进程崩溃时的最后一搏日志持久化
 *
 * 职责（ROUND-02 §7.3）：
 * 1. 实现 telemetry 的 LogSpanSink 接口，通过 `logger.setSpanSink(crashHandler)` 注入
 * 2. onLog 仅缓冲 level >= error 的条目（RingBuffer 容量 50，覆盖最旧）
 * 3. install() 注册 process 级 uncaughtException / unhandledRejection 监听
 * 4. crash 发生时调用 flushSync()：
 *    - traceManager.flushSync() 标记活跃 span 结束
 *    - 将缓冲的错误条目同步写入 crash 文件（appendFileSync）
 *    - stderr 输出 crash 摘要（最新一条 error/fatal）
 *    - process.exit(1) 退出进程
 *
 * 设计决策：
 * - onLog 参数类型为 LogEntryLike（telemetry LogSpanSink 的宽泛类型），
 *   不直接依赖 @crish/logger 的 LogEntry，从而 CrashHandler 可同时作为
 *   logger 和 telemetry 的 sink（结构兼容，鸭子类型解耦）。
 * - _handleFatal 不重抛 err（uncaughtException 中重抛会无限递归），
 *   改为 process.exit(1) 让进程退出。
 * - 错误缓冲使用 RingBuffer.pushOverwritingOldest，O(1) 入队 + 自动覆盖。
 */

import { appendFileSync } from 'node:fs';
import { RingBuffer } from '@crish/shared-utils';

import type { LogSpanSink } from './spans';

// ─── 类型定义 ─────────────────────────────────────────────

/**
 * 与 telemetry LogSpanSink.onLog 参数结构兼容的日志条目类型。
 * 比 @crish/logger 的 LogEntry 更宽泛（不强制 level 为 LogLevel 联合），
 * 从而 CrashHandler 可同时接受 logger 和 telemetry 的 onLog 调用。
 */
type LogEntryLike = {
  level: string;
  msg: string;
  time: string;
  [key: string]: unknown;
};

/** level 字符串到优先级的映射，用于比较 level 严重程度 */
const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/** 入缓冲的最低优先级（error = 3），低于此级别的 debug/info/warn 不入缓冲 */
const MIN_BUFFER_PRIORITY = 3;

/**
 * Logger 实例的结构类型（不直接依赖 @crish/logger，鸭子类型解耦）。
 * 只要传入的对象具有 setSpanSink 方法即可被 CrashHandler 注册为 sink 宿主。
 */
interface LoggerLike {
  setSpanSink(sink: LogSpanSink | undefined): void;
  setFlushable(f: { flush(): Promise<void> }): void;
}

/** TraceManager 实例的结构类型（仅需 flushSync 能力） */
interface TraceManagerLike {
  flushSync(): void;
}

// ─── CrashHandlerOptions ─────────────────────────────────

export interface CrashHandlerOptions {
  /** crash 日志文件路径（flushSync 时同步写入）。省略则不写文件 */
  crashFilePath?: string | undefined;
  /** 错误缓冲容量，默认 50。仅缓冲 error/fatal 级别条目 */
  maxErrorBuffer?: number | undefined;
  /** Logger 实例（用于注册自身为 spanSink，接收 error/fatal 日志） */
  logger?: LoggerLike | undefined;
  /** TraceManager 实例（crash 时调用 flushSync 标记活跃 span 结束） */
  traceManager?: TraceManagerLike | undefined;
}

// ─── CrashHandler ────────────────────────────────────────

export class CrashHandler implements LogSpanSink {
  private _buffer: RingBuffer<LogEntryLike>;
  private _crashFilePath: string | undefined;
  private _traceManager: TraceManagerLike | undefined;
  private _logger: LoggerLike | undefined;
  private _handlers: {
    uncaughtException: ((err: Error) => void) | null;
    unhandledRejection: ((reason: unknown) => void) | null;
  };

  constructor(options: CrashHandlerOptions = {}) {
    this._buffer = new RingBuffer<LogEntryLike>(options.maxErrorBuffer ?? 50);
    this._crashFilePath = options.crashFilePath;
    this._traceManager = options.traceManager;
    this._logger = options.logger;
    this._handlers = { uncaughtException: null, unhandledRejection: null };

    // 注册自身为 logger 的 spanSink（若 logger 提供）
    if (this._logger) {
      this._logger.setSpanSink(this);
    }
  }

  /**
   * LogSpanSink 接口实现：仅缓冲 level >= error 的条目。
   *
   * debug/info/warn 不入缓冲以节省内存（crash 时只需最近错误定位根因）。
   * 缓冲满时覆盖最旧条目（RingBuffer.pushOverwritingOldest）。
   */
  onLog(entry: LogEntryLike): void {
    const priority = LEVEL_PRIORITY[entry.level] ?? -1;
    if (priority >= MIN_BUFFER_PRIORITY) {
      this._buffer.pushOverwritingOldest(entry);
    }
  }

  /**
   * 同步刷新：将缓冲的错误条目写入 crash 文件 + 调用 traceManager.flushSync。
   *
   * 仅在 crash 发生时调用（uncaughtException / unhandledRejection handler）。
   * 使用 appendFileSync 确保同步写入，避免异步 I/O 在进程退出前未完成。
   */
  flushSync(): void {
    // 1. 标记活跃 span 结束（尽力保存 span 状态）
    this._traceManager?.flushSync();

    // 2. 同步写入错误缓冲到 crash 文件
    if (this._crashFilePath !== undefined) {
      const entries = this._buffer.toArray();
      if (entries.length > 0) {
        const lines = entries.map((e) => JSON.stringify(e));
        appendFileSync(this._crashFilePath, lines.join('\n') + '\n', 'utf8');
      }
    }
  }

  /**
   * 注册进程级 uncaughtException / unhandledRejection 监听。
   *
   * 注册后，进程崩溃时会调用 _handleFatal：
   *   1. flushSync() 保存 span 状态 + 写入错误缓冲
   *   2. stderr 输出 crash 摘要（错误消息 + 最新一条 error/fatal 日志）
   *   3. process.exit(1) 退出进程
   *
   * 不重抛异常（uncaughtException 中重抛会无限递归）。
   */
  install(): void {
    this._handlers.uncaughtException = (err: Error) => {
      this._handleFatal(err);
    };
    this._handlers.unhandledRejection = (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this._handleFatal(err);
    };
    process.on('uncaughtException', this._handlers.uncaughtException);
    process.on('unhandledRejection', this._handlers.unhandledRejection);
  }

  /**
   * 移除 process 监听（测试用，或需要替换 CrashHandler 时）。
   *
   * 移除后 process 不再有 CrashHandler 的监听，但已缓冲的错误条目保留。
   */
  uninstall(): void {
    if (this._handlers.uncaughtException) {
      process.removeListener(
        'uncaughtException',
        this._handlers.uncaughtException
      );
      this._handlers.uncaughtException = null;
    }
    if (this._handlers.unhandledRejection) {
      process.removeListener(
        'unhandledRejection',
        this._handlers.unhandledRejection
      );
      this._handlers.unhandledRejection = null;
    }
  }

  /**
   * crash 处理核心逻辑（私有）。
   *
   * 不重抛异常：uncaughtException handler 中重抛会触发同一 handler 再次执行，
   * 导致无限递归。改为 process.exit(1) 让进程退出。
   */
  private _handleFatal(err: Error): void {
    // 1. flushSync 保存 span 状态 + 写入错误缓冲
    this.flushSync();

    // 2. stderr 输出 crash 摘要
    process.stderr.write(`[CRASH] ${err.message}\n`);
    const lastEntry = this._buffer.peekLast();
    if (lastEntry !== undefined) {
      process.stderr.write(`[LAST ERROR LOG] ${JSON.stringify(lastEntry)}\n`);
    }

    // 3. 退出进程（不重抛，避免无限递归）
    process.exit(1);
  }
}
