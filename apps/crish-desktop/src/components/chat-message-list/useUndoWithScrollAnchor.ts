import { useCallback } from 'react';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { MessageDelta } from '../../api/MessageSnapshots';

export interface UndoWithScrollAnchorResult {
  restoredDelta?: MessageDelta;
  [key: string]: unknown;
}

/**
 * 撤销/重做操作视口同步锚定 Hook。
 *
 * 核心几何与时序原理：
 * 1. 在撤销操作同一个执行栈（微任务）内，先捕获视口顶部第一可见元素（Anchor）的 ID 与视口相对内偏移；
 * 2. 执行撤销动作并接收还原出的 MessageDelta；
 * 3. 将快照中携带的实测 heightMap 同步原子回灌进 VirtualScrollManager；
 * 4. 同步校准 containerRef.scrollTop，使 Anchor 元素在视口中的物理坐标完全不变，消灭千像素震荡与 120px 阶跃暴跌。
 */
export function useUndoWithScrollAnchor(
  containerRef: React.RefObject<HTMLDivElement | null>,
  vsm: VirtualScrollManager
) {
  const performUndoWithAnchor = useCallback(
    (undoAction: () => UndoWithScrollAnchorResult | void) => {
      const el = containerRef.current;
      if (!el) {
        undoAction();
        return;
      }

      // 1. 捕获视口顶部第一条可见消息的 ID 及其相对视口顶部的像素偏移量
      const currentScrollTop = el.scrollTop;
      const currentOrder = vsm.getOrder();
      let anchorId: string | null = null;
      let anchorOffsetInView = 0;

      for (let i = 0; i < currentOrder.length; i++) {
        const itemTop = vsm.getOffset(i);
        const itemHeight = vsm.getHeightAt(i);
        if (itemTop + itemHeight > currentScrollTop) {
          anchorId = currentOrder[i] ?? null;
          anchorOffsetInView = currentScrollTop - itemTop;
          break;
        }
      }

      // 2. 执行撤销动作并获取还原的 delta
      const result = undoAction();
      const restoredDelta =
        result && typeof result === 'object' && 'restoredDelta' in result
          ? (result as UndoWithScrollAnchorResult).restoredDelta
          : undefined;

      // 3. 将快照中携带的 heightMap 同步灌回 VSM
      if (restoredDelta?.heightMap) {
        vsm.hydrateHeightMap(restoredDelta.heightMap);
      }

      // 4. 同步在当前调用栈中修正 scrollTop，绝不排入 rAF，杜绝多帧叠加共振
      if (anchorId) {
        const newOrder = vsm.getOrder();
        const newIdx = newOrder.indexOf(anchorId);
        if (newIdx !== -1) {
          const newAnchorTop = vsm.getOffset(newIdx);
          el.scrollTop = Math.max(0, newAnchorTop + anchorOffsetInView);
        }
      }
    },
    [containerRef, vsm]
  );

  return { performUndoWithAnchor };
}
