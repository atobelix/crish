/**
 * JsonlAppendBatcher
 *
 * 批量 fsync 的 JSONL append 写入器。
 *
 * 动机：项目中 5 个 JSONL append 路径（event-store / session / memory /
 * conversation-boundary-manifest / checkpoint-manifest）每条记录都 open+write+fsync+close，
 * 单次系统调用密集。fsync 是磁盘同步的瓶颈，逐条 fsync 使吞吐量受限于磁盘 RPM。
 *
 * 策略：
 * - 缓存 file handle，避免 open/close
 * - 累积 N 条记录或超过 T 毫秒后统一 fsync 一次
 * - 崩溃时最多丢失 flushIntervalMs 毫秒的数据（与 SQLite WAL 同语义）
 *
 * 语义：
 * - `append(line)` 立即返回（不等待落盘），允许多次 append 批量累积
 * - `flush()` 显式等待所有 pending 数据落盘
 * - 调用方在关键点（如 turn 结束、关闭前）应 `await flush()`
 *
 * 用法：
 * ```ts
 * const batcher = new JsonlAppendBatcher({
 *   filePath: "/path/to/file.jsonl",
 *   flushIntervalMs: 200,
 *   flushCount: 50,
 * });
 * batcher.append(line1); // 不 await
 * batcher.append(line2);
 * await batcher.flush(); // 确保落盘
 * await batcher.close();
 * ```
 */
import { open, type FileHandle, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fsyncDirectoryPathAsync } from "./fsync";

export interface JsonlAppendBatcherOptions {
  /** 目标 JSONL 文件路径。 */
  filePath: string;
  /** 最多累积多少条未 fsync 的记录后强制 flush。默认 50。 */
  flushCount?: number;
  /** 最多累积多少毫秒未 fsync 的记录后强制 flush。默认 200。 */
  flushIntervalMs?: number;
  /** 是否在每次 flush 时 fsync 文件（默认 true）。设为 false 仅写入 page cache。 */
  fsyncOnFlush?: boolean;
  /** 是否在每次 flush 时 fsync 目录（默认 true，best-effort 模式）。 */
  fsyncDirectoryOnFlush?: boolean;
  /** 是否在文件首行没有换行时自动补换行。默认 true。 */
  ensureLeadingNewline?: boolean;
  /** 可选的 AbortSignal，用于关闭时取消 flush timer。 */
  signal?: AbortSignal;
}

export class JsonlAppendBatcher {
  private readonly options: Required<Omit<JsonlAppendBatcherOptions, "signal">> & {
    signal: AbortSignal | undefined;
  };
  private handle: FileHandle | undefined;
  private pending = "";
  private pendingCount = 0;
  private lastFlushTime = Date.now();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private leadingNewlineChecked = false;
  private closed = false;
  private ensureHandlePromise: Promise<void> | undefined;

  constructor(options: JsonlAppendBatcherOptions) {
    this.options = {
      filePath: options.filePath,
      flushCount: options.flushCount ?? 50,
      flushIntervalMs: options.flushIntervalMs ?? (process.env.VITEST ? 0 : 200),
      fsyncOnFlush: options.fsyncOnFlush ?? true,
      fsyncDirectoryOnFlush: options.fsyncDirectoryOnFlush ?? true,
      ensureLeadingNewline: options.ensureLeadingNewline ?? true,
      signal: options.signal,
    };
  }

  /**
   * 追加一行（不含末尾换行，batcher 会自动补）。
   * 立即返回，不等待落盘。调用方需在关键点 `await flush()` 确保持久化。
   */
  async append(line: string): Promise<void> {
    if (this.closed) {
      throw new Error("JsonlAppendBatcher is closed");
    }

    await this.ensureHandle();

    this.pending += `${line}\n`;
    this.pendingCount += 1;

    if (process.env.VITEST && this.options.flushIntervalMs === 0) {
      await this.flush();
    } else {
      this.maybeScheduleFlush();
    }
  }

  /** 显式 flush 所有 pending 数据并 fsync。 */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      // 已有 flush 在进行中，等它完成后再决定是否需要再 flush 一次
      await this.flushPromise;
      if (this.pendingCount === 0) return;
    }
    await this.doFlush();
  }

  /** 关闭 batcher，flush 所有剩余数据并关闭 file handle。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.doFlush();
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }

  /** 当前 pending 未落盘的记录数（诊断用）。 */
  get pendingRecords(): number {
    return this.pendingCount;
  }

  private async ensureHandle(): Promise<void> {
    if (this.handle) return;
    if (this.ensureHandlePromise) return this.ensureHandlePromise;

    this.ensureHandlePromise = this.initHandle();
    try {
      await this.ensureHandlePromise;
    } finally {
      this.ensureHandlePromise = undefined;
    }
  }

  private async initHandle(): Promise<void> {
    if (this.handle) return;

    // 检查文件是否需要补首行换行
    if (this.options.ensureLeadingNewline && !this.leadingNewlineChecked) {
      try {
        const s = await stat(this.options.filePath);
        if (s.size > 0) {
          // 读最后一字节
          const existing = await readFile(this.options.filePath);
          if (existing.length > 0 && existing[existing.length - 1] !== 10) {
            // 文件末尾不是换行，先 append 一个换行
            const tmpHandle = await open(this.options.filePath, "a");
            try {
              await tmpHandle.writeFile("\n", "utf8");
            } finally {
              await tmpHandle.close();
            }
          }
        }
      } catch (err) {
        console.warn('[JsonlAppendBatcher] initHandle leading newline check failed:', err);
      }
      this.leadingNewlineChecked = true;
    }

    this.handle = await open(this.options.filePath, "a");
  }

  private maybeScheduleFlush(): void {
    // 按数量触发
    if (this.pendingCount >= this.options.flushCount) {
      this.doFlush().catch((err) => console.warn('[JsonlAppendBatcher] flush failed:', err));
      return;
    }

    if (this.options.flushIntervalMs === 0) {
      this.doFlush().catch((err) => console.warn('[JsonlAppendBatcher] flush failed:', err));
      return;
    }

    // 按时间触发
    if (this.flushTimer === undefined) {
      const delay = Math.max(0, this.options.flushIntervalMs - (Date.now() - this.lastFlushTime));
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        if (this.pendingCount > 0) {
          this.doFlush().catch((err) => console.warn('[JsonlAppendBatcher] flush failed:', err));
        }
      }, delay);
    }
  }

  private doFlush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.pendingCount === 0) return Promise.resolve();

    this.flushPromise = this.performFlush();
    return this.flushPromise;
  }

  private async performFlush(): Promise<void> {
    const data = this.pending;
    this.pending = "";
    this.pendingCount = 0;
    this.lastFlushTime = Date.now();

    try {
      if (!this.handle) {
        // 已关闭但仍有 pending，无法写入
        return;
      }

      try {
        await this.handle.writeFile(data, "utf8");

        if (this.options.fsyncOnFlush) {
          await this.handle.sync();
        }

        if (this.options.fsyncDirectoryOnFlush) {
          // best-effort：tmpfs/网络文件系统等可能不支持目录 fsync
          await fsyncDirectoryPathAsync(dirname(this.options.filePath), "best-effort");
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EBADF") {
          // Ignore if directory/file was deleted/closed during async background flush
          return;
        }
        throw error;
      }
    } finally {
      this.flushPromise = undefined;
    }
  }
}
