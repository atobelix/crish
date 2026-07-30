/**
 * @crish/logger — 轮转文件 Sink（含 Windows 文件锁兼容）
 *
 * 设计决策（ROUND-02 §6.3）：
 * - LogTransport 是函数式 `(entry) => void`，RotatingFileSink 通过 `asTransport()` 适配
 * - 写入使用同步 fs.appendFileSync（Logger.log() 是同步的，transport 调用是同步的）
 *   createWriteStream 的异步 open 与同步轮转不兼容（轮转时文件可能尚未创建 → ENOENT；
 *   且同步 sleep 会阻塞事件循环，导致 stream 无法 flush → EBUSY 死锁）。
 *   appendFileSync 每次调用原子地打开/写入/关闭，天然规避这些问题。
 * - 轮转使用同步 fs API（renameSync / unlinkSync），当 currentSize >= maxSize 时触发
 * - 维护 RingBuffer<string>（容量 50）存储最近日志行，flushSync() 用于 CrashHandler
 * - Windows EPERM/EBUSY 指数退避重试（最多 5 次，50ms 起步，系数 2）
 */
import {
  renameSync,
  existsSync,
  unlinkSync,
  appendFileSync,
  statSync,
} from 'node:fs';
import { RingBuffer } from '@crish/shared-utils';
import { CrishError } from '@crish/shared-types';
import type { LogEntry, LogTransport } from './logger';
import { formatJSON } from './formatters';

/** 可异步刷新的 transport 接口（鸭子类型，由 Logger.setFlushable 注册） */
export interface AsyncFlushable {
  flush(): Promise<void>;
}

/** RotatingFileSink 构造选项 */
export interface RotatingFileSinkOptions {
  filePath: string;
  /** 单文件最大字节数，超出后触发轮转。默认 10MB */
  maxSize?: number;
  /** 保留的轮转文件数量（不含当前文件）。默认 5 */
  maxFiles?: number;
  /** 按时间轮转的间隔（毫秒），0 = 不启用。默认 0 */
  rotateIntervalMs?: number;
  /** 文件编码。默认 utf-8 */
  encoding?: BufferEncoding;
}

/** renameWithWindowsRetrySync 的可注入选项（便于测试） */
export interface RenameWithWindowsRetryOptions {
  /** 最大重试次数。默认 5 */
  maxRetries?: number;
  /** 自定义 rename 实现（测试用）。默认 fs.renameSync */
  renameImpl?: (src: string, dest: string) => void;
  /** 自定义同步 sleep 实现（测试用）。默认内置 sleepSync */
  sleepImpl?: (ms: number) => void;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_ENCODING: BufferEncoding = 'utf-8';
const RING_BUFFER_CAPACITY = 50;

/**
 * 同步 sleep。优先使用 Atomics.wait（Node 专用），
 * SharedArrayBuffer 不可用时降级为跳过（仅退避不准，重试仍执行）。
 */
function defaultSleepSync(ms: number): void {
  if (ms <= 0) return;
  if (typeof SharedArrayBuffer !== 'undefined') {
    try {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, ms);
      return;
    } catch {
      // SharedArrayBuffer 存在但 Atomics.wait 不可用，降级
    }
  }
  // 无同步 sleep 能力时跳过延迟（不影响正确性，仅退避间隔不准）
}

/**
 * 带指数退避重试的同步 rename。
 *
 * Windows 上若杀毒软件/索引服务持有文件句柄，renameSync 会抛 EPERM/EBUSY。
 * 重试 + 指数退避是业界标准做法（winston / pino 的 Windows 兼容实现）。
 *
 * 重试耗尽后抛出 CrishError（code="common.unknown"，category="permanent"）。
 */
export function renameWithWindowsRetrySync(
  currentPath: string,
  rotatedPath: string,
  options: RenameWithWindowsRetryOptions = {}
): void {
  const maxRetries = options.maxRetries ?? 5;
  const renameImpl = options.renameImpl ?? renameSync;
  const sleepImpl = options.sleepImpl ?? defaultSleepSync;
  const baseDelayMs = 50;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      renameImpl(currentPath, rotatedPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
      if (attempt === maxRetries - 1) {
        throw new CrishError(
          `rename failed after ${maxRetries} retries: ${currentPath} -> ${rotatedPath}`,
          'common.unknown',
          'permanent',
          false,
          {
            from: currentPath,
            to: rotatedPath,
            retries: maxRetries,
            originalError: err instanceof Error ? err.message : String(err),
          }
        );
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 1000);
      sleepImpl(delay);
    }
  }
}

