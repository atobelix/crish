// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as layoutAnimationModule from './layoutAnimationStore';
import {
  beginLayoutInteraction,
  CATCHUP_TIME_BUDGET_MS,
  endLayoutInteraction,
  registerLayoutAnimationBridge,
  useLayoutAnimationStore,
  WATCHDOG_TIMEOUT_MS,
} from './layoutAnimationStore';
import { ResizeObserverManager } from '../utils/ResizeObserverManager';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver =
    MockResizeObserver;
}

function resetStore() {
  useLayoutAnimationStore.getState().forceRecoverAll();
  document.body.className = '';
  document.body.removeAttribute('data-layout-frozen');
  useLayoutAnimationStore.setState({
    activeAnimations: new Set(),
    suspendedPaneIds: new Set(),
    isSidebarTransitioning: false,
    isWorkspaceResizing: false,
    isWindowResizing: false,
    isTabDragging: false,
    phase: 'idle',
    catchupQueue: new Map(),
  });
}

describe('layoutAnimationStore (Stage 06 单轨收敛：零全局冻结、窗格级门控、8ms 分片排空与 200ms 看门狗)', () => {
  beforeEach(() => {
    ResizeObserverManager.resetInstanceForTest();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStore();
    ResizeObserverManager.resetInstanceForTest();
  });

  it('单轨契约断言：彻底拔除全局 isLayoutFrozen、MAX_FREEZE_MS (30s) 与 LAYOUT_SHELL_PANE_ID 伪映射', () => {
    const state = useLayoutAnimationStore.getState() as unknown as Record<
      string,
      unknown
    >;
    expect('isLayoutFrozen' in state).toBe(false);
    expect('MAX_FREEZE_MS' in layoutAnimationModule).toBe(false);
    expect('LAYOUT_SHELL_PANE_ID' in layoutAnimationModule).toBe(false);
    expect(WATCHDOG_TIMEOUT_MS).toBe(200);
    expect(CATCHUP_TIME_BUDGET_MS).toBe(8);
  });

  it('begin/end 动画仅更新轻量状态，绝不向 document.body 广播 is-layout-frozen / tree-resizing / data-layout-frozen', () => {
    beginLayoutInteraction('workspace-resizing');
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isWorkspaceResizing).toBe(true);
    expect(mid.phase).toBe('animating');

    // 断言 document.body 保持 100% 纯净，零全局冻结类名污染
    expect(document.body.classList.contains('is-layout-frozen')).toBe(false);
    expect(document.body.classList.contains('resizing-active')).toBe(false);
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('tree-resizing')).toBe(false);
    expect(document.body.getAttribute('data-layout-frozen')).toBeNull();

    endLayoutInteraction('workspace-resizing');
    const end = useLayoutAnimationStore.getState();
    expect(end.isWorkspaceResizing).toBe(false);
    expect(end.phase).toBe('idle');
  });

  it('细粒度窗格级门控 (suspendPanes / resumePanes) 与 ResizeObserverManager 同步联动', () => {
    const mgr = ResizeObserverManager.getInstance();
    beginLayoutInteraction('workspace-resizing', {
      paneIds: ['leaf-a', 'leaf-b'],
    });

    const state = useLayoutAnimationStore.getState();
    expect(state.isPaneSuspended('leaf-a')).toBe(true);
    expect(state.isPaneSuspended('leaf-b')).toBe(true);
    expect(state.isPaneSuspended('leaf-c')).toBe(false);
    expect(mgr.isPaneSuspended('leaf-a')).toBe(true);
    expect(mgr.isPaneSuspended('leaf-c')).toBe(false);

    endLayoutInteraction('workspace-resizing', {
      paneIds: ['leaf-a', 'leaf-b'],
    });
    expect(useLayoutAnimationStore.getState().isPaneSuspended('leaf-a')).toBe(
      false
    );
    expect(mgr.isPaneSuspended('leaf-a')).toBe(false);
  });

  it('多类型并发隔离：workspace-resizing 与 window-resizing 互不误清', () => {
    beginLayoutInteraction('workspace-resizing');
    beginLayoutInteraction('window-resizing');
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isWorkspaceResizing).toBe(true);
    expect(mid.isWindowResizing).toBe(true);

    endLayoutInteraction('workspace-resizing');
    const afterSash = useLayoutAnimationStore.getState();
    expect(afterSash.isWorkspaceResizing).toBe(false);
    expect(afterSash.isWindowResizing).toBe(true);
    expect(afterSash.phase).toBe('animating');

    endLayoutInteraction('window-resizing');
    expect(useLayoutAnimationStore.getState().isWindowResizing).toBe(false);
    expect(useLayoutAnimationStore.getState().phase).toBe('idle');
  });

  it('8ms 时间预算分片排空 Catch-up 队列：轻任务当帧完成，超预算重任务自动跨帧 rAF 接力', () => {
    vi.useFakeTimers();
    let mockNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

    beginLayoutInteraction('workspace-resizing');

    const executed: string[] = [];
    for (let i = 0; i < 6; i++) {
      const key = `task-${i}`;
      useLayoutAnimationStore.getState().registerCatchupTask(key, () => {
        mockNow += 3; // 每个任务耗时 3ms，3 个任务后达到 9ms >= 8ms 预算
        executed.push(key);
      });
    }

    endLayoutInteraction('workspace-resizing');

    // 首片同步执行 3 个任务后达到 9ms >= 8ms，立即让出主线程，剩余 3 个排入下一帧 rAF
    expect(executed).toEqual(['task-0', 'task-1', 'task-2']);
    expect(useLayoutAnimationStore.getState().phase).toBe('catching-up');

    // 推进下一帧 rAF
    vi.advanceTimersByTime(16);
    expect(executed).toEqual([
      'task-0',
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
    ]);
    expect(useLayoutAnimationStore.getState().phase).toBe('idle');
  });

  it('200ms Windows 异常中断看门狗：触发 blur / pointercancel / lostpointercapture 时 200ms 内自动自愈解冻', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanupBridge = registerLayoutAnimationBridge();

    beginLayoutInteraction('workspace-resizing', { paneIds: ['leaf-1'] });
    expect(useLayoutAnimationStore.getState().isWorkspaceResizing).toBe(true);
    expect(useLayoutAnimationStore.getState().isPaneSuspended('leaf-1')).toBe(
      true
    );

    // 模拟用户拖拽中按下 Alt+Tab 触发 window blur
    window.dispatchEvent(new Event('blur'));

    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    expect(useLayoutAnimationStore.getState().isWorkspaceResizing).toBe(true);

    vi.advanceTimersByTime(1);
    const after = useLayoutAnimationStore.getState();
    expect(after.isWorkspaceResizing).toBe(false);
    expect(after.isPaneSuspended('leaf-1')).toBe(false);
    expect(after.phase).toBe('idle');
    expect(warn).toHaveBeenCalled();

    cleanupBridge();
    warn.mockRestore();
  });
});
