/**
 * 画布 split 落点能力：会话标签拖到 chat 画布 split 区时，按
 * planSessionCanvasDrop 决策执行 activate / move / create（绝不 clone chat）。
 * 规划纯函数见 topBarDragLib；本 hook 只做 store 提交与收尾。
 * 从 useTopBarDrag.ts 抽出（T05.4.10 useCanvasDropPlanner）。
 */
import { useCallback } from 'react';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  collectLeaves,
  findChatLeafBySessionId,
  isChatDomain,
  useLayoutTreeStore,
} from '../../api/store-access/componentAccess';
import {
  insertLeafBesideNode,
  moveNode,
} from '../../api/store-access/componentAccess';
import type { DropZone } from '../../api/store-access/componentAccess';
import {
  planSessionCanvasDrop,
  reprojectAllSessionDocksSafe,
} from './topBarDragLib';

export type UseCanvasDropPlannerOptions = {
  /** 提交后刷新顶栏标签 */
  refreshTabs: () => void;
};

export type UseCanvasDropPlannerResult = {
  /** 按决策计划提交画布 split（activate / move / create） */
  commitSessionSplit: (sourceSessionId: string, zone: DropZone) => void;
};

export function useCanvasDropPlanner(
  opts: UseCanvasDropPlannerOptions
): UseCanvasDropPlannerResult {
  const setActiveLeaf = useLayoutTreeStore((s) => s.setActiveLeaf);
  const setLeafSessionId = useLayoutTreeStore((s) => s.setLeafSessionId);

  /** 激活 chat leaf + shell 切到对应 session（drop 后统一收尾） */
  const activateSessionOnLeaf = useCallback(
    (leafId: string, sourceSessionId: string) => {
      setActiveLeaf(leafId);
      const shell = getCompositionRoot().shell.getState();
      const existing = shell.openTabs.find((t) => t.sessionId === sourceSessionId);
      if (existing) {
        shell.activateTab(existing.tabId);
      } else {
        shell.openOrFocusSession(sourceSessionId);
      }
      opts.refreshTabs();
    },
    [setActiveLeaf, opts.refreshTabs]
  );

  /**
   * 会话标签拖到 chat 画布 split 区：
   * - 已有该 session 的 unit → 整 unit（chat+其 tools）MOVE 或 ACTIVATE
   * - 尚无 leaf → 在目标 unit 旁创建 chat 并绑定 sessionId
   * 保证 1 session ↔ 0..1 chat leaf，且 tools 不脱离对话 unit。
   */
  const commitSessionSplit = useCallback(
    (sourceSessionId: string, zone: DropZone) => {
      const store = getCompositionRoot().tree.getState();
      const plan = planSessionCanvasDrop(
        store.tree.root,
        sourceSessionId,
        zone
      );

      if (plan.action === 'none') return;

      if (plan.action === 'activate') {
        activateSessionOnLeaf(plan.leafId, sourceSessionId);
        return;
      }

      if (plan.action === 'move') {
        // 整 unit 移到目标 unit 旁（sourceLeafId 实为 unit root id）
        const next = moveNode(
          store.tree,
          plan.sourceLeafId,
          plan.targetLeafId,
          plan.direction
        );
        if (next !== store.tree) {
          store.pushHistory();
          store.setTree(next);
        }
        const chat = findChatLeafBySessionId(
          getCompositionRoot().tree.getState().tree.root,
          sourceSessionId
        );
        activateSessionOnLeaf(chat?.id ?? plan.sourceLeafId, sourceSessionId);
        // 纠偏：若历史树里曾有孤儿 tool，按 shell dock 重投影
        reprojectAllSessionDocksSafe();
        return;
      }

      // ── create：在目标 unit 旁新建 chat leaf（不拆 unit 内 chat|tool） ─
      const shell = getCompositionRoot().shell.getState();
      const shellSid =
        shell.openTabs.find((t) => t.tabId === shell.activeTabId)?.sessionId ??
        null;

      // 目标 unit 内 chat 未绑定时，先绑 shell active
      if (
        plan.targetNeedsShellBind &&
        shellSid &&
        shellSid !== sourceSessionId
      ) {
        const targetChat =
          findChatLeafBySessionId(store.tree.root, shellSid) ??
          collectLeaves(store.tree.root).find(
            (l) => isChatDomain(l.panelId) && l.id === plan.targetLeafId
          );
        if (targetChat && !targetChat.sessionId) {
          setLeafSessionId(targetChat.id, shellSid);
        }
      }

      const beforeIds = new Set(
        collectLeaves(getCompositionRoot().tree.getState().tree.root).map(
          (l) => l.id
        )
      );

      const treeNow = getCompositionRoot().tree.getState().tree;
      const inserted = insertLeafBesideNode(
        treeNow,
        plan.targetLeafId,
        plan.direction,
        'chat',
        sourceSessionId,
        0.5
      );
      if (inserted !== treeNow) {
        store.pushHistory();
        store.setTree(inserted);
      }

      const after = getCompositionRoot().tree.getState();
      const newLeaf = collectLeaves(after.tree.root).find(
        (l) => isChatDomain(l.panelId) && !beforeIds.has(l.id)
      );
      if (newLeaf) {
        if (newLeaf.sessionId !== sourceSessionId) {
          setLeafSessionId(newLeaf.id, sourceSessionId);
        }
        activateSessionOnLeaf(newLeaf.id, sourceSessionId);
      } else {
        activateSessionOnLeaf(plan.targetLeafId, sourceSessionId);
      }
      reprojectAllSessionDocksSafe();
    },
    [setLeafSessionId, activateSessionOnLeaf]
  );

  return { commitSessionSplit };
}
