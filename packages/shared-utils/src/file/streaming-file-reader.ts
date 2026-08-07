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
 *
 * T3.8 D8：UTF-8 增量解码（StringDecoder）——跨块的多字节字符（如「中」E4 B8 AD
 * 被切分到相邻两块）由 decoder 保留半字节续接解码，不再出现 U+FFFD 替换损坏。
 * 注意：readLines 与 async iterator 共用同一 decoder 与文件游标，两者不得在同一
 * 流上混用（与既有 remainder 状态约束一致）；close() 无需额外释放 decoder（无外部资源）。
 */
import { open, stat, type FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export interface StreamingFileReaderOptions {
  /** 读取块大小（字节），默认 65536（64KB）。 */
  highWaterMark?: number;
}

export class StreamingFileReader {
  private handle: FileHandle | undefined;
  private _position = 0;
  private _size = 0;
  private _closed = false;
  private remainder = '';
  private readonly highWaterMark: number;
  /** T3.8 D8：增量 UTF-8 解码器——跨块保留半字符字节，续接解码不产生 U+FFFD */
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly filePath: string,
    options?: StreamingFileReaderOptions
  ) {
    this.highWaterMark = options?.highWaterMark ?? 65536;
  }

  /** 打开文件并获取大小，不读内容。 */
  async open(): Promise<void> {
    if (this.handle) return;
    const s = await stat(this.filePath);
    this._size = s.size;
    this.handle = await open(this.filePath, 'r');
  }

  /**
   * 读取下一块数据。
   * @param size 读取字节数，默认 highWaterMark（64KB）。
   * @returns Buffer，文件末尾返回 null。
   */
  async readNextBytes(size?: number): Promise<Buffer | null> {
    const handle = this.ensureOpen();
    if (this._position >= this._size) return null;

    const chunkSize = Math.min(
      size ?? this.highWaterMark,
      this._size - this._position
    );
    if (chunkSize <= 0) return null;

    const buf = Buffer.alloc(chunkSize);
    const { bytesRead } = await handle.read(buf, 0, chunkSize, this._position);
    if (bytesRead === 0) return null;

    this._position += bytesRead;
    return buf.subarray(0, bytesRead);
  }

  /**
   * 读取指定行数。
   * 内部处理跨块的行边界（remainder 只保留部分行，跨块续接后按 \n 产出完整行）。
   */
  async readLines(limit: number): Promise<string[]> {
    this.ensureOpen();
    const lines: string[] = [];

    while (lines.length < limit) {
      // 先处理 remainder：多调用场景下可能含「提前返回」回退的完整行；
      // 其余情况为部分行（无 \n），在此不产出，等待与下一块续接。
      if (this.remainder.length > 0) {
        const parts = this.remainder.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (lines.length >= limit) {
            this.remainder = parts.slice(i).join('\n');
            return lines;
          }
          if (i < parts.length - 1) {
            lines.push(parts[i]!);
          } else {
            this.remainder = parts[i]!;
          }
        }
      }

      const chunk = await this.readNextBytes();
      if (chunk === null) {
        // EOF：冲刷 decoder 残余半字节（文件以不完整 UTF-8 序列结尾的畸形文件
        // 兜底），与部分行 remainder 拼成末行；正常文件 tail 为空串。
        const tail = this.decoder.end();
        const last = this.remainder + tail;
        this.remainder = '';
        if (last.length > 0) {
          lines.push(last);
        }
        break;
      }

      // T3.8 D8：增量解码——decoder 保留跨块半字符字节，续接解码不产生 U+FFFD
      const text = this.remainder + this.decoder.write(chunk);
      const parts = text.split('\n');
      const tail = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i++) {
        if (lines.length >= limit) {
          // 本批已满：剩余完整行 + 部分行一并回退 remainder（下次调用续读）
          this.remainder =
            parts.slice(i).join('\n') + (tail.length > 0 ? '\n' + tail : '');
          return lines;
        }
        lines.push(parts[i]!);
      }
      this.remainder = tail;
    }

    return lines;
  }

  /** 逐行迭代器。独立状态，不依赖 readLines 的 remainder。 */
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    let remainder = '';
    while (true) {
      const chunk = await this.readNextBytes();
      if (chunk === null) {
        // T3.8 D8：EOF 冲刷 decoder 残余字节（正常文件为空串）
        const tail = this.decoder.end();
        if (remainder.length > 0 || tail.length > 0) yield remainder + tail;
        return;
      }
      const text = remainder + this.decoder.write(chunk);
      const parts = text.split('\n');
      remainder = parts.pop() ?? '';
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
      throw new Error('StreamingFileReader is not opened. Call open() first.');
    }
    return this.handle;
  }
}
