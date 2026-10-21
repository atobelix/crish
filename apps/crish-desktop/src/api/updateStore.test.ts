// @vitest-environment jsdom
/**
 * updateStore 真实更新链路测试（RUN-03/GAP-01）。
 *
 * 锚点：
 * - `checkForUpdate` 是 `setUpdateAvailable` 的唯一真实写入点（后端检查返回值驱动）；
 * - `applyUpdateWhenIdle` 失败路径（断网/签名不符）必须透出可见错误，
 *   严禁吞错后清标记假成功（R-21/R-15 反作弊锚点）；
 * - 无更新时如实 `{ok:false}`，不误报。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./tauriInvoke', () => ({
  invokeResult: vi.fn(),
  invokeTyped: vi.fn(),
}));

import { invokeResult, invokeTyped } from './tauriInvoke';
import {
  applyUpdateWhenIdle,
  checkForUpdate,
  isUpdateAvailable,
} from './updateStore';

const mockedInvokeResult = vi.mocked(invokeResult);
// listBackgroundTasks 走 invokeTyped（backgroundTaskClient.ts），探测后台任务时消费它
const mockedInvokeTyped = vi.mocked(invokeTyped);

/** 订阅 crish-update-changed 事件（setUpdateAvailable 广播面） */
function onUpdateChanged(
  listener: (detail: { available: boolean }) => void
): () => void {
  const handler = (ev: Event): void => {
    const custom = ev as CustomEvent<{ available: boolean }>;
    listener(custom.detail);
  };
  window.addEventListener('crish-update-changed', handler);
  return () => window.removeEventListener('crish-update-changed', handler);
}

beforeEach(() => {
  mockedInvokeResult.mockReset();
  mockedInvokeTyped.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkForUpdate（检查更新 · 真实写入点）', () => {
  it('status=available 时写入标记并广播事件（消息含版本号）', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { status: 'available', currentVersion: '0.1.0', version: '9.9.9' },
    });
    const seen: Array<{ available: boolean }> = [];
    const off = onUpdateChanged((d) => seen.push(d));
    try {
      const result = await checkForUpdate();
      expect(result.outcome).toBe('available');
      expect(result.version).toBe('9.9.9');
      expect(result.message).toContain('9.9.9');
      expect(isUpdateAvailable()).toBe(true);
      expect(seen).toEqual([{ available: true }]);
    } finally {
      off();
    }
  });

  it('status=upToDate 时清除标记（不残留陈旧角标）', async () => {
    localStorage.setItem('crish_update_available', '1');
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { status: 'upToDate', currentVersion: '0.1.0' },
    });
    const result = await checkForUpdate();
    expect(result.outcome).toBe('upToDate');
    expect(isUpdateAvailable()).toBe(false);
  });

  it('后端报错时透出错误信息并按 failed 处理，严禁误报有更新', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: '更新网络请求失败: connection refused',
    });
    const result = await checkForUpdate();
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('connection refused');
    expect(isUpdateAvailable()).toBe(false);
  });

  it('invoke 抛异常时如实报失败，不误报', async () => {
    mockedInvokeResult.mockRejectedValueOnce(new Error('ipc down'));
    const result = await checkForUpdate();
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('ipc down');
  });

  it('后端返回未知 status 时按 failed 处理，严禁臆判', async () => {
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: { status: 'something-else', currentVersion: '0.1.0' },
    });
    const result = await checkForUpdate();
    expect(result.outcome).toBe('failed');
    expect(isUpdateAvailable()).toBe(false);
  });
});

describe('applyUpdateWhenIdle（安装更新 · 失败不假成功）', () => {
  it('无更新标记时拒绝且不触达后端', async () => {
    const result = await applyUpdateWhenIdle();
    expect(result.ok).toBe(false);
    expect(result.message).toBe('当前没有可用更新');
    expect(mockedInvokeResult).not.toHaveBeenCalled();
  });

  it('后端签名校验失败时透出可见错误且保留标记（R-21/R-15 锚点）', async () => {
    localStorage.setItem('crish_update_available', '1');
    // 第一次调用来自 hasBlockingTasks → listBackgroundTasks（走 invokeTyped）
    mockedInvokeTyped.mockResolvedValueOnce({ status: 'ok', data: [] });
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'error',
      message: '更新签名校验失败，已拒绝安装: Invalid signature',
    });
    const result = await applyUpdateWhenIdle();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('签名校验失败');
    expect(isUpdateAvailable()).toBe(true, '失败时严禁清除标记假成功');
  });

  it('invoke 抛异常时如实报失败，严禁吞错假成功', async () => {
    localStorage.setItem('crish_update_available', '1');
    mockedInvokeResult.mockRejectedValueOnce(new Error('ipc down'));
    const result = await applyUpdateWhenIdle();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ipc down');
    expect(isUpdateAvailable()).toBe(true);
  });

  it('后端返回 available=false（标记陈旧）时清除标记并如实提示', async () => {
    localStorage.setItem('crish_update_available', '1');
    // 第一次调用来自 hasBlockingTasks → listBackgroundTasks（走 invokeTyped）
    mockedInvokeTyped.mockResolvedValueOnce({ status: 'ok', data: [] });
    mockedInvokeResult.mockResolvedValueOnce({
      status: 'ok',
      data: {
        status: 'noUpdate',
        ok: false,
        available: false,
        currentVersion: '9.9.9',
      },
    });
    const result = await applyUpdateWhenIdle();
    expect(result.ok).toBe(false);
    expect(result.message).toBe('当前没有可用更新');
    expect(isUpdateAvailable()).toBe(false);
  });
});
