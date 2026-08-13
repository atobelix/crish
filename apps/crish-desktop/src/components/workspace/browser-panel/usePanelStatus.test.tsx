// @vitest-environment jsdom
/**
 * usePanelStatus hook 测试（P1-B2）：接管状态机时序（800ms 过渡）/ 推断模式
 * （帧在动 + 用户安静）/ 引擎信号模式 / 暂停恢复 / 推断抑制面。
 * 定时面用 fake timers 确定性驱动（时钟从 0 起：先推进越过安静窗）。
 *
 * 注意：renderHook 回调必须接收 props（rerender 才能更新选项）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { TOKEN_MIN_STABLE_WINDOW_MS } from './panelStatusMachine';
import { usePanelStatus, type UsePanelStatusOptions } from './usePanelStatus';

function makeOpts(
  overrides: Partial<UsePanelStatusOptions> = {}
): UsePanelStatusOptions {
  return {
    frameState: 'active',
    lastFrameSeq: null,
    engineAiBusy: null,
    ...overrides,
  };
}

/** 挂载（回调接收 props：rerender 可更新选项，供帧/引擎信号注入）。 */
function renderStatus(opts: UsePanelStatusOptions = makeOpts()) {
  return renderHook(
    (props: UsePanelStatusOptions | undefined) => usePanelStatus(props ?? opts),
    { initialProps: opts }
  );
}

/** 模拟一帧到达（基于当前 opts 仅更新 seq → 帧到达时间戳刷新）。 */
function pumpFrame(
  rerender: (opts: UsePanelStatusOptions) => void,
  opts: UsePanelStatusOptions,
  seq: number
) {
  act(() => {
    rerender({ ...opts, lastFrameSeq: seq });
  });
}

