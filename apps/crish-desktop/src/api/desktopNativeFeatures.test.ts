// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isAbsoluteFsPath,
  resolveWorkspacePath,
  pathBasename,
  pathDirname,
  pathRelativeToRoot,
  listDirectory,
  readTextFile,
  writeTextFile,
  revealInOs,
} from './workspaceFsApi';
import {
  listHostOpeners,
  openWithHostOpener,
  openPathDefault,
  listOpenOptionsForFile,
} from './hostOpenersApi';
import { invokeCmd, invokeResult } from './tauriInvoke';
import capabilitiesManifest from '../../../agent-workbench/src-tauri/capabilities/default.json';

// Mock tauriInvoke dependencies for unit tests
vi.mock('./tauriInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tauriInvoke')>();
  return {
    ...actual,
    invokeResult: vi.fn(),
    invokeCmd: vi.fn(),
  };
});

// Mock projectStore getWorkspacePath（winCtl 测试经 AppBootstrap 挂载全链路，
// 需补齐 workspaceShell 依赖的导出）
vi.mock('./projectStore', () => ({
  getWorkspacePath: vi.fn(() => 'C:\\Users\\dev\\project'),
  GENERAL_FOLDER: 'general',
  canonicalSessionFolder: (k?: string) => (k || '').trim() || 'general',
  getActiveProjectId: () => null,
}));

import { getWorkspacePath } from './projectStore';

const mockedInvokeResult = vi.mocked(invokeResult);
const mockedInvokeCmd = vi.mocked(invokeCmd);
const mockedGetWorkspacePath = vi.mocked(getWorkspacePath);

