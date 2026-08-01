// @vitest-environment jsdom
/**
 * accountStatusApi 单测（T06.9.2）：
 * - 类型化解析（Q25）：合法字段保留、脏类型丢弃、非法 JSON 抛错
 * - 调用路径：Tauri workbench_http_request 优先 → 同源直连 fetch 回退
 * - 错误归一：HTTP 非 ok / 网络错误 → 抛错（store 侧 catch 置 error 态）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  refreshAccountStatus,
  parseAccountStatusPayload,
  isAccountStatusPayload,
  type AccountStatus,
} from './accountStatusApi';

const { transportCallMock } = vi.hoisted(() => ({
  transportCallMock: vi.fn(),
}));

vi.mock('./transport', () => ({
  getTransport: () => ({ call: transportCallMock }),
}));

describe('parseAccountStatusPayload（Q25 类型契约）', () => {
  it('合法载荷：只保留已知字段并类型过滤', () => {
    const parsed = parseAccountStatusPayload(
      JSON.stringify({
        status: 'active',
        expiresAt: 1710000000000,
        cooldownUntil: 0,
        usageScore: 95,
        unknownField: 'ignored',
      })
    );
    expect(parsed).toEqual({
      status: 'active',
      expiresAt: 1710000000000,
      cooldownUntil: 0,
      usageScore: 95,
    });
  });

  it('脏类型字段丢弃：status 非枚举、数值字段非数字', () => {
    const parsed = parseAccountStatusPayload(
      JSON.stringify({
        status: 'weird-state',
        expiresAt: 'tomorrow',
        cooldownUntil: null,
        usageScore: 'high',
      })
    );
    expect(parsed).toEqual({});
  });

  it('非法 JSON 抛错（与原 res.json() 语义一致）', () => {
    expect(() => parseAccountStatusPayload('<html>not json</html>')).toThrow();
  });

  it('非对象载荷返回空对象', () => {
    expect(parseAccountStatusPayload('null')).toEqual({});
    expect(parseAccountStatusPayload('[]')).toEqual({});
    expect(parseAccountStatusPayload('"str"')).toEqual({});
  });

  it('isAccountStatusPayload 类型守卫', () => {
    expect(isAccountStatusPayload({ status: 'active' })).toBe(true);
    expect(isAccountStatusPayload({ status: 'bad' })).toBe(false);
    expect(isAccountStatusPayload({ usageScore: 'x' })).toBe(false);
    expect(isAccountStatusPayload(null)).toBe(false);
  });
});

describe('refreshAccountStatus 调用路径', () => {
  beforeEach(() => {
    transportCallMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Tauri workbench_http_request 成功：返回类型化结果', async () => {
    transportCallMock.mockResolvedValue({
      status: 'ok',
      data: { ok: true, status: 200, body: '{"status":"active","usageScore":95}' },
    });

    const result: AccountStatus = await refreshAccountStatus('acc-1');
    expect(result).toEqual({ status: 'active', usageScore: 95 });
    expect(transportCallMock).toHaveBeenCalledWith(
      'workbench_http_request',
      expect.objectContaining({
        url: expect.stringContaining('/api/accounts/acc-1/status'),
        method: 'POST',
      })
    );
  });

  it('Tauri 命令缺失（非 Tauri 环境）→ 回退同源直连 fetch', async () => {
    transportCallMock.mockResolvedValue({ status: 'missing' });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"status":"active","usageScore":95}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result: AccountStatus = await refreshAccountStatus('acc-2');
    expect(result).toEqual({ status: 'active', usageScore: 95 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/accounts/acc-2/status'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('HTTP 非 ok → 抛错', async () => {
    transportCallMock.mockResolvedValue({
      status: 'ok',
      data: { ok: false, status: 500, body: 'boom' },
    });
    await expect(refreshAccountStatus('acc-3')).rejects.toThrow('HTTP 500');
  });

  it('Tauri 真网络错误 → 抛错（不回退静默）', async () => {
    transportCallMock.mockResolvedValue({
      status: 'error',
      kind: 'Internal',
      message: 'network: failed to connect',
    });
    await expect(refreshAccountStatus('acc-4')).rejects.toThrow();
  });

  it('同源 fetch 失败 → 抛错', async () => {
    transportCallMock.mockResolvedValue({ status: 'missing' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    );
    await expect(refreshAccountStatus('acc-5')).rejects.toThrow('HTTP 404');
  });

  it('同源 fetch 非法 JSON → 抛错', async () => {
    transportCallMock.mockResolvedValue({ status: 'missing' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: async () => 'not-json' })
    );
    await expect(refreshAccountStatus('acc-6')).rejects.toThrow();
  });
});
