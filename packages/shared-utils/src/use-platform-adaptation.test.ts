/** @vitest-environment jsdom */
/**
 * usePlatformAdaptation 集成测试。
 *
 * 只替换硬件探测这一外部输入（detectHardware 依赖真实宿主硬件，无法在测试中
 * 确定化）；等级判定、子系统配置、动态自适应引擎、DOM 渲染应用均为真实实现。
 * 每个用例 resetModules 以获得干净的全局 store（因此配置对象按值比较，而非引用）。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from './hardware-profile';
import { TIER_CONFIGS } from './performance-tier';

const detect = vi.hoisted(() =>
  vi.fn<(opts?: unknown) => Promise<HardwareProfile>>()
);
vi.mock('./hardware-profile', () => ({ detectHardware: detect }));

const GiB = 1024 ** 3;

/** assignTier = 40+40+20+10+5 = 115 → Level3 */
const STRONG: HardwareProfile = {
  cpu: { cores: 8 },
  memory: { total: 16 * GiB, deviceMemory: 8 },
  gpu: {
    available: true,
    webgpu: true,
    webgl: true,
    canvas2d: true,
    vendor: 'Apple',
  },
  storage: { type: 'ssd' },
  platform: 'macos',
  isTauri: true,
};

/** assignTier = 10+40+10+5 = 65 → Level2；引擎运行时评分（jsdom 无 performance.memory）= 25 */
const MID: HardwareProfile = {
  cpu: { cores: 2 },
  memory: { total: 16 * GiB, deviceMemory: 16 },
  gpu: { available: true, webgpu: false, webgl: true, canvas2d: true },
  storage: { type: 'ssd' },
  platform: 'windows',
  isTauri: true,
};

/** assignTier = 0 → Level0 */
const WEAK: HardwareProfile = {
  cpu: { cores: 1 },
  memory: { total: 1 * GiB, deviceMemory: 1 },
  gpu: { available: false, webgpu: false, webgl: false, canvas2d: false },
  storage: { type: 'hdd' },
  platform: 'linux',
  isTauri: false,
};

type HookModule = typeof import('./use-platform-adaptation');
type Engine = import('./dynamic-adaptation').DynamicAdaptationEngine;

let mod: HookModule;
const engines: Engine[] = [];
const raf = vi.fn(() => 1);

beforeEach(async () => {
  vi.resetModules();
  detect.mockReset();
  raf.mockClear();
  // 帧回调永不触发：避免 jsdom 下真实帧率抖动触发 fps_drop，使等级变化完全由用例驱动
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  mod = await import('./use-platform-adaptation');
});

afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.head.querySelectorAll('meta').forEach((m) => m.remove());
});

async function renderReady(
  opts?: Parameters<HookModule['usePlatformAdaptation']>[0]
) {
  const view = renderHook(() => mod.usePlatformAdaptation(opts));
  await waitFor(() => expect(view.result.current.hardwareReady).toBe(true));
  if (opts?.autoStartEngine !== false) {
    await waitFor(() => expect(view.result.current.engine).not.toBeNull());
    engines.push(view.result.current.engine!);
  }
  return view;
}

const htmlClasses = () => [...document.documentElement.classList];

