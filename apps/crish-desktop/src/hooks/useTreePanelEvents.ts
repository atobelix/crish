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
import { openToolInActiveTab } from '../store/workspace-shell/openTool';

export function useTreePanelEvents(): void {
  useEffect(() => {
    /** 全局事件无显式 session：打开活动 tab 的坞（openAgent 等会先切 session） */
    const openTool = (panelId: string) => {
      openToolInActiveTab(panelId);
    };

    const offAgent = onUiEvent('open-agent-panel', () => {
      openTool('agent');
    });

    const offOverview = onUiEvent('open-overview', () => {
      openTool('overview');
    });

    const offTasks = onUiEvent('open-tasks', () => {
      openTool('overview');
    });

    const offChat = onUiEvent('open-chat', () => {
      focusOrOpenTreePanel('chat');
    });

    const onOpenFile = () => {
      openTool('files');
    };
    const onOpenTerm = () => {
      openTool('terminal');
    };
    window.addEventListener('crish-open-file', onOpenFile);
    window.addEventListener('crish-open-terminal', onOpenTerm);

    return () => {
      offAgent();
      offOverview();
      offTasks();
      offChat();
      window.removeEventListener('crish-open-file', onOpenFile);
      window.removeEventListener('crish-open-terminal', onOpenTerm);
    };
  }, []);
}
