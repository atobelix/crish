/**
 * StreamingFileReader
 *
 * 流式文件读取器，基于 node:fs/promises FileHandle 实现分块读取。
 *
 * 设计意图：
 * - 替代完整 readFile + split('\n') 的全量内存模式
 * - 峰值内存从 O(fileSize) 降到 O(chunkSize)（默认 64KB）
 * - 支持逐行迭代（[Symbol.asyncIterator]）和指定行数读取（readLines）
 *
 * 性能特征：
 * - readNextBytes() 返回原始 Buffer 块，零解析开销
 * - readLines() / async iterator 内部维护 remainder 字符串处理跨块行边界
 * - 适合大文件（session JSONL >10MB, git diff 输出等）
 */
import { open, stat, type FileHandle } from "node:fs/promises";

export interface StreamingFileReaderOptions {
  /** 读取块大小（字节），默认 65536（64KB）。 */
  highWaterMark?: number;
}

export class StreamingFileReader {
  private handle: FileHandle | undefined;
  private _position = 0;
  private _size = 0;
  private _closed = false;
  private remainder = "";
  private readonly highWaterMark: number;

  constructor(
    private readonly filePath: string,
    options?: StreamingFileReaderOptions,
  ) {
    this.highWaterMark = options?.highWaterMark ?? 65536;
  }

  /** 打开文件并获取大小，不读内容。 */
  async open(): Promise<void> {
    if (this.handle) return;
    const s = await stat(this.filePath);
    this._size = s.size;
    this.handle = await open(this.filePath, "r");
  }

  /**
   * 读取下一块数据。
   * @param size 读取字节数，默认 highWaterMark（64KB）。
   * @returns Buffer，文件末尾返回 null。
   */
  async readNextBytes(size?: number): Promise<Buffer | null> {
    const handle = this.ensureOpen();
    if (this._position >= this._size) return null;

    const chunkSize = Math.min(size ?? this.highWaterMark, this._size - this._position);
    if (chunkSize <= 0) return null;

    const buf = Buffer.alloc(chunkSize);
    const { bytesRead } = await handle.read(buf, 0, chunkSize, this._position);
    if (bytesRead === 0) return null;

    this._position += bytesRead;
    return buf.subarray(0, bytesRead);
  }

  /**
   * 读取指定行数。
   * 内部处理跨块的行边界（维护 remainder 字符串）。
   */
  async readLines(limit: number): Promise<string[]> {
    this.ensureOpen();
    const lines: string[] = [];

    while (lines.length < limit) {
      // 先处理 remainder（来自上次调用的不完整行）
      if (this.remainder.length > 0) {
        const rd = this.remainder;
        this.remainder = "";
        const parts = rd.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (lines.length >= limit) {
            this.remainder = parts.slice(i).join("\n");
            return lines;
          }
          lines.push(parts[i]!);
        }
        if (lines.length >= limit) return lines;
      }

      const chunk = await this.readNextBytes();
      if (chunk === null) {
        break;
      }

      const text = this.remainder + chunk.toString("utf8");
      this.remainder = "";
      const parts = text.split("\n");
      this.remainder = parts.pop() ?? "";

      for (let i = 0; i < parts.length; i++) {
        if (lines.length >= limit) {
          const remaining = parts.slice(i).join("\n");
          this.remainder = remaining + (this.remainder.length > 0 ? "\n" + this.remainder : "");
          break;
        }
        lines.push(parts[i]!);
      }
    }

    return lines;
  }

  /** 逐行迭代器。独立状态，不依赖 readLines 的 remainder。 */
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    let remainder = "";
    while (true) {
      const chunk = await this.readNextBytes();
      if (chunk === null) {
        if (remainder.length > 0) yield remainder;
        return;
      }
      const text = remainder + chunk.toString("utf8");
      const parts = text.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        yield part;
      }
    }
  }

  /** 关闭文件句柄。 */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }

  /** 文件总大小（字节）。需先调用 open()。 */
  get size(): number {
    return this._size;
  }

  /** 当前读取位置（字节）。 */
  get position(): number {
    return this._position;
  }

  /** 是否已关闭。 */
  get closed(): boolean {
    return this._closed;
  }

  private ensureOpen(): FileHandle {
    if (!this.handle) {
      throw new Error("StreamingFileReader is not opened. Call open() first.");
    }
    return this.handle;
  }
}
