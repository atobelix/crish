/**
 * Conex 单例悬浮把手组件：脱离 React 渲染树的绝对坐标直写实现
 * 文件路径：apps/crish-desktop/src/components/note-paper/ConexFloatHandle.tsx
 */
import React, { useEffect, useRef } from 'react';
import styles from './ConexFloatHandle.module.css';

export interface ConexFloatHandleProps {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  onAddBlock?: (anchorBlockId: string) => void;
  onOpenMenu?: (anchorBlockId: string, anchorEl: HTMLElement) => void;
}

export const ConexFloatHandle: React.FC<ConexFloatHandleProps> = ({
  scrollContainerRef,
  onAddBlock,
  onOpenMenu,
}) => {
  const handleRef = useRef<HTMLDivElement>(null);
  const activeBlockIdRef = useRef<string | null>(null);
  const lastTargetBlockRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    const handleEl = handleRef.current;
    if (!scroller || !handleEl) return;

    let lastHitId: string | null = null;
    let isInsideHandle = false;
    let lastFrameTime = 0;

    const handleMouseEnter = () => {
      isInsideHandle = true;
    };
    const handleMouseLeave = () => {
      isInsideHandle = false;
    };

    handleEl.addEventListener('mouseenter', handleMouseEnter);
    handleEl.addEventListener('mouseleave', handleMouseLeave);

    // 60 FPS 物理帧率节流 (16.6ms)
    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastFrameTime < 16.6) return;
      lastFrameTime = now;

      if (isInsideHandle) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const hitBlock = target.closest('[data-block-id]') as HTMLElement | null;
      if (!hitBlock || !scroller.contains(hitBlock)) {
        if (!isInsideHandle) {
          handleEl.style.display = 'none';
          activeBlockIdRef.current = null;
          lastTargetBlockRef.current = null;
          lastHitId = null;
        }
        return;
      }

      // 划选检测守卫：若用户正在划选文本，强制穿透并隐藏把手，绝不阻断划选
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        handleEl.style.display = 'none';
        return;
      }

      const hitId = hitBlock.getAttribute('data-block-id');
      if (!hitId) return;

      const blockRect = hitBlock.getBoundingClientRect();
      const isSameBlock =
        hitId === lastHitId && hitBlock === lastTargetBlockRef.current;

      // 仅对短块（<=80px）在同块内部移动时短路跳过；
      // 对高度大于 80px 的长块与大表格，允许根据光标移动执行动态 clampedTop 垂直跟随
      if (isSameBlock && blockRect.height <= 80) {
        return;
      }

      lastHitId = hitId;
      lastTargetBlockRef.current = hitBlock;
      activeBlockIdRef.current = hitId;

      // 提取物理几何坐标并直写 DOM
      const scrollerRect = scroller.getBoundingClientRect();

      const blockTop = blockRect.top - scrollerRect.top + scroller.scrollTop;
      const blockBottom =
        blockRect.bottom - scrollerRect.top + scroller.scrollTop;
      const relativePointerY =
        e.clientY - scrollerRect.top + scroller.scrollTop;

      // 垂直跟随与钳位：对于长块（>80px），把手垂直跟随指针位置，避免大代码块/表格悬浮脱靶
      const clampedTop =
        blockRect.height > 80
          ? Math.max(
              blockTop,
              Math.min(relativePointerY - 12, blockBottom - 26)
            )
          : blockTop;

      // X 轴几何防遮挡：
      // rawLeft 是在 block 左侧 28px（正常在外部 gutter 内）
      // 当左侧空间不足 28px 时（rawLeft < 0）：
      // 绝不能在 (blockRect.left + 4px) 覆盖正文首字符！
      // 此时将把手浮置在块顶部上方（top = blockTop - 24px），X 轴对齐正文左侧起始位（left = blockRect.left - scrollerRect.left）
      // 形成顶部悬浮胶囊形态，彻底不遮挡正文任何字符！
      const rawLeft = blockRect.left - scrollerRect.left - 28;
      const isGutterInsufficient = rawLeft < 0;

      const top = isGutterInsufficient
        ? Math.max(0, blockTop - 24)
        : clampedTop;
      const left = isGutterInsufficient
        ? Math.max(0, blockRect.left - scrollerRect.left)
        : rawLeft;

      // 核心：原生 transform 直写，0 次 React Re-render！
      handleEl.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      handleEl.style.display = 'flex';
    };

    const onPointerLeaveContainer = () => {
      if (!isInsideHandle) {
        handleEl.style.display = 'none';
        activeBlockIdRef.current = null;
        lastTargetBlockRef.current = null;
        lastHitId = null;
      }
    };

    const onScroll = () => {
      if (!isInsideHandle) {
        handleEl.style.display = 'none';
        activeBlockIdRef.current = null;
        lastHitId = null;
      }
    };

    scroller.addEventListener('pointermove', onPointerMove, { passive: true });
    scroller.addEventListener('pointerleave', onPointerLeaveContainer, {
      passive: true,
    });
    scroller.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      handleEl.removeEventListener('mouseenter', handleMouseEnter);
      handleEl.removeEventListener('mouseleave', handleMouseLeave);
      scroller.removeEventListener('pointermove', onPointerMove);
      scroller.removeEventListener('pointerleave', onPointerLeaveContainer);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [scrollContainerRef]);

  return (
    <div
      ref={handleRef}
      className={styles.floatHandle}
      style={{ display: 'none' }}
      data-testid="conex-float-handle-singleton"
    >
      <button
        type="button"
        className={styles.actionBtn}
        aria-label="添加块"
        onClick={() => {
          if (activeBlockIdRef.current) {
            onAddBlock?.(activeBlockIdRef.current);
          }
        }}
      >
        +
      </button>
      <div
        className={styles.grabber}
        aria-label="拖拽移动 / 点击菜单"
        onClick={() => {
          if (activeBlockIdRef.current && lastTargetBlockRef.current) {
            onOpenMenu?.(activeBlockIdRef.current, lastTargetBlockRef.current);
          }
        }}
      >
        <span className={styles.grabberDots}>⠿</span>
      </div>
    </div>
  );
};
