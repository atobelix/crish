/**
 * browserImportApi invoke 桥测试（G-4 收尾 U6）：命令名 / 参数形状 / 三态错误路径 /
 * 路径读取降级。invoke 走 test-setup 全局 mock（@tauri-apps/api/core）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import {
  BROWSER_IMPORT_BOOKMARKS_CMD,
  BROWSER_IMPORT_HISTORY_CMD,
  BROWSER_IMPORT_STORAGE_STATE_CMD,
  BROWSER_EXPORT_STORAGE_STATE_CMD,
  BROWSER_LIST_BOOKMARKS_CMD,
  BROWSER_LIST_HISTORY_CMD,
  exportStorageState,
  importBookmarks,
  importHistory,
  importStorageState,
  listBookmarks,
  listHistory,
  readTextFileAtPath,
} from './browserImportApi';

afterEach(() => {
  vi.clearAllMocks();
});

describe('importBookmarks', () => {
  it('成功：调用 browser_import_bookmarks 且透传 json 内容，返回 camelCase 统计', async () => {
    const impl = vi.fn(async () => ({
      inserted: 3,
      skippedDupes: 1,
      parsedItems: 4,
      skippedInvalid: 0,
      depthCutoff: 0,
      droppedDupes: 0,
      truncated: 0,
    }));
    mockTauriCommand(BROWSER_IMPORT_BOOKMARKS_CMD, impl);
    const res = await importBookmarks('{"roots":{}}');
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith({ json: '{"roots":{}}' });
    expect(res).toEqual({
      status: 'ok',
      data: {
        inserted: 3,
        skippedDupes: 1,
        parsedItems: 4,
        skippedInvalid: 0,
        depthCutoff: 0,
        droppedDupes: 0,
        truncated: 0,
      },
    });
  });

  it('非法 JSON（tool.invalid_input）→ error 三态携带结构化 message', async () => {
    mockTauriError(
      BROWSER_IMPORT_BOOKMARKS_CMD,
      new Error('tool.invalid_input: JSON 解析失败')
    );
    const res = await importBookmarks('{ not json');
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.message).toContain('tool.invalid_input');
    }
  });

  it('命令未接线 → missing 三态', async () => {
    const res = await importBookmarks('{}');
    expect(res.status).toBe('missing');
  });
});

describe('importHistory', () => {
  it('成功：调用 browser_import_history 且透传 path', async () => {
    const impl = vi.fn(async () => ({
      inserted: 7,
      skippedDupes: 2,
      readTotal: 10,
      skippedInvalidUrl: 1,
    }));
    mockTauriCommand(BROWSER_IMPORT_HISTORY_CMD, impl);
    const res = await importHistory('C:\\History');
    expect(impl).toHaveBeenCalledWith({ path: 'C:\\History' });
    expect(res).toEqual({
      status: 'ok',
      data: {
        inserted: 7,
        skippedDupes: 2,
        readTotal: 10,
        skippedInvalidUrl: 1,
      },
    });
  });

  it('库缺失（tool.invalid_input）→ error 三态', async () => {
    mockTauriError(
      BROWSER_IMPORT_HISTORY_CMD,
      new Error('tool.invalid_input: 库不存在')
    );
    const res = await importHistory('missing');
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('库不存在');
  });
});

describe('listBookmarks / listHistory', () => {
  it('listBookmarks 成功：返回 snake_case 行字段（folder_path/imported_at）', async () => {
    const impl = vi.fn(async () => [
      {
        url: 'https://a.example',
        name: 'A',
        folder_path: ['书签栏', '工作'],
        guid: null,
        source: 'manual/bookmarks',
        imported_at: 1750000000,
      },
    ]);
    mockTauriCommand(BROWSER_LIST_BOOKMARKS_CMD, impl);
    const res = await listBookmarks();
    expect(res).toEqual({
      status: 'ok',
      data: [
        {
          url: 'https://a.example',
          name: 'A',
          folder_path: ['书签栏', '工作'],
          guid: null,
          source: 'manual/bookmarks',
          imported_at: 1750000000,
        },
      ],
    });
  });

  it('listHistory：显式 since/limit 透传；缺省不携带参数', async () => {
    const withArgs = vi.fn(async () => []);
    mockTauriCommand(BROWSER_LIST_HISTORY_CMD, withArgs);
    await listHistory(1750000000, 20);
    expect(withArgs).toHaveBeenCalledWith({ since: 1750000000, limit: 20 });

    const noArgs = vi.fn(async () => []);
    mockTauriCommand(BROWSER_LIST_HISTORY_CMD, noArgs);
    await listHistory();
    expect(noArgs).toHaveBeenCalledWith({});
  });
});

describe('exportStorageState / importStorageState', () => {
  it('导出成功：authorized=true 透传，返回 storage_state JSON 字符串', async () => {
    const impl = vi.fn(async () => '{"cookies":[],"origins":[]}');
    mockTauriCommand(BROWSER_EXPORT_STORAGE_STATE_CMD, impl);
    const res = await exportStorageState(true);
    expect(impl).toHaveBeenCalledWith({ authorized: true });
    expect(res).toEqual({ status: 'ok', data: '{"cookies":[],"origins":[]}' });
  });

  it('导出未授权（authorized=false）→ error 三态（拒绝文案）', async () => {
    mockTauriError(
      BROWSER_EXPORT_STORAGE_STATE_CMD,
      new Error('storage_state 导出未获显式授权')
    );
    const res = await exportStorageState(false);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('未获显式授权');
  });

  it('导入成功：json 透传，返回脱敏统计载荷', async () => {
    const impl = vi.fn(async () => ({
      cookies: 3,
      origins: 1,
      localStorageItems: 2,
      injectedScripts: 1,
      injectedItems: 2,
      droppedDupes: 1,
      skippedEmptyName: 1,
    }));
    mockTauriCommand(BROWSER_IMPORT_STORAGE_STATE_CMD, impl);
    const res = await importStorageState('{"cookies":[]}');
    expect(impl).toHaveBeenCalledWith({ json: '{"cookies":[]}' });
    expect(res).toEqual({
      status: 'ok',
      data: {
        cookies: 3,
        origins: 1,
        localStorageItems: 2,
        injectedScripts: 1,
        injectedItems: 2,
        droppedDupes: 1,
        skippedEmptyName: 1,
      },
    });
  });

  it('登录态导入未连接（tool.browser.not_ready）→ error 携带码前缀', async () => {
    mockTauriError(
      BROWSER_IMPORT_STORAGE_STATE_CMD,
      new Error('tool.browser.not_ready: 浏览器未启动')
    );
    const res = await importStorageState('{}');
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toContain('not_ready');
  });
});

describe('readTextFileAtPath', () => {
  it('plugin-fs 不可用（非 Tauri / stub）→ 返回 null（调用方降级提示）', async () => {
    const text = await readTextFileAtPath('C:\\Bookmarks');
    expect(text).toBeNull();
  });
});
