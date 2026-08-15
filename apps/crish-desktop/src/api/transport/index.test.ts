/**
 * transport 单路径测试（C3.1：WS 链路已删，Tauri IPC 为唯一实现）：
 * getTransport 恒返回 TauriTransport、单例与重置、startRunTask 分派。
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * 注意：vi.resetModules() 后 './index' 的依赖模块是全新实例，跨模块实例的
 * instanceof 不成立 —— 断言一律用 reload 后模块自身的 re-export 类。
 */
async function loadTransport() {
  vi.resetModules();
  return import('./index');
}

describe('transport（C3.1：IPC 单路径）', () => {
  it('getTransport → TauriTransport（无开关，恒 Tauri）', async () => {
    const mod = await loadTransport();
    expect(mod.getTransport()).toBeInstanceOf(mod.TauriTransport);
  });

  it('getTransport 单例：重复调用同实例；resetTransportForTests 后重建', async () => {
    const mod = await loadTransport();
    const a = mod.getTransport();
    const b = mod.getTransport();
    expect(a).toBe(b);

    mod.resetTransportForTests();
    const c = mod.getTransport();
    expect(c).not.toBe(a);
  });

  describe('startRunTask（C1.2 run-task 通道）', () => {
    it('Tauri transport → request(core_run_task)，返回 {runId, sessionId}', async () => {
      const mod = await loadTransport();
      const tauri = mod.createTransport();
      const requestSpy = vi
        .spyOn(tauri, 'request')
        .mockResolvedValue({ runId: 'r1', sessionId: 's1' });

      await expect(
        mod.startRunTask(tauri, { runId: 'r1', prompt: 'hi' })
      ).resolves.toEqual({ runId: 'r1', sessionId: 's1' });

      expect(requestSpy).toHaveBeenCalledWith('core_run_task', {
        options: {
          runId: 'r1',
          prompt: 'hi',
        },
      });
    });
  });
});
