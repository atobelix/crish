/**
 * 工具标签落点提交：把指针层算出的落点翻译成布局树的 DropZone，
 * 再交给 layoutTreeStore.commitDrop 走既有的 applyDrop。
 *
 * 这里刻意不自己改树——跨域守卫、Conversation Unit 作用域、同 leaf 短路
 * 全都写在 applyDrop 里。绕过去就会变成两套规则各改各的，
 * 迟早出现「会话拖拽合法、工具拖拽非法」这种自相矛盾的行为。
 */

import { useLayoutTreeStore } from '../../store/storeAccess';
import type { PaneDropRegion } from './sessionTabDragFeel';

export interface ToolTabDragSource {
  leafId: string;
  tabId: string;
  panelId: string;
}

export type ToolTabDropTarget =
  | { kind: 'strip'; targetLeafId: string; targetTabId?: string }
  | { kind: 'pane'; targetLeafId: string; region: PaneDropRegion };

const REGION_TO_ZONE = {
  left: 'split-left',
  right: 'split-right',
  top: 'split-top',
  bottom: 'split-bottom',
} as const;

/** 进入拖拽：登记拖拽源，让树上的 drop 高亮等既有订阅方能感知 */
export function beginToolTabDrag(source: ToolTabDragSource): void {
  const { leafId, tabId, panelId } = source;
  if (!leafId || !tabId) return;
  useLayoutTreeStore.getState().setDraggedSource({
    type: 'tab',
    leafId,
    tabId,
    panelId,
  });
}

/** 取消拖拽：置空源会连带清掉 activeDropZone */
export function cancelToolTabDrag(): void {
  useLayoutTreeStore.getState().setDraggedSource(null);
}

/**
 * 提交落点。
 *
 * 条内落点用 merge-tab + targetTabId：applyDrop 会插到 targetTabId 之前；
 * targetTabId 缺省即追加到末尾。同 leaf 时 applyDrop 走 reorderTabInLeaf 短路，
 * 不会因为「移除最后一个 tab」把整个 leaf 删掉。
 */
export function commitToolTabDrop(
  source: ToolTabDragSource,
  target: ToolTabDropTarget
): void {
  const { leafId, tabId, panelId } = source;
  if (!leafId || !tabId || !target.targetLeafId) {
    cancelToolTabDrag();
    return;
  }

  const store = useLayoutTreeStore.getState();
  store.setDraggedSource({ type: 'tab', leafId, tabId, panelId });

  if (target.kind === 'strip') {
    store.setActiveDropZone({
      type: 'merge-tab',
      targetLeafId: target.targetLeafId,
      ...(target.targetTabId ? { targetTabId: target.targetTabId } : {}),
      confidence: 1,
    });
  } else if (target.region === 'center') {
    store.setActiveDropZone({
      type: 'merge-tab',
      targetLeafId: target.targetLeafId,
      confidence: 1,
    });
  } else {
    store.setActiveDropZone({
      type: REGION_TO_ZONE[target.region],
      targetLeafId: target.targetLeafId,
      confidence: 1,
    });
  }

  store.commitDrop();
}
