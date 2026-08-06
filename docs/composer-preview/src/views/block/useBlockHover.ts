/**
 * useBlockHover — 追踪鼠标下的顶层块
 *
 * 拖拽手柄与「＋」按钮需要知道：当前指针悬停在哪个顶层块上、它在视口的什么位置、
 * 它在文档中的位置（用于建立 NodeSelection）。
 *
 * ── 为什么只认顶层块 ──────────────────────────────────
 *   Notion 的手柄只出现在最外层块的左侧。若对嵌套块（列表项内的段落、
 *   引用里的段落、分栏里的块）也给手柄，手柄会层层叠在同一条竖线上，
 *   用户根本分不清自己要拖的是哪一层。
 *   这里用 `view.posAtCoords` 拿到路径后取 depth === 1 的那一层。
 *
 * ── 稳定性处理 ────────────────────────────────────────
 *   手柄本身也在文档左侧，鼠标从块移到手柄上时会短暂离开块区域。
 *   若立刻隐藏，手柄就永远点不到。因此这里加了一段横向宽容区，
 *   并且鼠标进入手柄自身时保持锁定。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';

export interface BlockHoverTarget {
  /** 块的 DOM 元素 */
  element: HTMLElement;
  /** 块在文档中的起始位置 */
  pos: number;
  /** 视口坐标 */
  rect: { top: number; left: number; width: number; height: number };
  /** 节点类型名，用于菜单里显示「转换为」的当前状态 */
  typeName: string;
}

/** 手柄区域向左延伸的宽容范围 */
const GUTTER = 64;

export function useBlockHover(editor: Editor | null, root: HTMLElement | null) {
  const [target, setTarget] = useState<BlockHoverTarget | null>(null);
  /** 锁定：菜单打开或正在拖拽时不跟随鼠标 */
  const lockedRef = useRef(false);
  const rafRef = useRef(0);

  const setLocked = useCallback((locked: boolean) => {
    lockedRef.current = locked;
  }, []);

  const measure = useCallback(
    (element: HTMLElement, pos: number, typeName: string): BlockHoverTarget => {
      const r = element.getBoundingClientRect();
      return {
        element,
        pos,
        typeName,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      };
    },
    [],
  );

  const refresh = useCallback(() => {
    setTarget((prev) => {
      if (!prev || !prev.element.isConnected) return prev;
      return measure(prev.element, prev.pos, prev.typeName);
    });
  }, [measure]);

  useEffect(() => {
    if (!editor || !root) return;

    const onPointerMove = (event: PointerEvent) => {
      if (lockedRef.current) return;

      const rootRect = root.getBoundingClientRect();
      const withinGutter =
        event.clientX >= rootRect.left - GUTTER &&
        event.clientX <= rootRect.right &&
        event.clientY >= rootRect.top &&
        event.clientY <= rootRect.bottom;

      if (!withinGutter) {
        setTarget(null);
        return;
      }

      // 落在左侧空白区时，用块的水平中线去命中，避免 posAtCoords 返回 null
      const probeX = Math.max(event.clientX, rootRect.left + 8);
      const found = editor.view.posAtCoords({ left: probeX, top: event.clientY });
      if (!found) {
        setTarget(null);
        return;
      }

      const $pos = editor.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
      if ($pos.depth < 1) {
        setTarget(null);
        return;
      }

      const topPos = $pos.before(1);
      const node = editor.state.doc.nodeAt(topPos);
      if (!node) {
        setTarget(null);
        return;
      }

      const dom = editor.view.nodeDOM(topPos);
      if (!(dom instanceof HTMLElement)) {
        setTarget(null);
        return;
      }

      setTarget((prev) =>
        prev && prev.element === dom && prev.pos === topPos
          ? prev
          : measure(dom, topPos, node.type.name),
      );
    };

    const onPointerLeave = () => {
      if (!lockedRef.current) setTarget(null);
    };

    document.addEventListener('pointermove', onPointerMove, { passive: true });
    root.addEventListener('pointerleave', onPointerLeave);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [editor, root, measure]);

  /* 滚动与尺寸变化时重新量 */
  useEffect(() => {
    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        refresh();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(rafRef.current);
    };
  }, [refresh]);

  return { target, setLocked, refresh };
}
