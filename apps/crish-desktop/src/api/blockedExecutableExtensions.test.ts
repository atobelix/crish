// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXECUTABLE_EXTENSIONS,
  extensionOfPath,
  isBlockedExecutablePath,
} from './blockedExecutableExtensions';

describe('blockedExecutableExtensions SSOT', () => {
  it('list stable', () => {
    expect([...BLOCKED_EXECUTABLE_EXTENSIONS]).toEqual([
      'exe',
      'bat',
      'cmd',
      'msi',
      'ps1',
      'vbs',
      'com',
      'sh',
      'bin',
    ]);
  });

  it('path detection', () => {
    expect(isBlockedExecutablePath('C:\\tmp\\run.exe')).toBe(true);
    expect(isBlockedExecutablePath('/tmp/run.sh')).toBe(true);
    expect(isBlockedExecutablePath('scripts/setup.ps1:12')).toBe(true);
    expect(isBlockedExecutablePath('readme.md')).toBe(false);
    expect(isBlockedExecutablePath('archive.tar.gz')).toBe(false);
    expect(extensionOfPath('a.b.CMD')).toBe('cmd');
  });
});

describe('openPathDefault uses SSOT', () => {
  it('blocks executable before IPC', async () => {
    const { openPathDefault } = await import('./hostOpenersApi');
    await expect(openPathDefault('C:\\tmp\\run.exe')).rejects.toThrow(
      /禁止直接运行可执行文件/
    );
  });
});
