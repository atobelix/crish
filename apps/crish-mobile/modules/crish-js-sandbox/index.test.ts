/**
 * crish-js-sandbox 桥接契约测试（2026-11-05 收敛后重写）：
 *
 * 本模块是端侧 JS 沙箱的唯一实现真源，生产路径只有两条——原生
 * QuickJS 模块在场则桥接执行，不在场则 runtime_unavailable 诚实
 * 降级。旧 Node vm 回退已按删除清单清除，本套件钉住桥接边界契约：
 * 1. 原生路径可达：以 (runId, code, limits) 形状调用原生 run，
 *    结果 JSON 原样透传；探测名首选 'CrishJsSandbox'（与原生侧
 *    JsSandboxModule.kt 的 Name 注册一致）；
 * 2. 原生缺失：返回 runtime_unavailable 结构化错误，绝不抛致命；
 * 3. 原生抛错 / 返回坏 JSON → internal；预取消 → cancelled 且不
 *    触达原生；执行中取消 → cancel(runId) 被调用且结果 cancelled；
 * 4. onSettled 在成功与降级路径均触发；DEFAULT_LIMITS 基准值。
 *
 * 执行语义本身（求值 / 超时 / 内存熔断）由原生 QuickJS 实现承担，
 * 不在本 TS 契约面内——旧回退语义测试随回退一并退役。
 */
import type {
  JsSandboxErrorOutcome,
  JsSandboxNativeModule,
  JsSandboxSuccessOutcome,
} from './index';

const mockRequireOptionalNativeModule = jest.fn();

jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) =>
    mockRequireOptionalNativeModule(name),
}));

type SandboxModule = typeof import('./index');

/**
 * 每次以指定的原生在场状态全新加载模块（绕开模块内原生探测缓存）。
 * 注：本仓 jest 环境不支持动态 import()（无 --experimental-vm-modules），
 * 故经 jest.requireActual 在 resetModules 后同步重载真模块——其内部
 * require('expo') 仍走上方 mock，探测结果由 mock 实现决定。
 */
async function loadModule(native: unknown): Promise<SandboxModule> {
  jest.resetModules();
  mockRequireOptionalNativeModule.mockReset();
  mockRequireOptionalNativeModule.mockImplementation((name: string) =>
    name === 'CrishJsSandbox' ? native : null
  );
  return jest.requireActual<SandboxModule>('./index');
}

function fakeNative(
  overrides: Partial<JsSandboxNativeModule> = {}
): JsSandboxNativeModule {
  return {
    run: jest.fn(async () =>
      JSON.stringify({
        status: 'ok',
        result: '7',
        logs: '',
        logsTruncated: false,
        durationMs: 1,
      })
    ),
    cancel: jest.fn(),
    ...overrides,
  };
}

