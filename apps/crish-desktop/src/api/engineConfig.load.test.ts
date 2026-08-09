/**
 * T-F 06 T2.6：loadEngineConfig（config_get 读面接线）三态测试。
 * 经 getTransport() 通道（与 config_update 对称）：ok → 返回脱敏快照；
 * missing/error → logInternalError + null（不抛，只补读不重建状态流）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEngineConfig } from './engineConfig';

const request = vi.fn();
const waitUntilConnected = vi.fn();

vi.mock('./transport', () => ({
  getTransport: () => ({
    request: (...args: unknown[]) => request(...args),
    waitUntilConnected: (...args: unknown[]) => waitUntilConnected(...args),
  }),
}));

beforeEach(() => {
  request.mockReset();
  waitUntilConnected.mockReset();
});

describe('loadEngineConfig（config_get 读面，T-F 06 T2.6）', () => {
  it('ok → 返回脱敏快照（config_get 载荷）', async () => {
    waitUntilConnected.mockResolvedValue(true);
    request.mockResolvedValue({ baseUrl: 'https://x', model: 'm1' });
    await expect(loadEngineConfig()).resolves.toEqual({
      baseUrl: 'https://x',
      model: 'm1',
    });
    expect(request).toHaveBeenCalledWith('config_get', {}, { timeoutMs: 8_000 });
  });

  it('not_connected → 日志 + null（不抛）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    waitUntilConnected.mockResolvedValue(false);
    await expect(loadEngineConfig()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('命令缺失/报错 → 日志 + null（不抛）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    waitUntilConnected.mockResolvedValue(true);
    request.mockRejectedValue(new Error('Tauri command not available: config_get'));
    await expect(loadEngineConfig()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
