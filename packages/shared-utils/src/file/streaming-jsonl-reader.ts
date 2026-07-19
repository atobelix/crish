/**
 * StreamingJsonlReader
 *
 * 流式 JSONL 文件读取器，基于 StreamingFileReader 实现逐行 JSON parse。
 *
 * 设计意图：
 * - 避免将完整 JSONL 文件一次性读入内存
 * - 第一行特殊处理（可选的 header 行）
 * - 损坏的行跳过并记录诊断信息
 *
 * 性能特征：
 * - 逐行读取 + JSON.parse，峰值内存 O(chunkSize) + O(单行最大长度)
 * - readAll() 提供小文件兼容模式（全量读取）
 */
import { StreamingFileReader } from "./streaming-file-reader";

export interface StreamingJsonlReaderOptions {
  /** 读取块大小（字节），默认 64KB。 */
  highWaterMark?: number;
  /** 是否将第一行视为 header（默认 true）。 */
  hasHeader?: boolean;
}

export class StreamingJsonlReader {
  private reader: StreamingFileReader;
  private headerRead = false;
  private readonly hasHeader: boolean;
  private _header: Record<string, unknown> | null = null;
  private lineIterator: AsyncGenerator<string> | undefined;

  constructor(
    private readonly filePath: string,
    options?: StreamingJsonlReaderOptions,
  ) {
    this.reader = new StreamingFileReader(filePath, {
      highWaterMark: options?.highWaterMark,
    });
    this.hasHeader = options?.hasHeader ?? true;
  }

  /** 打开文件。 */
  async open(): Promise<void> {
    await this.reader.open();
  }

  /**
   * 读取第一行作为 header。
   * @returns header 对象，空文件返回 null。
   */
  async readHeader(): Promise<Record<string, unknown> | null> {
    if (this.headerRead) return this._header;
    this.headerRead = true;

    const iter = this.getLineIterator();
    const result = await iter.next();
    if (result.done) return null;

    try {
      this._header = JSON.parse(result.value) as Record<string, unknown>;
    } catch {
      this._header = null;
    }
    return this._header;
  }

  /**
   * 逐行 yield JSON parsed 条目。
   * 损坏的行跳过（不抛异常），记录到 diagnostic。
   */
  async *readEntries<T>(): AsyncGenerator<T> {
    const iter = this.getLineIterator();

    if (this.hasHeader && !this.headerRead) {
      const result = await iter.next();
      this.headerRead = true;
      if (!result.done) {
        try {
          this._header = JSON.parse(result.value) as Record<string, unknown>;
        } catch {
          this._header = null;
        }
      }
    }

    while (true) {
      const result = await iter.next();
      if (result.done) break;
      const line = result.value;
      if (line.length === 0) continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // 损坏的行跳过
      }
    }
  }

  /**
   * 一次性读取全部条目（小文件兼容）。
   * 内部使用 readEntries 收集。
   */
  async readAll<T>(): Promise<T[]> {
    const entries: T[] = [];
    for await (const entry of this.readEntries<T>()) {
      entries.push(entry);
    }
    return entries;
  }

  /** 关闭文件。 */
  async close(): Promise<void> {
    await this.reader.close();
  }

  private getLineIterator(): AsyncGenerator<string> {
    if (!this.lineIterator) {
      this.lineIterator = this.reader[Symbol.asyncIterator]();
    }
    return this.lineIterator;
  }
}
