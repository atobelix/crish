/**
 * F8-03 / F8-44 对抗性测试：JsonlAppendBatcher 写失败必须显式暴露，
 * 禁止静默 resolve 吞数据（pending 在写前已清空，写失败即数据永久丢失）。
 *
 * 注入方式：mock node:fs/promises 的 open/stat/readFile，让写路径在
 * 受控点失败（对齐 F8-44：注入 ENOENT 断言 flush 拒绝而非静默成功）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  open: mocks.open,
  readFile: mocks.readFile,
  stat: mocks.stat,
}));

import { JsonlAppendBatcher } from './jsonl-append-batcher';

function errWithCode(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function fakeHandle(writeFile: (data: string, encoding: string) => Promise<void>) {
  return {
    writeFile: vi.fn(writeFile),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBatcher(filePath: string): JsonlAppendBatcher {
  return new JsonlAppendBatcher({
    filePath,
    // 关闭自动 flush：全部由手动 flush() 驱动，便于断言错误暴露
    flushIntervalMs: 10000,
    flushCount: 100,
    fsyncOnFlush: false,
    fsyncDirectoryOnFlush: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stat.mockRejectedValue(errWithCode('ENOENT')); // 首次写入：文件尚不存在
  mocks.readFile.mockResolvedValue(Buffer.alloc(0));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('JsonlAppendBatcher 写失败显式暴露（F8-03 / F8-44）', () => {
  it('flush 遇 ENOENT 必须拒绝而非静默成功（红：当前静默 resolve 吞数据）', async () => {
    const filePath = join('virtual', 'log.jsonl');
    mocks.open.mockImplementation(() =>
      Promise.resolve(
        fakeHandle(() => Promise.reject(errWithCode('ENOENT')))
      )
    );
    const batcher = makeBatcher(filePath);
    await batcher.append('critical-data');
    await expect(batcher.flush()).rejects.toThrow();
    await batcher.close().catch(() => undefined);
  });

  it('写失败后重建句柄重试一次；重试成功不抛且句柄重建（修复路径）', async () => {
    const filePath = join('virtual', 'log.jsonl');
    let writeCalls = 0;
    mocks.open.mockImplementation(() =>
      Promise.resolve(
        fakeHandle(() => {
          writeCalls += 1;
          return writeCalls === 1
            ? Promise.reject(errWithCode('EBADF'))
            : Promise.resolve();
        })
      )
    );
    const batcher = makeBatcher(filePath);
    await batcher.append('data');
    await expect(batcher.flush()).resolves.toBeUndefined();
    // 句柄重建 = open 被调用两次
    expect(mocks.open).toHaveBeenCalledTimes(2);
    await batcher.close().catch(() => undefined);
  });

  it('重试仍失败（目录被删）→ flush 拒绝，数据不静默丢失', async () => {
    const filePath = join('virtual', 'log.jsonl');
    let openCalls = 0;
    mocks.open.mockImplementation(() => {
      openCalls += 1;
      if (openCalls === 1) {
        return Promise.resolve(
          fakeHandle(() => Promise.reject(errWithCode('ENOENT')))
        );
      }
      return Promise.reject(errWithCode('ENOENT'));
    });
    const batcher = makeBatcher(filePath);
    await batcher.append('data');
    await expect(batcher.flush()).rejects.toThrow();
    await batcher.close().catch(() => undefined);
  });
});