describe('crish-js-sandbox 桥接契约', () => {
  describe('1. 原生路径可达（形状断言）', () => {
    it('以 (runId, code, limits) 调用原生 run 并透传 ok 结果', async () => {
      const native = fakeNative();
      const mod = await loadModule(native);

      const outcome = await mod.runJsSandbox('1 + 2 * 3');

      expect(outcome.status).toBe('ok');
      const ok = outcome as JsSandboxSuccessOutcome;
      expect(ok.result).toBe('7');

      expect(native.run).toHaveBeenCalledTimes(1);
      const [runId, code, limits] = (native.run as jest.Mock).mock.calls[0];
      expect(typeof runId).toBe('string');
      expect(runId.length).toBeGreaterThan(0);
      expect(code).toBe('1 + 2 * 3');
      expect(limits).toEqual({
        timeoutMs: 5000,
        memoryBytes: 64 * 1024 * 1024,
        maxResultBytes: 256 * 1024,
        maxLogBytes: 4 * 1024,
      });
    });

    it('探测首选名与原生注册名一致，且在场判定为真', async () => {
      const native = fakeNative();
      const mod = await loadModule(native);

      expect(mod.getNativeJsSandbox()).toBe(native);
      expect(mod.isNativeSandboxAvailable()).toBe(true);
      expect(mockRequireOptionalNativeModule).toHaveBeenCalledWith(
        'CrishJsSandbox'
      );
    });

    it('自定义 limits 与 DEFAULT_LIMITS 合并后透传', async () => {
      const native = fakeNative();
      const mod = await loadModule(native);

      await mod.runJsSandbox({ code: 'x', limits: { timeoutMs: 100 } });

      const [, , limits] = (native.run as jest.Mock).mock.calls[0];
      expect(limits.timeoutMs).toBe(100);
      expect(limits.memoryBytes).toBe(64 * 1024 * 1024);
    });

    it('原生 error 结果原样透传 kind 与 message', async () => {
      const native = fakeNative({
        run: jest.fn(async () =>
          JSON.stringify({
            status: 'error',
            kind: 'timeout',
            message: 'The script exceeded the 100 ms time limit.',
            logs: 'partial',
            logsTruncated: false,
            durationMs: 100,
          })
        ),
      });
      const mod = await loadModule(native);

      const outcome = await mod.runJsSandbox('while (true) {}');
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('timeout');
      expect(err.message).toContain('time limit');
      expect(err.logs).toBe('partial');
    });
  });

  describe('2. 原生缺失 → runtime_unavailable 诚实降级', () => {
    it('返回结构化错误而非抛致命，且在场判定为假', async () => {
      const mod = await loadModule(null);

      expect(mod.getNativeJsSandbox()).toBeNull();
      expect(mod.isNativeSandboxAvailable()).toBe(false);

      const outcome = await mod.runJsSandbox('1 + 1');
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('runtime_unavailable');
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.durationMs).toBe(0);
    });

    it('字符串与对象两种入参形态都走同一降级落点', async () => {
      const mod = await loadModule(null);

      const byString = await mod.runJsSandbox('return 1');
      const byOptions = await mod.runJsSandbox({ code: 'return 1' });
      expect((byString as JsSandboxErrorOutcome).kind).toBe(
        'runtime_unavailable'
      );
      expect((byOptions as JsSandboxErrorOutcome).kind).toBe(
        'runtime_unavailable'
      );
    });
  });

  describe('3. 原生侧失败收敛为结构化错误', () => {
    it('原生 run 抛错 → internal（不向上抛）', async () => {
      const native = fakeNative({
        run: jest.fn(async () => {
          throw new Error('native boom');
        }),
      });
      const mod = await loadModule(native);

      const outcome = await mod.runJsSandbox('1');
      expect(outcome.status).toBe('error');
      const err = outcome as JsSandboxErrorOutcome;
      expect(err.kind).toBe('internal');
      expect(err.message).toContain('native boom');
    });

    it('原生返回不可解析的结果 → internal', async () => {
      const native = fakeNative({
        run: jest.fn(async () => 'not-a-json'),
      });
      const mod = await loadModule(native);

      const outcome = await mod.runJsSandbox('1');
      expect((outcome as JsSandboxErrorOutcome).kind).toBe('internal');
    });
  });

  describe('4. 取消语义', () => {
    it('信号预取消 → cancelled 且不触达原生', async () => {
      const native = fakeNative();
      const mod = await loadModule(native);
      const controller = new AbortController();
      controller.abort();

      const outcome = await mod.runJsSandbox({
        code: '1 + 1',
        signal: controller.signal,
      });
      expect((outcome as JsSandboxErrorOutcome).kind).toBe('cancelled');
      expect(native.run).not.toHaveBeenCalled();
    });

    it('执行中取消 → 以同一 runId 调原生 cancel 且结果 cancelled', async () => {
      const native = fakeNative({
        run: jest.fn(() => new Promise<string>(() => {})),
      });
      const mod = await loadModule(native);
      const controller = new AbortController();

      const pending = mod.runJsSandbox({
        code: 'while (true) {}',
        signal: controller.signal,
      });
      await Promise.resolve();
      controller.abort();

      const outcome = await pending;
      expect((outcome as JsSandboxErrorOutcome).kind).toBe('cancelled');
      expect(native.cancel).toHaveBeenCalledTimes(1);
      const [runId] = (native.run as jest.Mock).mock.calls[0];
      expect((native.cancel as jest.Mock).mock.calls[0][0]).toBe(runId);
    });
  });

  describe('5. onSettled 与基准值', () => {
    it('成功与降级两条路径都触发 onSettled 恰一次', async () => {
      const withNative = await loadModule(fakeNative());
      const onSettledOk = jest.fn();
      await withNative.runJsSandbox({ code: '1', onSettled: onSettledOk });
      expect(onSettledOk).toHaveBeenCalledTimes(1);

      const withoutNative = await loadModule(null);
      const onSettledDown = jest.fn();
      await withoutNative.runJsSandbox({
        code: '1',
        onSettled: onSettledDown,
      });
      expect(onSettledDown).toHaveBeenCalledTimes(1);
    });

    it('DEFAULT_LIMITS 具备合理基准值', async () => {
      const mod = await loadModule(null);
      expect(mod.DEFAULT_LIMITS.timeoutMs).toBe(5000);
      expect(mod.DEFAULT_LIMITS.memoryBytes).toBe(64 * 1024 * 1024);
      expect(mod.DEFAULT_LIMITS.maxResultBytes).toBe(256 * 1024);
      expect(mod.DEFAULT_LIMITS.maxLogBytes).toBe(4 * 1024);
    });
  });
});
