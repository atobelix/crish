/**
 * 二叉树工作区面板事件桥 —— 把跨组件的全局 UI 事件映射到 shell openTool。
 *
 * 老 columns/groups 工作区退休之后，本 hook 在 BinaryTreeWorkspace 主入口挂载一次，
 * 集中订阅 `open-agent-panel` / `open-overview` / `open-tasks` / `crish-open-file` /
 * `crish-open-terminal` 等事件。
 *
 * 工具打开路径（非 chat）：
 * - 直接 `openToolInActiveTab`（per-session RightToolDock，活动 tab）
 * - 不再在 layout tree 上做全局 tool split（会忽略会话作用域）
 * chat 仍走 `focusOrOpenTreePanel('chat')`。
 *
 * 调用方若持有 sessionId（如 openAgentPanel 已 maybeSwitchSession），
 * 活动 tab 即目标会话；leaf 内打开请直接用 openToolInSession(leaf.sessionId, …)。
 */

import { useEffect } from 'react';
import { onUiEvent } from '../api/uiEvents';
import { focusOrOpenTreePanel } from '../store/layout-tree/treePanelAccess';
import {
  openToolInActiveTab,
  openToolInLeaf,
  openToolInSession,
  resolveLeafIdForSession,
  readLeafDock,
  updateLeafDock,
} from '../store/workspace-shell/openTool';
import { useLayoutTreeStore, findNodeById } from '../store/layout-tree';
import { isLeaf } from '../store/layout-tree/types';
import type { RightToolDockState } from '../store/workspace-shell/types';

export function useTreePanelEvents(): void {
  useEffect(() => {
    /** 优先按显式 leafId / sessionId 路由，未提供时回退活动 tab */
    const openToolRouted = (
      panelId: string,
      target?: { leafId?: string; sessionId?: string }
    ) => {
      if (target?.leafId) {
        openToolInLeaf(target.leafId, panelId);
      } else if (target?.sessionId) {
        openToolInSession(target.sessionId, panelId);
      } else {
        openToolInActiveTab(panelId);
      }
    };

    const offToolPanel = onUiEvent('open-tool-panel', (detail) => {
      if (!detail) return;
      openToolRouted(detail.panelId, detail);
    });

    const offToggleRight = onUiEvent('toggle-right-panel', (detail) => {
      const leafId = detail?.leafId;
      const sessionId = detail?.sessionId;
      const targetLeafId =
        leafId ||
        (sessionId ? resolveLeafIdForSession(sessionId) : null) ||
        useLayoutTreeStore.getState().activeLeafId;
      if (!targetLeafId) return;

      const node = findNodeById(
        useLayoutTreeStore.getState().tree.root,
        targetLeafId
      );
      if (!node || !isLeaf(node)) return;
      const dock = readLeafDock(node);
      const nextCollapsed = !dock.collapsed;
      const patch: Partial<RightToolDockState> = { collapsed: nextCollapsed };
      if (!nextCollapsed && !dock.activePanelId) {
        patch.activePanelId = 'overview';
        patch.openPanelIds = dock.openPanelIds.length
          ? dock.openPanelIds
          : ['overview'];
      }
      updateLeafDock(targetLeafId, patch);
    });

    const offAgent = onUiEvent('open-agent-panel', (detail) => {
      openToolRouted('agent', detail);
    });

    const offOverview = onUiEvent('open-overview', (detail) => {
      openToolRouted('overview', detail);
    });

    const offTasks = onUiEvent('open-tasks', (detail) => {
      openToolRouted('overview', detail);
    });

    const offChat = onUiEvent('open-chat', (detail) => {
      if (detail?.leafId) {
        const root = useLayoutTreeStore.getState().tree.root;
        const node = findNodeById(root, detail.leafId);
        if (node && isLeaf(node)) {
          const tabId = node.activeTabId || node.tabs[0]?.tabId;
          if (tabId) {
            useLayoutTreeStore.getState().activateTab(detail.leafId, tabId);
          } else {
            useLayoutTreeStore.setState({ activeLeafId: detail.leafId });
          }
        }
      }
      focusOrOpenTreePanel('chat', detail?.sessionId);
    });

    const onOpenFile = (ev: Event) => {
      const detail = (ev as CustomEvent)?.detail;
      openToolRouted('files', detail);
    };

    const onOpenTerm = (ev: Event) => {
      const detail = (ev as CustomEvent)?.detail;
      openToolRouted('terminal', detail);
    };

    window.addEventListener('crish-open-file', onOpenFile);
    window.addEventListener('crish-open-terminal', onOpenTerm);

    return () => {
      offToolPanel();
      offToggleRight();
      offAgent();
      offOverview();
      offTasks();
      offChat();
      window.removeEventListener('crish-open-file', onOpenFile);
      window.removeEventListener('crish-open-terminal', onOpenTerm);
    };
  }, []);
}
