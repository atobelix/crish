import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CrashHandler } from './crash-handler';

describe('CrashHandler', () => {
  let tmpDir: string;
  let crashPath: string;
  let handler: CrashHandler | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crash-test-'));
    crashPath = join(tmpDir, 'crash.log');
  });

  afterEach(() => {
    // 确保即使测试失败也移除 process 监听，避免污染后续测试
    if (handler) {
      handler.uninstall();
      handler = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should buffer only error and fatal entries', () => {
    handler = new CrashHandler({ crashFilePath: crashPath });
    handler.onLog({ level: 'debug', msg: 'debug-msg', time: '1' });
    handler.onLog({ level: 'info', msg: 'info-msg', time: '2' });
    handler.onLog({ level: 'warn', msg: 'warn-msg', time: '3' });
    handler.onLog({ level: 'error', msg: 'error-msg', time: '4' });
    handler.onLog({ level: 'fatal', msg: 'fatal-msg', time: '5' });
    handler.flushSync();

    const content = readFileSync(crashPath, 'utf8');
    expect(content).toContain('error-msg');
    expect(content).toContain('fatal-msg');
    expect(content).not.toContain('debug-msg');
    expect(content).not.toContain('info-msg');
    expect(content).not.toContain('warn-msg');
  });

  it('should write buffered errors to crash file on flushSync', () => {
    handler = new CrashHandler({ crashFilePath: crashPath });
    handler.onLog({ level: 'error', msg: 'test error', time: '2024-01-01' });
    handler.flushSync();

    expect(existsSync(crashPath)).toBe(true);
    const content = readFileSync(crashPath, 'utf8');
    expect(content).toContain('test error');
    expect(content).toContain('2024-01-01');
  });

  it('should not write crash file when no error entries are buffered', () => {
    handler = new CrashHandler({ crashFilePath: crashPath });
    handler.onLog({ level: 'debug', msg: 'no-error', time: '1' });
    handler.onLog({ level: 'info', msg: 'no-error', time: '2' });
    handler.flushSync();

    // 无 error/fatal 条目时不应创建文件
    expect(existsSync(crashPath)).toBe(false);
  });

  it('should register and remove process listeners', () => {
    handler = new CrashHandler();
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeUnhandled = process.listenerCount('unhandledRejection');

    handler.install();

    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(
      beforeUnhandled + 1
    );

    handler.uninstall();

    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled);
  });

  it('should call traceManager.flushSync during flushSync', () => {
    let flushCalled = false;
    handler = new CrashHandler({
      crashFilePath: crashPath,
      traceManager: {
        flushSync(): void {
          flushCalled = true;
        },
      },
    });
    handler.onLog({ level: 'error', msg: 'boom', time: '1' });
    handler.flushSync();

    expect(flushCalled).toBe(true);
  });

  it('should respect maxErrorBuffer capacity by overwriting oldest', () => {
    handler = new CrashHandler({ crashFilePath: crashPath, maxErrorBuffer: 2 });
    handler.onLog({ level: 'error', msg: 'first', time: '1' });
    handler.onLog({ level: 'error', msg: 'second', time: '2' });
    handler.onLog({ level: 'error', msg: 'third', time: '3' });
    handler.flushSync();

    const content = readFileSync(crashPath, 'utf8');
    // 容量为 2，第三条覆盖第一条
    expect(content).toContain('second');
    expect(content).toContain('third');
    expect(content).not.toContain('first');
  });
});