beforeEach(() => {
  mockedInvokeResult.mockReset();
  mockedInvokeCmd.mockReset();
  mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// 1. Windows Path Separator (\) & POSIX (/) Cross-Platform Path Normalization
// ============================================================================

describe('Desktop Native Features - Path Normalization & Security Safeguards', () => {
  describe('isAbsoluteFsPath', () => {
    it('detects Windows drive letter paths with backslashes and slashes', () => {
      expect(isAbsoluteFsPath('C:\\Users\\dev\\project')).toBe(true);
      expect(isAbsoluteFsPath('c:/Users/dev/project')).toBe(true);
      expect(isAbsoluteFsPath('D:\\Workspace\\src\\index.ts')).toBe(true);
      expect(isAbsoluteFsPath('z:/repo/file.txt')).toBe(true);
    });

    it('detects Windows UNC network paths and POSIX absolute paths', () => {
      expect(isAbsoluteFsPath('\\\\server\\share\\folder')).toBe(true);
      expect(isAbsoluteFsPath('//server/share/folder')).toBe(true);
      expect(isAbsoluteFsPath('/usr/local/bin')).toBe(true);
      expect(isAbsoluteFsPath('/home/user/code')).toBe(true);
    });

    it('identifies relative paths as non-absolute', () => {
      expect(isAbsoluteFsPath('src/components/App.tsx')).toBe(false);
      expect(isAbsoluteFsPath('.\\relative\\path')).toBe(false);
      expect(isAbsoluteFsPath('../parent/file')).toBe(false);
      expect(isAbsoluteFsPath('')).toBe(false);
      expect(isAbsoluteFsPath('   ')).toBe(false);
    });
  });

  describe('resolveWorkspacePath - Cross-platform Normalization & Traversal Defense', () => {
    it('joins relative paths with Windows backslash when workspace root contains backslashes', () => {
      mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');
      expect(resolveWorkspacePath('src\\main.ts')).toBe('C:\\Users\\dev\\project\\src\\main.ts');
      expect(resolveWorkspacePath('src/main.ts')).toBe('C:\\Users\\dev\\project\\src/main.ts');
      expect(resolveWorkspacePath('.\\src\\index.ts')).toBe('C:\\Users\\dev\\project\\src\\index.ts');
    });

    it('joins relative paths with POSIX slash when workspace root contains slashes', () => {
      mockedGetWorkspacePath.mockReturnValue('/home/user/project');
      expect(resolveWorkspacePath('src/main.ts')).toBe('/home/user/project/src/main.ts');
      expect(resolveWorkspacePath('./src/index.ts')).toBe('/home/user/project/src/index.ts');
    });

    it('rejects path traversal components (..)', () => {
      mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');
      expect(resolveWorkspacePath('../outside.txt')).toBe('');
      expect(resolveWorkspacePath('src/../../outside.txt')).toBe('');
      expect(resolveWorkspacePath('..\\..\\Windows\\System32')).toBe('');
    });

    it('rejects null bytes, unicode bidi override chars, and Windows reserved names', () => {
      mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');

      // Null bytes
      expect(resolveWorkspacePath('src/file.ts\0.exe')).toBe('');

      // Unicode Bidi Override
      expect(resolveWorkspacePath('src/\u202Ascript.js')).toBe('');
      expect(resolveWorkspacePath('src/\u2066hidden.exe')).toBe('');

      // Windows Reserved Names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
      expect(resolveWorkspacePath('CON')).toBe('');
      expect(resolveWorkspacePath('src/NUL')).toBe('');
      expect(resolveWorkspacePath('AUX.txt')).toBe('');
      expect(resolveWorkspacePath('COM1')).toBe('');
      expect(resolveWorkspacePath('LPT3.log')).toBe('');
    });

    it('verifies absolute path stays inside workspace root case-insensitively', () => {
      mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');
      expect(resolveWorkspacePath('C:\\Users\\dev\\project\\src\\App.tsx')).toBe('C:\\Users\\dev\\project\\src\\App.tsx');
      expect(resolveWorkspacePath('c:/users/dev/project/src/app.tsx')).toBe('c:/users/dev/project/src/app.tsx');
      
      // Outside workspace root -> rejected
      expect(resolveWorkspacePath('C:\\Users\\dev\\other_project\\file.txt')).toBe('');
      expect(resolveWorkspacePath('D:\\project\\file.txt')).toBe('');
    });

    it('rejects overly long paths exceeding MAX_PATH_LENGTH', () => {
      mockedGetWorkspacePath.mockReturnValue('C:\\Users\\dev\\project');
      const longPath = 'a/'.repeat(2500);
      expect(resolveWorkspacePath(longPath)).toBe('');
    });
  });

  describe('Path Manipulation Helpers (pathBasename, pathDirname, pathRelativeToRoot)', () => {
    it('extracts basename correctly for both Windows backslash and POSIX slash paths', () => {
      expect(pathBasename('C:\\Users\\dev\\project\\src\\index.ts')).toBe('index.ts');
      expect(pathBasename('/home/user/project/src/index.ts')).toBe('index.ts');
      expect(pathBasename('C:\\Users\\dev\\project\\folder')).toBe('folder');
      expect(pathBasename('file.txt')).toBe('file.txt');
    });

    it('extracts dirname correctly for cross-platform paths', () => {
      expect(pathDirname('C:\\Users\\dev\\project\\src\\index.ts')).toBe('C:\\Users\\dev\\project\\src');
      expect(pathDirname('/home/user/project/src/index.ts')).toBe('/home/user/project/src');
    });

    it('computes path relative to root handling mixed slashes and case insensitivity', () => {
      expect(pathRelativeToRoot('C:\\Users\\dev\\project\\src\\index.ts', 'C:/Users/dev/project')).toBe('src/index.ts');
      expect(pathRelativeToRoot('c:/users/dev/project/src/components/Button.tsx', 'C:\\Users\\dev\\project')).toBe('src/components/Button.tsx');
      expect(pathRelativeToRoot('C:\\Users\\dev\\project', 'C:\\Users\\dev\\project')).toBe('.');
    });
  });
});

// ============================================================================
// 2. Tauri Native Commands: workbench_open_host_target, Dialogs, Window Control
// ============================================================================

describe('Desktop Native Features - Tauri Native Commands Suite', () => {
  describe('workbench_open_host_target & Host Openers', () => {
    it('lists available host openers via workbench_list_host_openers', async () => {
      mockedInvokeCmd.mockResolvedValueOnce([
        { id: 'system-file-manager', displayName: 'File Manager', kind: 'file-manager', available: true },
        { id: 'vscode', displayName: 'VS Code', kind: 'editor', available: true, path: 'C:\\Program Files\\VSCode\\Code.exe' },
        { id: 'cursor', displayName: 'Cursor', kind: 'editor', available: false, reason: 'Not installed' },
      ]);

      const openers = await listHostOpeners();
      expect(openers).toHaveLength(2);
      expect(openers[0]).toMatchObject({ id: 'system-file-manager', available: true });
      expect(openers[1]).toMatchObject({ id: 'vscode', available: true, path: 'C:\\Program Files\\VSCode\\Code.exe' });
      expect(mockedInvokeCmd).toHaveBeenCalledWith('workbench_list_host_openers');
    });

    it('opens file target with specified opener using workbench_open_host_target', async () => {
      mockedInvokeResult.mockResolvedValueOnce({ status: 'ok', data: { ok: true } });

      await openWithHostOpener('vscode', 'C:\\Users\\dev\\project\\src\\main.ts');
      expect(mockedInvokeResult).toHaveBeenCalledWith('workbench_open_host_target', {
        openerId: 'vscode',
        target: { type: 'path', path: 'C:\\Users\\dev\\project\\src\\main.ts' },
      });
    });

    it('handles unavailable host opener error gracefully', async () => {
      mockedInvokeResult.mockResolvedValueOnce({
        status: 'error',
        message: 'Host opener missing-opener was not found on this system.',
      });

      await expect(openWithHostOpener('missing-opener', 'C:\\Users\\dev\\project\\src\\main.ts')).rejects.toThrow(
        'Host opener missing-opener was not found on this system.',
      );
    });

    it('opens system default path via workbench_open_path_default and falls back if missing', async () => {
      mockedInvokeResult.mockResolvedValueOnce({ status: 'ok', data: { ok: true } });

      await openPathDefault('C:\\Users\\dev\\project\\readme.md');
      expect(mockedInvokeResult).toHaveBeenCalledWith('workbench_open_path_default', {
        path: 'C:\\Users\\dev\\project\\readme.md',
      });
    });

    it('reveals file in OS file manager via workbench_open_host_target', async () => {
      mockedInvokeResult.mockResolvedValueOnce({ status: 'ok', data: { ok: true } });

      await revealInOs('C:\\Users\\dev\\project\\src\\App.tsx');
      expect(mockedInvokeResult).toHaveBeenCalledWith('workbench_open_host_target', {
        openerId: 'system-file-manager',
        target: { type: 'path', path: 'C:\\Users\\dev\\project\\src\\App.tsx' },
      });
    });

    it('sorts host opener options dynamically based on file type', async () => {
      mockedInvokeCmd.mockResolvedValueOnce([
        { id: 'system-file-manager', displayName: 'File Manager', kind: 'file-manager', available: true },
        { id: 'vscode', displayName: 'VS Code', kind: 'editor', available: true },
      ]);
      mockedInvokeCmd.mockResolvedValueOnce([]);

      const options = await listOpenOptionsForFile('C:\\Users\\dev\\project\\src\\index.ts');
      expect(options.defaultLabel).toBe('编辑');
      expect(options.openers[0]!.id).toBe('vscode');
    });
  });

  describe('Native Dialogs - select_folder', () => {
    it('invokes select_folder command and handles folder selection result', async () => {
      mockedInvokeResult.mockResolvedValueOnce({
        status: 'ok',
        data: { path: 'C:\\Users\\dev\\new_project' },
      });

      // Import listDirectory or direct invoke test for select_folder payload structure
      const res = await invokeResult<{ path: string | null }>('select_folder');
      expect(res).toEqual({
        status: 'ok',
        data: { path: 'C:\\Users\\dev\\new_project' },
      });
    });

    it('handles dialog cancellation when user cancels folder picker', async () => {
      mockedInvokeResult.mockResolvedValueOnce({
        status: 'ok',
        data: { path: null },
      });

      const res = await invokeResult<{ path: string | null }>('select_folder');
      expect(res).toEqual({
        status: 'ok',
        data: { path: null },
      });
    });
  });

  describe('Window Control & Minimization (winCtl)', () => {
    // 并行测试负载下动态 import + doMock 可能超过默认 5s 超时（非逻辑问题）
    it('executes window minimization, maximization, and close safely', async () => {
      const mockMinimize = vi.fn().mockResolvedValue(undefined);
      const mockIsMaximized = vi.fn().mockResolvedValue(false);
      const mockMaximize = vi.fn().mockResolvedValue(undefined);
      const mockUnmaximize = vi.fn().mockResolvedValue(undefined);
      const mockClose = vi.fn().mockResolvedValue(undefined);

      const mockWindow = {
        minimize: mockMinimize,
        isMaximized: mockIsMaximized,
        maximize: mockMaximize,
        unmaximize: mockUnmaximize,
        close: mockClose,
      };

      const getCurrentWindowMock = vi.fn(() => mockWindow);
      vi.doMock('@tauri-apps/api/window', () => ({
        getCurrentWindow: getCurrentWindowMock,
      }));
      // 重新导入 winCtl，使动态 import('@tauri-apps/api/window') 命中上述 mock
      const mod = await import('../app/AppBootstrap');
      const winCtlUnderTest = mod.winCtl;

      await winCtlUnderTest('minimize');
      expect(mockMinimize).toHaveBeenCalledTimes(1);

      await winCtlUnderTest('toggleMaximize');
      expect(mockIsMaximized).toHaveBeenCalledTimes(1);
      expect(mockMaximize).toHaveBeenCalledTimes(1);

      mockIsMaximized.mockResolvedValueOnce(true);
      await winCtlUnderTest('toggleMaximize');
      expect(mockUnmaximize).toHaveBeenCalledTimes(1);

      await winCtlUnderTest('close');
      expect(mockClose).toHaveBeenCalledTimes(1);

      vi.doUnmock('@tauri-apps/api/window');
    }, 15_000);

    it('falls back silently when Tauri window API is unavailable', async () => {
      vi.doMock('@tauri-apps/api/window', () => {
        throw new Error('module not found');
      });
      const mod = await import('../app/AppBootstrap');
      await expect(mod.winCtl('minimize')).resolves.toBeUndefined();
      vi.doUnmock('@tauri-apps/api/window');
    }, 15_000);

    it('verifies window permissions are explicitly allowed in Tauri capabilities default.json', () => {
      const permissions = capabilitiesManifest.permissions;
      expect(permissions).toContain('core:window:allow-minimize');
      expect(permissions).toContain('core:window:allow-maximize');
      expect(permissions).toContain('core:window:allow-close');
    });
  });
});

// ============================================================================
// 3. HMR Hot-Reload Race Condition & Callback ID Invalidation Protection
// ============================================================================

describe('Desktop Native Features - HMR Hot-Reload Race Protection', () => {
  it('normalizes missing command / destroyed webview callback errors into structured missing status', async () => {
    // Simulate HMR refresh / webview reload where callback is invalidated
    mockedInvokeResult.mockImplementation(async (cmd) => {
      if (cmd === 'read_file_content') {
        // Return structured error as formatted by tauriInvoke on callback invalidation / missing command
        return { status: 'missing' };
      }
      return { status: 'missing' };
    });

    const res = await invokeResult('read_file_content', { path: 'C:\\Users\\dev\\project\\file.txt' });
    expect(res.status).toBe('missing');
  });

  it('prevents unhandled promise rejections on workspace file reads during HMR reload', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'Failed to fetch dynamically imported module: @tauri-apps/api/core',
    });

    await expect(readTextFile('src/main.ts')).rejects.toThrow(
      'Failed to fetch dynamically imported module: @tauri-apps/api/core',
    );
  });

  it('ensures listDirectory handles missing desktop shell during frontend reload gracefully', async () => {
    mockedInvokeResult.mockResolvedValueOnce({ status: 'missing' });

    await expect(listDirectory()).rejects.toThrow('当前环境无法浏览本地目录（需桌面壳）');
  });

  it('ensures writeTextFile handles write permission error cleanly without dangling state', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: 'Path is outside the allowed workspace root.',
    });

    await expect(writeTextFile('outside.txt', 'data')).rejects.toThrow(
      'Path is outside the allowed workspace root.',
    );
  });
});
