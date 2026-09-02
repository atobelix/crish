// @vitest-environment jsdom
/**
 * useTreeDrag 已并入会话单一控制器，生产路径为空操作。
 * 不得再走 commitDrop / applyDrop / DropZoneOverlay。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTreeDrag } from './useTreeDrag';
import { createDefaultTree, useLayoutTreeStore } from '../store/layout-tree';
import { runToolTabDrag } from '../components/shell/toolTabDragRuntime';

function makePointerEvent(
  clientX: number,
  clientY: number
): React.PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
    currentTarget: document.body,
  } as unknown as React.PointerEvent;
}

describe('useTreeDrag 生产空操作', () => {
  afterEach(() => {
    useLayoutTreeStore.setState({
      tree: createDefaultTree('chat'),
      draggedSource: null,
      activeDropZone: null,
      past: [],
      future: [],
    });
    vi.restoreAllMocks();
  });

  it('startDragTab / startDragLeaf 不登记源、不改树、不 commitDrop', () => {
    const commitDrop = vi.spyOn(useLayoutTreeStore.getState(), 'commitDrop');
    const setDraggedSource = vi.spyOn(
      useLayoutTreeStore.getState(),
      'setDraggedSource'
    );
    const treeBefore = useLayoutTreeStore.getState().tree;
    const { result } = renderHook(() => useTreeDrag());

    act(() => {
      result.current.startDragLeaf('leaf-1', 'chat', makePointerEvent(0, 0));
      result.current.startDragTab(
        'leaf-1',
        'tab-1',
        'chat',
        makePointerEvent(0, 0)
      );
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 80,
          clientY: 80,
          pointerId: 1,
        })
      );
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });

    expect(result.current.isDragging).toBe(false);
    expect(result.current.activeDropZone).toBeNull();
    expect(result.current.draggedSource).toBeNull();
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
    expect(useLayoutTreeStore.getState().tree).toBe(treeBefore);
    expect(commitDrop).not.toHaveBeenCalled();
    expect(setDraggedSource).not.toHaveBeenCalled();
  });

  it('runToolTabDrag 空操作：不 commitDrop、不改 LayoutBranch', () => {
    const commitDrop = vi.spyOn(useLayoutTreeStore.getState(), 'commitDrop');
    const treeBefore = useLayoutTreeStore.getState().tree;
    act(() => {
      runToolTabDrag(
        { leafId: 'leaf-1', tabId: 'files', panelId: 'files' },
        '文件',
        makePointerEvent(10, 10)
      );
    });
    expect(commitDrop).not.toHaveBeenCalled();
    expect(useLayoutTreeStore.getState().tree).toBe(treeBefore);
    expect(useLayoutTreeStore.getState().draggedSource).toBeNull();
  });
});
