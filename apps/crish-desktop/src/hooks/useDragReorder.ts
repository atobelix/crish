/**
 * HTML5 拖拽重排 hook：为侧边栏会话列表等列表组件提供 reorder 能力。
 *
 * 设计要点：
 * - 用 ref 跟踪 dragIndex，避免闭包捕获过时状态（stale closure）
 * - ghost 元素在 unmount 时通过 useEffect 兜底清理，防止 DOM 泄漏
 * - 完全类型安全：无 as any / as HTMLDivElement 等弱断言
 * - items 仅用于约束泛型 T，运行时不需要（keyField 已移除，从未使用）
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface DragReorderOptions<T> {
  /** 列表项（仅用于泛型约束，运行时不参与逻辑） */
  items: T[];
  /** 重排回调：fromIndex → toIndex */
  onReorder: (fromIndex: number, toIndex: number) => void;
}

interface DragReorderState {
  dragIndex: number | null;
  dropIndex: number | null;
  dragOver: boolean;
}

interface DragReorderHandlers {
  onDragStart: (index: number, e: React.DragEvent) => void;
  onDragOver: (index: number, e: React.DragEvent) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export interface DragReorderResult extends DragReorderState, DragReorderHandlers {}

/**
 * 创建并挂载拖拽 ghost 元素；返回 cleanup 函数移除它。
 * cloneNode 返回 Node，需通过 instanceof 守卫 narrowing 到 HTMLElement。
 */
function createDragGhost(sourceEl: HTMLElement): { ghost: HTMLElement; cleanup: () => void } | null {
  const cloned = sourceEl.cloneNode(true);
  if (!(cloned instanceof HTMLElement)) return null;
  const ghost = cloned;
  ghost.style.position = 'fixed';
  ghost.style.opacity = '0.5';
  ghost.style.pointerEvents = 'none';
  ghost.style.width = `${sourceEl.clientWidth}px`;
  ghost.style.zIndex = '9999';
  document.body.appendChild(ghost);
  return {
    ghost,
    cleanup: () => {
      try {
        ghost.remove();
      } catch {
        /* ignore: 可能已被移除 */
      }
    },
  };
}

export function useDragReorder<T>({ onReorder }: DragReorderOptions<T>): DragReorderResult {
  const [state, setState] = useState<DragReorderState>({
    dragIndex: null,
    dropIndex: null,
    dragOver: false,
  });

  // 用 ref 跟踪 dragIndex，避免 onDrop 闭包捕获过时 state（stale closure）
  const dragIndexRef = useRef<number | null>(null);
  const ghostRef = useRef<{ ghost: HTMLElement; cleanup: () => void } | null>(null);

  const cleanupGhost = useCallback(() => {
    if (ghostRef.current) {
      ghostRef.current.cleanup();
      ghostRef.current = null;
    }
  }, []);

  // 组件卸载时兜底清理 ghost，防止 DOM 泄漏
  useEffect(() => {
    return () => {
      cleanupGhost();
    };
  }, [cleanupGhost]);

  const onDragStart = useCallback((index: number, e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    dragIndexRef.current = index;
    setState((s) => ({ ...s, dragIndex: index, dragOver: true }));

    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const ghostWrapper = createDragGhost(target);
    if (ghostWrapper) {
      ghostRef.current = ghostWrapper;
    }
  }, []);

  const onDragOver = useCallback((index: number, e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setState((s) => ({ ...s, dropIndex: index }));

    const wrapper = ghostRef.current;
    if (wrapper) {
      wrapper.ghost.style.top = `${e.clientY - 30}px`;
      wrapper.ghost.style.left = `${e.clientX - 100}px`;
    }
  }, []);

  const onDrop = useCallback(
    (index: number) => {
      setState((s) => ({ ...s, dragOver: false }));
      const from = dragIndexRef.current;
      if (from !== null && from !== index) {
        onReorder(from, index);
      }
      cleanupGhost();
    },
    [onReorder, cleanupGhost],
  );

  const onDragEnd = useCallback(() => {
    dragIndexRef.current = null;
    setState({ dragIndex: null, dropIndex: null, dragOver: false });
    cleanupGhost();
  }, [cleanupGhost]);

  return {
    dragIndex: state.dragIndex,
    dropIndex: state.dropIndex,
    dragOver: state.dragOver,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
  };
}
