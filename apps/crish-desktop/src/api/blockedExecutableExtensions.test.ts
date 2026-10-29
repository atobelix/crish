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
      'scr',
      'pif',
      'hta',
      'jse',
      'vbe',
      'wsf',
      'wsh',
      'msc',
      'jar',
      'lnk',
      'reg',
      'url',
      'cpl',
      'msix',
      'appx',
      'docm',
      'xlsm',
      'pptm',
      'xll',
      'xlam',
      'inf',
      'scf',
      'settingcontent-ms',
      'appref-ms',
    ]);
  });

  it('path detection', () => {
    expect(isBlockedExecutablePath('C:\\tmp\\run.exe')).toBe(true);
    expect(isBlockedExecutablePath('/tmp/run.sh')).toBe(true);
    expect(isBlockedExecutablePath('scripts/setup.ps1:12')).toBe(true);
    // Windows 可执行变体（E1）
    expect(isBlockedExecutablePath('C:\\tmp\\setup.scr')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\proxy.pif')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\page.hta')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\drop.jse')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\drop.vbe')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\wrap.wsf')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\wrap.wsh')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\console.msc')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\lib.jar')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\setup.SCR')).toBe(true);
    // 2026-10 Markdown 2.0：Windows 高危载体
    expect(isBlockedExecutablePath('C:\\tmp\\shortcut.lnk')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\import.reg')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\site.url')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\macro.docm')).toBe(true);
    expect(isBlockedExecutablePath('C:\\tmp\\installer.msix')).toBe(true);
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