describe('usePanelStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('推断模式：帧在动 + 用户安静（防抖后）→ ai-busy；帧停 → idle', () => {
    const opts = makeOpts();
    const { result, rerender } = renderStatus(opts);
    expect(result.current.status).toBe('idle');
    // 越过用户安静窗（从未输入 = 安静），再注入帧（页面在动）
    act(() => vi.advanceTimersByTime(1700));
    pumpFrame(rerender, opts, 1);
    // 轮询（250ms）识别 → 600ms 防抖 → AI_START
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('ai-busy');
    // 帧停（页面静止 ≈0 帧，S0-01）→ 防抖后 AI_END
    act(() => vi.advanceTimersByTime(1200));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('idle');
  });

  it('推断模式：无帧到达（页面静止）→ 恒 idle', () => {
    const { result } = renderStatus(makeOpts());
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.status).toBe('idle');
  });

  it('用户输入接管：ai-busy + 用户输入 → user-taking-over → 800ms → idle', () => {
    const opts = makeOpts();
    const { result, rerender } = renderStatus(opts);
    act(() => vi.advanceTimersByTime(1700));
    pumpFrame(rerender, opts, 1);
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('ai-busy');

    act(() => result.current.onUserInput());
    expect(result.current.status).toBe('user-taking-over');
    // T-12：800ms 过渡（对齐维度 15 TOKEN_MIN_STABLE_WINDOW）
    act(() => vi.advanceTimersByTime(TOKEN_MIN_STABLE_WINDOW_MS - 100));
    expect(result.current.status).toBe('user-taking-over');
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.status).toBe('idle');
  });

  it('接管期连续用户输入：过渡时长不延长（800ms 固定，定时不重启）', () => {
    const opts = makeOpts();
    const { result, rerender } = renderStatus(opts);
    act(() => vi.advanceTimersByTime(1700));
    pumpFrame(rerender, opts, 1);
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    act(() => result.current.onUserInput());
    expect(result.current.status).toBe('user-taking-over');
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.onUserInput()); // 保持接管（不重启定时）
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.status).toBe('idle');
  });

  it('接管期推断 AI_END 被抑制（过渡由 800ms 定时负责）', () => {
    // 注入短窗（activity/quiet 100ms、poll/hold 50ms）：在 800ms 接管窗内
    // 可观测到「帧停 + 用户安静 → 推断 AI_END」被抑制
    const opts = makeOpts({
      frameActivityMs: 100,
      userQuietMs: 100,
      inferHoldMs: 50,
      inferPollMs: 50,
    });
    const { result, rerender } = renderStatus(opts);
    act(() => vi.advanceTimersByTime(200)); // 越过安静窗
    pumpFrame(rerender, opts, 1);
    act(() => vi.advanceTimersByTime(50)); // poll：帧在动 → 防抖
    act(() => vi.advanceTimersByTime(50)); // AI_START → ai-busy
    expect(result.current.status).toBe('ai-busy');
    act(() => result.current.onUserInput());
    expect(result.current.status).toBe('user-taking-over');
    // 帧停 + 用户安静（推断 AI_END 到达）→ 不打断接管展示
    act(() => vi.advanceTimersByTime(300));
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.status).toBe('user-taking-over');
    // 800ms 过渡（T-12）到点 → idle
    act(() => vi.advanceTimersByTime(550));
    expect(result.current.status).toBe('idle');
  });

  it('暂停/恢复：ai-busy → paused；恢复 → idle；暂停期不推断 AI 忙', () => {
    const opts = makeOpts({
      frameActivityMs: 100,
      userQuietMs: 100,
      inferHoldMs: 50,
      inferPollMs: 50,
    });
    const { result, rerender } = renderStatus(opts);
    act(() => vi.advanceTimersByTime(200)); // 越过安静窗
    pumpFrame(rerender, opts, 1);
    act(() => vi.advanceTimersByTime(50));
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.status).toBe('ai-busy');

    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');
    // 帧仍在动 + 用户安静 → 推断 AI_START 被暂停面抑制（队列已挂起）
    pumpFrame(rerender, opts, 2);
    act(() => vi.advanceTimersByTime(100));
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.status).toBe('paused');

    act(() => result.current.resume());
    expect(result.current.status).toBe('idle');
  });

  it('引擎信号模式（接线后）：engineAiBusy 直接驱动 ai-busy/idle', () => {
    const { result, rerender } = renderStatus(
      makeOpts({ engineAiBusy: false })
    );
    expect(result.current.status).toBe('idle');
    rerender(makeOpts({ engineAiBusy: true }));
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('ai-busy');
    rerender(makeOpts({ engineAiBusy: false }));
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('idle');
  });

  it('引擎信号模式：暂停期 AI_START 不被抑制（引擎权威，12 §5.1 重新触发）', () => {
    const { result, rerender } = renderStatus(makeOpts({ engineAiBusy: true }));
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('ai-busy');

    act(() => result.current.pause());
    expect(result.current.status).toBe('paused');
    // 引擎信号回落（AI 结束）→ 暂停面保持（paused + AI_END 不迁移）
    rerender(makeOpts({ engineAiBusy: false }));
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('paused');
    // 引擎重新触发（暂停期 AI_START）：引擎权威 → 不被推断抑制面拦截
    rerender(makeOpts({ engineAiBusy: true }));
    act(() => vi.advanceTimersByTime(250));
    act(() => vi.advanceTimersByTime(600));
    expect(result.current.status).toBe('ai-busy');
  });

  it('aiActionText 未接线恒 null（接线点：browser:status 事件）', () => {
    const { result } = renderStatus(makeOpts());
    expect(result.current.aiActionText).toBeNull();
  });

  it('卸载清理定时器：无残留派发（不触发未捕获错误）', () => {
    const opts = makeOpts();
    const { rerender, unmount } = renderStatus(opts);
    act(() => vi.advanceTimersByTime(1700));
    pumpFrame(rerender, opts, 1);
    act(() => vi.advanceTimersByTime(250));
    unmount();
    act(() => vi.advanceTimersByTime(3000));
    // 卸载后定时器已清理：不 panic 即为通过
  });
});
