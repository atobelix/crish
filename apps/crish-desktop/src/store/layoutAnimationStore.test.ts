// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginLayoutInteraction,
  endLayoutInteraction,
  MAX_FREEZE_MS,
  useLayoutAnimationStore,
} from './layoutAnimationStore';

function resetStore() {
  const s = useLayoutAnimationStore.getState();
  for (const type of [...s.activeAnimations]) {
    s.endAnimation(type);
  }
  // 强制清空 body 兼容 class
  document.body.className = '';
  document.body.removeAttribute('data-layout-frozen');
  useLayoutAnimationStore.setState({
    activeAnimations: new Set(),
    isSidebarTransitioning: false,
    isWorkspaceResizing: false,
    isWindowResizing: false,
    isTabDragging: false,
    isLayoutFrozen: false,
    phase: 'idle',
    catchupQueue: new Map(),
  });
}

describe('layoutAnimationStore freeze protocol', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStore();
  });

  it('begin/end workspace-resizing freezes and syncs body classes', () => {
    beginLayoutInteraction('workspace-resizing');
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isLayoutFrozen).toBe(true);
    expect(mid.isWorkspaceResizing).toBe(true);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(true);
    expect(document.body.classList.contains('resizing-active')).toBe(true);
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(document.body.getAttribute('data-layout-frozen')).toBe('true');

    endLayoutInteraction('workspace-resizing');
    const end = useLayoutAnimationStore.getState();
    expect(end.isLayoutFrozen).toBe(false);
    expect(end.isWorkspaceResizing).toBe(false);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(false);
    expect(document.body.classList.contains('resizing-active')).toBe(false);
    expect(document.body.classList.contains('is-resizing')).toBe(false);
  });

  it('double end is safe (no permanent freeze / no throw)', () => {
    beginLayoutInteraction('workspace-resizing');
    endLayoutInteraction('workspace-resizing');
    endLayoutInteraction('workspace-resizing');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(false);
  });

  it('nested types: end one keeps frozen until all end', () => {
    beginLayoutInteraction('workspace-resizing');
    beginLayoutInteraction('sidebar-transition');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);

    endLayoutInteraction('workspace-resizing');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(true);
    // workspace classes cleared, frozen remains via sidebar-transition
    expect(document.body.classList.contains('resizing-active')).toBe(false);

    endLayoutInteraction('sidebar-transition');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
  });

  it('tab-dragging maps dragging-card', () => {
    beginLayoutInteraction('tab-dragging');
    expect(document.body.classList.contains('dragging-card')).toBe(true);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(true);
    endLayoutInteraction('tab-dragging');
    expect(document.body.classList.contains('dragging-card')).toBe(false);
  });

  it('window-resizing freezes with is-layout-frozen + window-resizing class', () => {
    beginLayoutInteraction('window-resizing');
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isLayoutFrozen).toBe(true);
    expect(mid.isWindowResizing).toBe(true);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(true);
    expect(document.body.classList.contains('window-resizing')).toBe(true);
    // 不与 sash 的 resizing-active 混淆（窗口类型仅映射 window-resizing）
    expect(document.body.classList.contains('resizing-active')).toBe(false);

    endLayoutInteraction('window-resizing');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
    expect(document.body.classList.contains('window-resizing')).toBe(false);
  });

  it('window-resizing and workspace-resizing stay isolated in the active set', () => {
    beginLayoutInteraction('workspace-resizing');
    beginLayoutInteraction('window-resizing');
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isWorkspaceResizing).toBe(true);
    expect(mid.isWindowResizing).toBe(true);
    expect(document.body.classList.contains('resizing-active')).toBe(true);
    expect(document.body.classList.contains('window-resizing')).toBe(true);

    // end sash 不得误清 window-resizing
    endLayoutInteraction('workspace-resizing');
    const afterSash = useLayoutAnimationStore.getState();
    expect(afterSash.isWorkspaceResizing).toBe(false);
    expect(afterSash.isWindowResizing).toBe(true);
    expect(afterSash.isLayoutFrozen).toBe(true);
    expect(document.body.classList.contains('resizing-active')).toBe(false);
    expect(document.body.classList.contains('window-resizing')).toBe(true);

    endLayoutInteraction('window-resizing');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
  });

  it('flushCatchupTasks runs registered tasks on full unfreeze', () => {
    let ran = 0;
    beginLayoutInteraction('workspace-resizing');
    useLayoutAnimationStore.getState().registerCatchupTask('t1', () => {
      ran += 1;
    });
    endLayoutInteraction('workspace-resizing');
    expect(ran).toBe(1);
    expect(useLayoutAnimationStore.getState().phase).toBe('idle');
  });

  it('MAX_FREEZE_MS watchdog force-ends stale freeze + warns', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    beginLayoutInteraction('workspace-resizing');
    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(true);

    vi.advanceTimersByTime(MAX_FREEZE_MS - 1);
    expect(useLayoutAnimationStore.getState().isWorkspaceResizing).toBe(true);

    vi.advanceTimersByTime(1);
    const after = useLayoutAnimationStore.getState();
    expect(after.isWorkspaceResizing).toBe(false);
    expect(after.isLayoutFrozen).toBe(false);
    expect(document.body.classList.contains('is-layout-frozen')).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('workspace-resizing');
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('Freeze watchdog');

    warn.mockRestore();
  });

  it('normal end cancels watchdog (no force-end warn)', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    beginLayoutInteraction('workspace-resizing');
    endLayoutInteraction('workspace-resizing');
    vi.advanceTimersByTime(MAX_FREEZE_MS + 1000);

    expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('watchdog is per-type: ending workspace does not end window-resizing timer isolation', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    beginLayoutInteraction('workspace-resizing');
    vi.advanceTimersByTime(1000);
    beginLayoutInteraction('window-resizing');

    // workspace 还剩 MAX_FREEZE_MS - 1000；window 全量 MAX_FREEZE_MS
    vi.advanceTimersByTime(MAX_FREEZE_MS - 1000);
    const mid = useLayoutAnimationStore.getState();
    expect(mid.isWorkspaceResizing).toBe(false);
    expect(mid.isWindowResizing).toBe(true);
    expect(mid.isLayoutFrozen).toBe(true);
    expect(document.body.classList.contains('window-resizing')).toBe(true);
    expect(document.body.classList.contains('resizing-active')).toBe(false);

    vi.advanceTimersByTime(1000);
    const end = useLayoutAnimationStore.getState();
    expect(end.isWindowResizing).toBe(false);
    expect(end.isLayoutFrozen).toBe(false);

    warn.mockRestore();
  });
});
