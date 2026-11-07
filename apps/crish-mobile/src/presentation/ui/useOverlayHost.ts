// 统一覆盖层状态机 Hook：
// 管理 activeOverlay: T | null（逻辑状态，驱动 visible=true/false）
// 与 renderedOverlay: T | null（物理挂载状态，确保退场动画期间在树中，播完卸载清空）。
import { useCallback, useState } from 'react';

export interface OverlayHostState<T> {
  /** 当前逻辑处于打开态的覆盖层（驱动 visible=true/false） */
  activeOverlay: T | null;
  /** 当前物理挂载在 React 树中的覆盖层（退场动画期间保持挂载，播完卸载清空） */
  renderedOverlay: T | null;
  /** 打开指定覆盖层（同时置位 activeOverlay 与 renderedOverlay） */
  openOverlay: (overlay: T) => void;
  /** 关闭当前覆盖层（将 activeOverlay 置为 null，保留 renderedOverlay 直到退场完成） */
  closeOverlay: (target?: T | unknown) => void;
  /** 切换指定覆盖层的开闭状态（当前若已打开则关闭，否则打开） */
  toggleOverlay: (overlay: T) => void;
  /** 覆盖层退场动画完成回调（清空 renderedOverlay，完成物理卸载） */
  onOverlayExited: (overlay: T) => void;
  /** 判定指定覆盖层当前逻辑是否开启 */
  isOpen: (target: T) => boolean;
  /** 判定指定覆盖层当前是否物理挂载 */
  isMounted: (target: T) => boolean;
}

/**
 * 统一覆盖层状态机：提供排他性管理与退场物理卸载闭环。
 *
 * 典型配合 Sheet 使用范式：
 * ```tsx
 * const overlay = useOverlayHost<'device' | 'settings'>();
 *
 * return (
 *   <>
 *     {overlay.isMounted('device') && (
 *       <Sheet
 *         visible={overlay.isOpen('device')}
 *         onClose={overlay.closeOverlay}
 *         onCloseComplete={() => overlay.onOverlayExited('device')}
 *       >
 *         <DeviceContent />
 *       </Sheet>
 *     )}
 *   </>
 * );
 * ```
 */
export function useOverlayHost<T = string>(
  initialOverlay: T | null = null
): OverlayHostState<T> {
  const [activeOverlay, setActiveOverlay] = useState<T | null>(initialOverlay);
  const [renderedOverlay, setRenderedOverlay] = useState<T | null>(
    initialOverlay
  );

  const openOverlay = useCallback((overlay: T) => {
    setActiveOverlay(overlay);
    setRenderedOverlay(overlay);
  }, []);

  const closeOverlay = useCallback((target?: T | unknown) => {
    const validTarget = typeof target === 'string' ? (target as T) : undefined;
    setActiveOverlay((current) => {
      if (validTarget !== undefined && current !== validTarget) return current;
      return null;
    });
  }, []);

  const toggleOverlay = useCallback(
    (overlay: T) => {
      if (activeOverlay === overlay) {
        closeOverlay(overlay);
      } else {
        openOverlay(overlay);
      }
    },
    [activeOverlay, closeOverlay, openOverlay]
  );

  const onOverlayExited = useCallback((overlay: T) => {
    setRenderedOverlay((current) => (current === overlay ? null : current));
  }, []);

  const isOpen = useCallback(
    (target: T) => activeOverlay === target,
    [activeOverlay]
  );

  const isMounted = useCallback(
    (target: T) => renderedOverlay === target,
    [renderedOverlay]
  );

  return {
    activeOverlay,
    renderedOverlay,
    openOverlay,
    closeOverlay,
    toggleOverlay,
    onOverlayExited,
    isOpen,
    isMounted,
  };
}

export default useOverlayHost;
