/**
 * GroupCommitWal — Group-Commit WAL 存储引擎
 *
 * 动机：JsonlAppendBatcher 逐条 fsync 写入吞吐受限。
 * Group-Commit 将多条记录在内存中累积，作为一批原子写入。
 *
 * 策略：
 * - 累积 MAX_BATCH 条记录或超过 MAX_LATENCY_MS 后触发 commit
 * - commit 将当前批次原子写入新 segment 文件（tmp + rename）
 * - 崩溃时最多丢失 MAX_LATENCY_MS 毫秒的数据
 *
 * 文件布局：
 * walDir/
 * ├── seq-0000000000000001.wal
 * ├── seq-0000000000000065.wal
 * └── seq-0000000000000129.wal
 *
 * 每个 segment 文件包含多条 JSONL 记录，
 * 文件名的 sequence 是该文件中第一条记录的 sequence。
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fsyncPathAsync } from "./fsync";

export interface WalRecord {
  sequence: bigint;
  eventType: string;
  payload: Uint8Array;
}

/**
 * 紧凑文本格式：sequence|eventType|base64payload\n
 * 相比 JSON 消除了 {"s":"...","t":"...","p":"..."} 的字段 key 和引号开销。
 */
const WAL_FIELD_SEPARATOR = "|";

function encodeWalRecord(r: WalRecord): string {
  const seq = r.sequence.toString();
  const buf = Buffer.from(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
  const b64 = buf.toString("base64");
  return `${seq}${WAL_FIELD_SEPARATOR}${r.eventType}${WAL_FIELD_SEPARATOR}${b64}`;
}

function decodeWalRecord(line: string): WalRecord {
  const sepIdx = line.indexOf(WAL_FIELD_SEPARATOR);
  const seqStr = line.slice(0, sepIdx);
  const rest = line.slice(sepIdx + 1);
  const sepIdx2 = rest.indexOf(WAL_FIELD_SEPARATOR);
  const eventType = rest.slice(0, sepIdx2);
  const b64 = rest.slice(sepIdx2 + 1);
  return {
    sequence: BigInt(seqStr),
    eventType,
    payload: Buffer.from(b64, "base64"),
  };
}

function segmentFileName(seq: bigint): string {
  return `seq-${seq.toString().padStart(16, "0")}.wal`;
}

interface PendingBatch {
  records: WalRecord[];
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class GroupCommitWal {
  private queue: WalRecord[] = [];
  private readonly MAX_BATCH = 64;
  private readonly MAX_LATENCY_MS = 10;
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingFlush: Promise<void> | null = null;
  private pendingBatches: PendingBatch[] = [];
  private closed = false;
  private walDir: string;

  constructor(walDir: string) {
    this.walDir = walDir;
  }

  async append(records: WalRecord[]): Promise<void> {
    if (this.closed) throw new Error("GroupCommitWal is closed");

    return new Promise<void>((resolve, reject) => {
      this.queue.push(...records);
      this.pendingBatches.push({ records, resolve, reject });
      this.scheduleCommit();
    });
  }

  private scheduleCommit(): void {
    if (this.queue.length >= this.MAX_BATCH) {
      this.commit().catch((err) => console.warn('[Wal] commit failed:', err));
    } else if (!this.commitTimer) {
      this.commitTimer = setTimeout(() => {
        this.commitTimer = undefined;
        if (this.queue.length > 0) {
          this.commit().catch((err) => console.warn('[Wal] commit failed:', err));
        }
      }, this.MAX_LATENCY_MS);
    }
  }

  async replay(afterSeq: bigint): Promise<WalRecord[]> {
    await this.ensureDir();

    const files = await readdir(this.walDir);
    const walFiles = files
      .filter((f) => f.startsWith("seq-") && f.endsWith(".wal"))
      .sort();

    const result: WalRecord[] = [];

    for (const file of walFiles) {
      const content = await readFile(join(this.walDir, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const record = decodeWalRecord(line);
        if (record.sequence > afterSeq) {
          result.push(record);
        }
      }
    }

    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    if (this.queue.length > 0) {
      await this.commit();
    }
  }

  private async commit(): Promise<void> {
    if (this.pendingFlush) return this.pendingFlush;

    this.pendingFlush = this.performCommit();
    try {
      await this.pendingFlush;
    } finally {
      this.pendingFlush = null;
      if (this.queue.length > 0) {
        this.scheduleCommit();
      }
    }
  }

  private async performCommit(): Promise<void> {
    const batch = this.queue.splice(0);
    const callbacks = this.pendingBatches.splice(0);

    if (batch.length === 0) {
      callbacks.forEach((cb) => cb.resolve());
      return;
    }

    try {
      await this.ensureDir();

      const firstSeq = batch[0]!.sequence;
      const tmpPath = join(this.walDir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.wal`);
      const finalPath = join(this.walDir, segmentFileName(firstSeq));

      const content = batch.map(encodeWalRecord).join("\n") + "\n";
      await writeFile(tmpPath, content, "utf-8");
      await fsyncPathAsync(tmpPath);
      await rename(tmpPath, finalPath);

      callbacks.forEach((cb) => cb.resolve());
    } catch (error) {
      callbacks.forEach((cb) => cb.reject(error));
      throw error;
    }
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.walDir)) {
      await mkdir(this.walDir, { recursive: true });
    }
  }
}
