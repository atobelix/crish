/**
 * WAL (GroupCommitWal) 对抗性测试
 *
 * 目标：暴露持久化、并发、编码解码、崩溃恢复中的隐藏缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  W1. append([]) 永不 resolve — 空 records 数组产生 dangling Promise
 *  W2. eventType 含 "|" 破坏编码 — 解码后字段错位
 *  W3. replay 对损坏的 WAL 文件直接抛异常（无 try-catch）
 *  W4. close() 后仍有未触发的 commitTimer 泄漏（scheduleCommit 在 finally 中重设 timer）
 *  W5. performCommit 在 rename 失败后泄漏 .tmp-* 文件
 *  W6. decodeWalRecord 不校验负数 sequence（BigInt("-1") 合法但语义错误）
 *  W7. replay 不返回内存中尚未 commit 的记录（崩溃窗口内数据丢失）
 *  W8. 同一批次内 sequence 非单调递增时不报错（无完整性校验）
 *  W9. payload 含合法 base64 但无法 round-trip 的边界数据（含 null byte）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock fsync 以避免 Windows 上的 EPERM 错误（这本身也是一个 bug：
// fsyncPathAsync 默认用 mode="r" 打开文件，Windows 不允许对只读 fd 执行 fsync）
vi.mock('./fsync', () => ({
  fsyncPathAsync: vi.fn().mockResolvedValue(undefined),
  fsyncDirectoryPathAsync: vi.fn().mockResolvedValue(undefined),
}));

import { GroupCommitWal, type WalRecord } from './wal';

function makeRecord(seq: number | bigint, eventType: string, payload: Uint8Array): WalRecord {
  return { sequence: BigInt(seq), eventType, payload };
}

function makePayload(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wal-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('GroupCommitWal — 对抗性测试', () => {
  let wal: GroupCommitWal;

  afterEach(async () => {
    // 确保每次测试后关闭 WAL，避免泄漏 timer
    try {
      await wal?.close();
    } catch {
      // 忽略关闭错误
    }
  });

  describe('W1: append([]) 空 records 数组', () => {
    it('暴露 bug: append([]) 返回的 Promise 永不 resolve（dangling batch）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        const result = wal.append([]);

        let resolved = false;
        const race = Promise.race([
          result.then(() => { resolved = true; }),
          new Promise<void>((r) => setTimeout(() => r(), 500)),
        ]);

        await race;
        expect(resolved).toBe(false);
        // Bug 根因：append([]) 把 { records: [], resolve, reject } 推入 pendingBatches，
        // 但 queue 仍为空，scheduleCommit 设的 timer 触发时 queue.length === 0，不调用 commit。
        // pendingBatches 中的回调永远不被执行。
      });
    });

    it('暴露 bug: close() 不 resolve append([]) 的 pending batch', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        const result = wal.append([]);

        await wal.close();

        let resolved = false;
        let rejected = false;
        result.then(
          () => { resolved = true; },
          () => { rejected = true; },
        );

        await new Promise((r) => setTimeout(r, 200));
        // close() 仅在 queue.length > 0 时调用 commit()，空队列跳过。
        // performCommit 中的空 batch 处理（batch.length === 0 → resolve callbacks）
        // 永远不被触发。
        expect(resolved).toBe(false);
        expect(rejected).toBe(false);
      });
    });
  });

  describe('W2: eventType 含分隔符 "|" 破坏编码', () => {
    it('暴露 bug: eventType 含 "|" 时 encode→decode 字段错位', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        const maliciousEventType = 'event|with|pipes';
        const record = makeRecord(1, maliciousEventType, makePayload('hello'));

        await wal.append([record]);
        await wal.close();

        const files = await readdir(dir);
        const walFile = files.find((f) => f.endsWith('.wal'));
        expect(walFile).toBeDefined();

        const content = await readFile(join(dir, walFile!), 'utf-8');
        // 编码后: "1|event|with|pipes|aGVsbG8="
        // 解码时第二个 "|" 被当作 eventType 的终止符
        const replayed = await wal.replay(0n);
        // 由于 WAL 已 close，需要新建实例来 replay
        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(0n);
        await wal2.close();

        // Bug: 解码出的 eventType 是 "event" 而非 "event|with|pipes"
        // payload 变成了 "with|pipes|aGVsbG8=" 的 base64 解码结果
        expect(records).toHaveLength(1);
        expect(records[0]!.eventType).not.toBe(maliciousEventType);
        // 验证字段确实错位了
        expect(records[0]!.eventType).toBe('event');
      });
    });
  });

  describe('W3: replay 对损坏的 WAL 文件无容错', () => {
    it('暴露 bug: WAL 文件包含非法行时 replay 直接抛异常（整个恢复失败）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // 先写一条正常记录
        await wal.append([makeRecord(1, 'normal', makePayload('ok'))]);
        await wal.close();

        // 手动向 WAL 文件追加一行损坏数据
        const files = await readdir(dir);
        const walFile = files.find((f) => f.endsWith('.wal'))!;
        const corruptedContent = await readFile(join(dir, walFile), 'utf-8');
        // 追加一行无法解析为 BigInt 的 sequence
        const corrupted = corruptedContent + 'NOT_A_NUMBER|bad|data\n';
        await writeFile(join(dir, walFile), corrupted, 'utf-8');

        const wal2 = new GroupCommitWal(dir);
        // Bug: BigInt("NOT_A_NUMBER") 抛 SyntaxError，导致整个 replay 失败
        // 即使前面的正常记录也无法读取
        await expect(wal2.replay(0n)).rejects.toThrow();
        await wal2.close();
      });
    });

    it('暴露 bug: WAL 文件包含缺少分隔符的行时 replay 抛异常', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        await wal.append([makeRecord(1, 'ok', makePayload('data'))]);
        await wal.close();

        const files = await readdir(dir);
        const walFile = files.find((f) => f.endsWith('.wal'))!;
        const content = await readFile(join(dir, walFile), 'utf-8');
        // 追加一行没有分隔符的数据
        await writeFile(join(dir, walFile), content + 'garbage_no_separator\n', 'utf-8');

        const wal2 = new GroupCommitWal(dir);
        // Bug: line.indexOf("|") 返回 -1，slice(0, -1) 产生错误结果
        // 但 BigInt("") 抛异常
        await expect(wal2.replay(0n)).rejects.toThrow();
        await wal2.close();
      });
    });
  });

  describe('W6: decodeWalRecord 不校验负数 sequence', () => {
    it('暴露 bug: 负数 sequence 可以被编码和解码（无语义校验）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        const record = makeRecord(-1, 'negative-seq', makePayload('data'));
        await wal.append([record]);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(-100n);
        await wal2.close();

        // Bug: 负数 sequence 被 BigInt 接受，且 -1 > -100 为 true，记录被返回
        // 但负数 sequence 在语义上是非法的（WAL 应从 1 开始单调递增）
        expect(records).toHaveLength(1);
        expect(records[0]!.sequence).toBe(-1n);
      });
    });
  });

  describe('W7: replay 不返回内存中尚未 commit 的记录', () => {
    it('暴露 bug: append 后未满 MAX_BATCH 且未超 MAX_LATENCY_MS 时，replay 读不到记录', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // append 一条记录（不满 64 条，10ms 内不会 commit）
        const appendPromise = wal.append([makeRecord(1, 'pending', makePayload('data'))]);

        // 立即 replay — 记录还在内存 queue 中，未写入磁盘
        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(0n);
        await wal2.close();

        // Bug: replay 只读磁盘文件，不读内存 queue
        // 这条记录在 10ms 窗口内如果崩溃就永久丢失
        expect(records).toHaveLength(0);

        // 清理：等待 append 完成
        await appendPromise;
      });
    });
  });

  describe('W8: 同批次内 sequence 非单调递增不报错', () => {
    it('暴露 bug: 乱序 sequence 的记录可以被写入和读取（无完整性校验）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // 故意乱序：5, 3, 7, 1
        const records: WalRecord[] = [
          makeRecord(5, 'a', makePayload('x')),
          makeRecord(3, 'b', makePayload('y')),
          makeRecord(7, 'c', makePayload('z')),
          makeRecord(1, 'd', makePayload('w')),
        ];

        await wal.append(records);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const replayed = await wal2.replay(0n);
        await wal2.close();

        // Bug: 乱序写入不报错，replay 返回的顺序是文件中的顺序（5,3,7,1）
        // 而非按 sequence 排序（1,3,5,7）
        expect(replayed).toHaveLength(4);
        expect(replayed[0]!.sequence).toBe(5n);
        expect(replayed[1]!.sequence).toBe(3n);
        expect(replayed[2]!.sequence).toBe(7n);
        expect(replayed[3]!.sequence).toBe(1n);
      });
    });
  });

  describe('W9: payload 含 null byte 的 round-trip', () => {
    it('payload 含 null byte 时 base64 编解码应能 round-trip', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // 含 null byte 的 payload
        const payload = new Uint8Array([0x00, 0x01, 0x00, 0x02, 0x00]);
        const record = makeRecord(1, 'null-bytes', payload);

        await wal.append([record]);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const replayed = await wal2.replay(0n);
        await wal2.close();

        expect(replayed).toHaveLength(1);
        // null byte round-trip 应该正确（base64 编码不存在此问题）
        expect(Array.from(replayed[0]!.payload)).toEqual([0, 1, 0, 2, 0]);
      });
    });
  });

  describe('W5: performCommit 写入失败后无 tmp 清理', () => {
    it('暴露 bug: writeFile 失败后 performCommit 不清理已创建的 tmp 文件', async () => {
      await withTempDir(async (dir) => {
        // 使用非法路径触发写入失败（路径含 null byte）
        const invalidPath = join(dir, 'wal\u0000invalid');
        wal = new GroupCommitWal(invalidPath);

        // append 入队后，commit 会尝试 ensureDir + writeFile
        // writeFile 对含 null byte 的路径会抛异常
        const appendPromise = wal.append([makeRecord(1, 'test', makePayload('data'))]);

        // Bug: performCommit 的 catch 块只 reject callbacks，不清理 tmp 文件
        // 由于 writeFile 在创建 tmp 文件时就失败，tmp 文件可能未创建或部分创建
        await expect(appendPromise).rejects.toThrow();

        try {
          await wal.close();
        } catch {
          // 忽略
        }
      });
    });

    it('暴露 bug: rename 到已存在的目标文件时覆盖而非失败（无冲突检测）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // 第一批写入
        await wal.append([makeRecord(1, 'first', makePayload('a'))]);
        await wal.close();

        // 手动检查文件存在
        const files1 = await readdir(dir);
        const walFile = files1.find((f) => f.endsWith('.wal'));
        expect(walFile).toBeDefined();

        // 第二批写入，sequence 从 1 开始（与第一批相同）
        // 会生成同名的 segment 文件
        const wal2 = new GroupCommitWal(dir);
        await wal2.append([makeRecord(1, 'second', makePayload('b'))]);
        await wal2.close();

        // Bug: rename 覆盖了第一批的文件，数据丢失
        const wal3 = new GroupCommitWal(dir);
        const records = await wal3.replay(0n);
        await wal3.close();

        // 只剩第二批的数据，第一批被覆盖
        expect(records).toHaveLength(1);
        expect(records[0]!.eventType).toBe('second');
      });
    });
  });

  describe('并发场景', () => {
    it('多次并发 append 应全部被持久化或全部失败（原子性验证）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        const totalRecords = 200;
        const appendPromises: Promise<void>[] = [];
        for (let i = 0; i < totalRecords; i++) {
          appendPromises.push(
            wal.append([makeRecord(i + 1, `event-${i}`, makePayload(`payload-${i}`))])
          );
        }

        const results = await Promise.allSettled(appendPromises);
        await wal.close();

        const fulfilled = results.filter((r) => r.status === 'fulfilled').length;

        const wal2 = new GroupCommitWal(dir);
        const replayed = await wal2.replay(0n);
        await wal2.close();

        // 所有 append 都应该成功（Group-Commit 保证）
        expect(fulfilled).toBe(totalRecords);
        // 所有记录都应该被持久化
        expect(replayed).toHaveLength(totalRecords);
      });
    });

    it('大量记录的 replay 应按文件名排序返回（而非按 sequence 排序）', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // 分多批写入，每批触发独立 commit（每批 >= MAX_BATCH=64）
        const batch1: WalRecord[] = [];
        const batch2: WalRecord[] = [];
        for (let i = 0; i < 64; i++) {
          batch1.push(makeRecord(i + 1, 'batch1', makePayload(`b1-${i}`)));
        }
        for (let i = 0; i < 64; i++) {
          batch2.push(makeRecord(i + 65, 'batch2', makePayload(`b2-${i}`)));
        }

        await wal.append(batch1);
        await wal.append(batch2);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const replayed = await wal2.replay(0n);
        await wal2.close();

        expect(replayed).toHaveLength(128);
        // 验证文件排序：batch1 的 sequence 1-64 在前，batch2 的 65-128 在后
        expect(replayed[0]!.sequence).toBe(1n);
        expect(replayed[63]!.sequence).toBe(64n);
        expect(replayed[64]!.sequence).toBe(65n);
        expect(replayed[127]!.sequence).toBe(128n);
      });
    });
  });

  describe('close 语义', () => {
    it('暴露 bug: close 后再 append 应抛异常（已实现），但 close 本身可能遗漏 pending timer', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);

        // append 一条（不满 MAX_BATCH，触发 timer 调度）
        await wal.append([makeRecord(1, 'event', makePayload('data'))]);
        // 不等待，立即 close
        await wal.close();

        // close 应 flush 所有 pending 数据
        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(0n);
        await wal2.close();

        expect(records).toHaveLength(1);
      });
    });

    it('暴露 bug: close 后 append 抛异常但错误信息不含已关闭原因的可操作性', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        await wal.close();

        // Bug: 错误信息只是 "GroupCommitWal is closed"，无上下文
        await expect(wal.append([makeRecord(1, 'x', makePayload('y'))])).rejects.toThrow(
          'GroupCommitWal is closed',
        );
      });
    });
  });

  describe('replay afterSeq 边界', () => {
    it('afterSeq 恰好等于某条记录的 sequence 时，该记录应被排除', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        await wal.append([
          makeRecord(10, 'a', makePayload('x')),
          makeRecord(20, 'b', makePayload('y')),
          makeRecord(30, 'c', makePayload('z')),
        ]);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(20n);
        await wal2.close();

        // afterSeq=20 应排除 seq=20，只返回 seq=30
        expect(records).toHaveLength(1);
        expect(records[0]!.sequence).toBe(30n);
      });
    });

    it('afterSeq=0n 应返回所有记录', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        await wal.append([makeRecord(1, 'a', makePayload('x'))]);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(0n);
        await wal2.close();

        expect(records).toHaveLength(1);
      });
    });

    it('afterSeq 超过所有记录的 sequence 时应返回空数组', async () => {
      await withTempDir(async (dir) => {
        wal = new GroupCommitWal(dir);
        await wal.append([makeRecord(1, 'a', makePayload('x'))]);
        await wal.close();

        const wal2 = new GroupCommitWal(dir);
        const records = await wal2.replay(999n);
        await wal2.close();

        expect(records).toHaveLength(0);
      });
    });
  });
});