/**
 * 轮转文件 Sink。
 *
 * 实现 LogTransport（通过 asTransport() 返回函数式 transport）与 AsyncFlushable。
 * 使用 fs.appendFileSync 同步写入，当 currentSize >= maxSize 时同步轮转。
 * 维护 RingBuffer<string> 存储最近 50 条日志行，flushSync() 写入 .crash 文件供 CrashHandler 使用。
 */
export class RotatingFileSink implements AsyncFlushable {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private readonly encoding: BufferEncoding;
  private currentSize: number;
  private readonly ringBuffer: RingBuffer<string>;
  private readonly renameOptions: RenameWithWindowsRetryOptions;
  private closed: boolean;

  constructor(options: RotatingFileSinkOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.encoding = options.encoding ?? DEFAULT_ENCODING;
    this.ringBuffer = new RingBuffer<string>(RING_BUFFER_CAPACITY);
    this.renameOptions = {};
    this.closed = false;
    // 从已有文件恢复 currentSize（追加模式继续写入）
    try {
      const stats = statSync(this.filePath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }
  }

  /**
   * 写入一条日志。LogTransport 兼容入口（通过 asTransport() 适配）。
   * 同步格式化 + appendFileSync 写入 + 累加 currentSize + 推入 RingBuffer + 触发轮转检查。
   */
  write(entry: LogEntry): void {
    if (this.closed) return;
    const line = formatJSON(entry);
    appendFileSync(this.filePath, line, this.encoding);
    this.currentSize += Buffer.byteLength(line, this.encoding);
    this.ringBuffer.pushOverwritingOldest(line);
    if (this.currentSize >= this.maxSize) {
      this.rotateSync();
    }
  }

  /**
   * 同步轮转：删除最旧文件 → 逆序重命名 .{N}→.{N+1} → 当前文件→.{1}。
   * 使用 renameWithWindowsRetrySync 处理 Windows EPERM/EBUSY。
   *
   * 文件命名约定（maxFiles=5）：
   *   app.log   ← 当前写入
   *   app.log.1 ← 上一次轮转
   *   ...
   *   app.log.5 ← 最旧（下次轮转删除）
   */
  private rotateSync(): void {
    // 删除最旧文件（.{maxFiles}）
    const oldestPath = `${this.filePath}.${this.maxFiles}`;
    if (existsSync(oldestPath)) {
      try {
        unlinkSync(oldestPath);
      } catch {
        // 最旧文件删除失败不阻塞轮转（可能已被外部进程清理）
      }
    }

    // 逆序重命名：.{maxFiles-1} → .{maxFiles}, ..., .{1} → .{2}
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (existsSync(from)) {
        renameWithWindowsRetrySync(from, to, this.renameOptions);
      }
    }

    // 当前文件 → .1
    if (existsSync(this.filePath)) {
      renameWithWindowsRetrySync(
        this.filePath,
        `${this.filePath}.1`,
        this.renameOptions
      );
    }

    this.currentSize = 0;
  }

  /**
   * 异步刷新：appendFileSync 已同步落盘，无需额外操作。
   * 满足 AsyncFlushable 接口契约，供 Logger.flush() 通过 setFlushable 调用。
   */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 同步刷新：将 RingBuffer 中的最近 50 条日志行写入 ${filePath}.crash 文件。
   * **仅用于 CrashHandler**（进程崩溃前最后一搏持久化），正常路径不调用。
   * 写入 .crash 后缀文件避免与主日志文件冲突。
   */
  flushSync(): void {
    const crashPath = `${this.filePath}.crash`;
    this.ringBuffer.forEach((line: string) => {
      appendFileSync(crashPath, line);
    });
  }

  /** 标记 sink 已关闭，后续 write 调用将被忽略。 */
  async close(): Promise<void> {
    this.closed = true;
  }

  /** 返回函数式 LogTransport，委托到 this.write。 */
  asTransport(): LogTransport {
    return (entry: LogEntry) => this.write(entry);
  }
}
