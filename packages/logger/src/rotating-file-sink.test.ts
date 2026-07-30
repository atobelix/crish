import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RotatingFileSink,
  renameWithWindowsRetrySync,
} from './rotating-file-sink';
import type { LogEntry } from './logger';
import { CrishError } from '@crish/shared-types';

function makeEntry(msg: string, level: LogEntry['level'] = 'info'): LogEntry {
  return {
    level,
    time: new Date().toISOString(),
    msg,
    module: 'test',
  };
}

function makeEpermError(): NodeJS.ErrnoException {
  const err = new Error(
    'EPERM: operation not permitted'
  ) as NodeJS.ErrnoException;
  err.code = 'EPERM';
  return err;
}

function makeEbusyError(): NodeJS.ErrnoException {
  const err = new Error('EBUSY: resource busy') as NodeJS.ErrnoException;
  err.code = 'EBUSY';
  return err;
}

describe('RotatingFileSink', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rfs-test-'));
    logPath = join(dir, 'app.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写入日志到主文件', () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 10000 });
    sink.write(makeEntry('hello-world'));
    // appendFileSync 同步落盘，可直接读取
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('hello-world');
    expect(content).toContain('"level":"info"');
  });

  it('超过 maxSize 时触发轮转生成 .1 文件', () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 50 });
    // 单条 JSON 行约 80+ 字节，超过 maxSize=50，写入后立即触发轮转
    sink.write(makeEntry('trigger-rotation-message'));

    // .1 文件应存在（旧文件被重命名）
    expect(existsSync(`${logPath}.1`)).toBe(true);
    // .1 文件应包含原始日志内容
    const rotatedContent = readFileSync(`${logPath}.1`, 'utf-8');
    expect(rotatedContent).toContain('trigger-rotation-message');
  });

  it('maxFiles 上限时最旧文件被删除', () => {
    const sink = new RotatingFileSink({
      filePath: logPath,
      maxSize: 50,
      maxFiles: 3,
    });
    // 写入多条触发多次轮转，产生 .1 .2 .3 但不应有 .4
    for (let i = 0; i < 6; i++) {
      sink.write(makeEntry(`rotation-message-${i}`));
    }

    // maxFiles=3 → 保留 .1 .2 .3，不应有 .4
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(true);
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  it('flushSync 将 RingBuffer 内容写入 .crash 文件', () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 100000 });
    sink.write(makeEntry('crash-entry-1'));
    sink.write(makeEntry('crash-entry-2'));
    sink.write(makeEntry('crash-entry-3'));

    // flushSync 应将 ring buffer 中的日志行写入 .crash 文件
    sink.flushSync();

    const crashPath = `${logPath}.crash`;
    expect(existsSync(crashPath)).toBe(true);
    const crashContent = readFileSync(crashPath, 'utf-8');
    expect(crashContent).toContain('crash-entry-1');
    expect(crashContent).toContain('crash-entry-2');
    expect(crashContent).toContain('crash-entry-3');
  });

  it('RingBuffer 容量为 50，超出后仅保留最近 50 条', () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 1000000 });
    // 写入 60 条日志
    for (let i = 0; i < 60; i++) {
      sink.write(makeEntry(`entry-${i}`));
    }
    sink.flushSync();

    const crashPath = `${logPath}.crash`;
    const crashContent = readFileSync(crashPath, 'utf-8');
    // 最近 50 条应存在（entry-10 到 entry-59）
    expect(crashContent).toContain('entry-10');
    expect(crashContent).toContain('entry-59');
    // 最早的 10 条应被覆盖
    expect(crashContent).not.toContain('entry-0');
    expect(crashContent).not.toContain('entry-9');
  });

  it('asTransport 返回函数式 transport 委托到 write', () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 10000 });
    const transport = sink.asTransport();
    transport(makeEntry('via-transport'));
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('via-transport');
  });

  it('flush 立即 resolve（appendFileSync 已同步落盘）', async () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 10000 });
    sink.write(makeEntry('test'));
    // 不应挂起
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('close 后 write 被忽略', async () => {
    const sink = new RotatingFileSink({ filePath: logPath, maxSize: 10000 });
    sink.write(makeEntry('before-close'));
    await sink.close();
    sink.write(makeEntry('after-close'));
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('before-close');
    expect(content).not.toContain('after-close');
  });

  it('构造时从已有文件恢复 currentSize', () => {
    // 先写入一些内容到文件
    const sink1 = new RotatingFileSink({ filePath: logPath, maxSize: 10000 });
    sink1.write(makeEntry('existing-content'));

    // 用相同路径创建新 sink，currentSize 应从文件大小恢复
    const sink2 = new RotatingFileSink({ filePath: logPath, maxSize: 100 });
    // currentSize 已 > 100（从已有文件恢复），下次 write 应触发轮转
    sink2.write(makeEntry('trigger-rotation'));
    expect(existsSync(`${logPath}.1`)).toBe(true);
    const rotated = readFileSync(`${logPath}.1`, 'utf-8');
    expect(rotated).toContain('existing-content');
  });
});

describe('renameWithWindowsRetrySync', () => {
  it('首次成功时不重试', () => {
    const renameImpl = vi.fn();
    renameWithWindowsRetrySync('src', 'dest', {
      renameImpl,
      sleepImpl: () => {},
    });
    expect(renameImpl).toHaveBeenCalledTimes(1);
  });

  it('EPERM 错误时指数退避重试后成功', () => {
    const renameImpl = vi.fn();
    renameImpl
      .mockImplementationOnce(() => {
        throw makeEpermError();
      })
      .mockImplementationOnce(() => {
        throw makeEbusyError();
      })
      .mockImplementationOnce(() => undefined); // 第三次成功

    renameWithWindowsRetrySync('src', 'dest', {
      maxRetries: 5,
      renameImpl,
      sleepImpl: () => {},
    });

    expect(renameImpl).toHaveBeenCalledTimes(3);
  });

  it('非 EPERM/EBUSY 错误立即抛出不重试', () => {
    const renameImpl = vi.fn(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    expect(() =>
      renameWithWindowsRetrySync('src', 'dest', {
        renameImpl,
        sleepImpl: () => {},
      })
    ).toThrow('ENOENT');

    expect(renameImpl).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽后抛出 CrishError', () => {
    const renameImpl = vi.fn(() => {
      throw makeEpermError();
    });

    let thrown: unknown;
    try {
      renameWithWindowsRetrySync('src', 'dest', {
        maxRetries: 3,
        renameImpl,
        sleepImpl: () => {},
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CrishError);
    const crishErr = thrown as CrishError;
    expect(crishErr.message).toContain('rename failed after 3 retries');
    expect(crishErr.code).toBe('common.unknown');
    expect(crishErr.category).toBe('permanent');
    expect(crishErr.retryable).toBe(false);
    expect(renameImpl).toHaveBeenCalledTimes(3);
  });

  it('CrishError 的 metadata 记录原始错误信息', () => {
    const renameImpl = vi.fn(() => {
      throw makeEbusyError();
    });

    let thrown: unknown;
    try {
      renameWithWindowsRetrySync('/path/a', '/path/b', {
        maxRetries: 2,
        renameImpl,
        sleepImpl: () => {},
      });
    } catch (err) {
      thrown = err;
    }

    const crishErr = thrown as CrishError;
    expect(crishErr.metadata).toMatchObject({
      from: '/path/a',
      to: '/path/b',
      retries: 2,
      originalError: 'EBUSY: resource busy',
    });
  });
});