describe('usePlatformAdaptation', () => {
  it('首次渲染为初始态；探测完成后写入 profile/等级/子系统配置、启动引擎并应用 DOM', async () => {
    detect.mockResolvedValue(STRONG);
    const view = renderHook(() =>
      mod.usePlatformAdaptation({
        skipStorageBench: true,
        hardwareTimeout: 1234,
      })
    );
    expect(view.result.current).toMatchObject({
      hardwareReady: false,
      level: 1,
      profile: null,
      engine: null,
    });

    await waitFor(() => expect(view.result.current.engine).not.toBeNull());
    const s = view.result.current;
    engines.push(s.engine!);

    expect(detect).toHaveBeenCalledWith({
      skipStorageBench: true,
      timeout: 1234,
    });
    expect(s.profile).toBe(STRONG);
    expect(s.level).toBe(3);
    expect(s.config).toStrictEqual(TIER_CONFIGS[3]);
    expect(s.assignment?.reasons.at(-1)).toBe('总分 115 → Level 3');
    expect(s.adaptations?.level).toBe(3);
    expect(s.adaptations?.render.cssClasses.add).toContain('perf-level-3');
    const { DynamicAdaptationEngine } = await import('./dynamic-adaptation');
    expect(s.engine).toBeInstanceOf(DynamicAdaptationEngine);
    expect(s.engine!.level).toBe(3);
    expect(raf).toHaveBeenCalled();

    await waitFor(() => expect(htmlClasses()).toContain('perf-level-3'));
    expect(
      document.documentElement.style.getPropertyValue('--anim-duration')
    ).toBe('250ms');
    expect(
      document.querySelector('meta[name="perf-level"]')?.getAttribute('content')
    ).toBe('3');
  });

  it('默认选项：不跳过存储基准，超时 3000ms', async () => {
    detect.mockResolvedValue(STRONG);
    await renderReady();
    expect(detect).toHaveBeenCalledWith({
      skipStorageBench: false,
      timeout: 3000,
    });
  });

  it('setLevel 手动切档：状态与 DOM 一起切换（先清理旧档再应用新档）', async () => {
    detect.mockResolvedValue(STRONG);
    const { result } = await renderReady();
    await waitFor(() => expect(htmlClasses()).toContain('perf-level-3'));

    act(() => result.current.setLevel(0));
    expect(result.current.level).toBe(0);
    expect(result.current.config).toStrictEqual(TIER_CONFIGS[0]);
    expect(result.current.adaptations?.level).toBe(0);
    await waitFor(() => expect(htmlClasses()).toContain('perf-level-0'));
    expect(htmlClasses()).not.toContain('perf-level-3');
    expect(htmlClasses()).not.toContain('gpu-accelerated');
    expect(document.querySelectorAll('meta[name="perf-level"]')).toHaveLength(
      1
    );
    expect(
      document.querySelector('meta[name="perf-level"]')?.getAttribute('content')
    ).toBe('0');
  });

  it('引擎降级事件回写 store：level/config/adaptations/lastEvent 同步更新', async () => {
    detect.mockResolvedValue(MID);
    const { result } = await renderReady();
    expect(result.current.level).toBe(2);

    act(() => result.current.engine!.recordWsRtt(800));

    expect(result.current.level).toBe(1);
    expect(result.current.config).toStrictEqual(TIER_CONFIGS[1]);
    expect(result.current.adaptations?.level).toBe(1);
    expect(result.current.lastEvent).toMatchObject({
      type: 'network_latency',
      fromLevel: 2,
      toLevel: 1,
    });
    await waitFor(() => expect(htmlClasses()).toContain('perf-level-1'));
    expect(htmlClasses()).not.toContain('perf-level-2');
  });

  it('autoStartEngine=false / autoApplyRender=false：不建引擎、不动 DOM', async () => {
    detect.mockResolvedValue(STRONG);
    const { result } = await renderReady({
      autoStartEngine: false,
      autoApplyRender: false,
    });
    expect(result.current.level).toBe(3);
    expect(result.current.engine).toBeNull();
    expect(raf).not.toHaveBeenCalled();
    expect(htmlClasses().filter((c) => c.startsWith('perf-level-'))).toEqual(
      []
    );
  });

  it('引擎创建失败时降级为无动态自适应，并记录告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new Error('raf unavailable');
    });
    detect.mockResolvedValue(STRONG);
    const { result } = renderHook(() => mod.usePlatformAdaptation());
    await waitFor(() => expect(result.current.hardwareReady).toBe(true));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(result.current.level).toBe(3);
    expect(result.current.engine).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toContain('Engine creation failed');
  });

  it('按 upgradeCheckIntervalMs 周期调用 engine.checkUpgrade，卸载后停止', async () => {
    detect.mockResolvedValue(STRONG);
    const view = await renderReady({ upgradeCheckIntervalMs: 15 });
    const spy = vi.spyOn(view.result.current.engine!, 'checkUpgrade');
    await waitFor(() =>
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    );

    view.unmount();
    const calls = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(spy.mock.calls.length).toBe(calls);
  });

  it('redetect 重新探测并把新 profile 同步给引擎', async () => {
    detect.mockResolvedValueOnce(STRONG).mockResolvedValueOnce(WEAK);
    const { result } = await renderReady();
    const engine = result.current.engine!;
    const update = vi.spyOn(engine, 'updateProfile');

    await act(() => result.current.redetect());

    expect(detect).toHaveBeenCalledTimes(2);
    expect(result.current.profile).toBe(WEAK);
    expect(result.current.level).toBe(0);
    expect(result.current.config).toStrictEqual(TIER_CONFIGS[0]);
    expect(update).toHaveBeenCalledWith(WEAK);
  });

  it('探测完成前卸载：结果被丢弃，不写入全局 store', async () => {
    let resolve!: (p: HardwareProfile) => void;
    detect.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = renderHook(() => mod.usePlatformAdaptation());
    first.unmount();
    resolve(STRONG);
    await act(async () => {
      await Promise.resolve();
    });

    detect.mockReturnValue(new Promise(() => {}));
    const second = renderHook(() => mod.usePlatformAdaptation());
    expect(second.result.current.hardwareReady).toBe(false);
    expect(second.result.current.profile).toBeNull();
    second.unmount();
  });
});

describe('PlatformAdaptationCtx', () => {
  it('无 Provider 时返回初始态，有 Provider 时返回注入值', () => {
    const bare = renderHook(() => mod.usePlatformAdaptationCtx());
    expect(bare.result.current).toMatchObject({
      hardwareReady: false,
      level: 1,
      engine: null,
      lastEvent: null,
    });

    const injected = {
      ...bare.result.current,
      hardwareReady: true,
      level: 2 as const,
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        mod.PlatformAdaptationCtx.Provider,
        { value: injected },
        children
      );
    const withProvider = renderHook(() => mod.usePlatformAdaptationCtx(), {
      wrapper,
    });
    expect(withProvider.result.current).toBe(injected);
  });
});
