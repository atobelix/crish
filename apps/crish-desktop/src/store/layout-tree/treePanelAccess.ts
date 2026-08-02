/**
 * 二叉树布局 — 面板焦点/打开命令式 API。
 *
 * 作用：
 * - 为老代码中的 `focusOrOpenPanel` 提供二叉树布局下的等价实现
 * - 为全局 UI 事件桥（useTreePanelEvents）提供单一收口
 *
 * 设计：
 * - 不依赖 React，可直接在工具函数/命令式代码中调用
 * - 选择目标 leaf 的策略与 useTreePanelEvents 一致
 *
 * ## compositionRoot (OPT-G4)
 * `isTreeLayoutActive` only reads **same-store** `useLayoutTreeStore` — keep
 * direct getState (store-internal; no cross-store). Tool open delegates to
 * workspace-shell `openTool*` (command helpers, not raw foreign getState).
 * Do not pull `getCompositionRoot` here: layout-tree already feeds
 * compositionRoot.tree; reverse import would risk package→root cycles for
 * no cross-store gain.
 */

import { useLayoutTreeStore } from './layoutTreeStore';
import { isChatDomain } from './types';
import {
  openToolInActiveTab,
  openToolInSession,
} from '../workspace-shell/openTool';
import {
  ensureAdapterShape,
  ensureChatOnlyTree,
} from '../workspace-shell/adapterShape';

/** 可被事件桥/命令式 API 打开的面板 ID 集合。 */
export type OpenablePanelId =
  | 'overview'
  | 'files'
  | 'terminal'
  | 'diff'
  | 'preview'
  | 'tasks'
  | 'runtime'
  | 'agent'
  | 'chat';

/**
 * 在二叉树布局下聚焦或打开指定面板。
 *
 * Shell redesign：tool 面板一律走 shell openTool（per-session RightToolDock），
 * 禁止再 split 出全局 tool leaf 而忽略会话。chat 仅 ensure adapter。
 *
 * @param panelId 目标面板
 * @param sessionId 可选；多 unit 时传入则打开该 session 的坞，否则活动 tab
 */
export function focusOrOpenTreePanel(
  panelId: string,
  sessionId?: string | null
): void {
  if (panelId === 'chat' || isChatDomain(panelId)) {
    const sid = (sessionId || '').trim();
    ensureChatOnlyTree(sid || undefined);
    ensureAdapterShape();
    return;
  }

  const sid = (sessionId || '').trim();
  if (sid) {
    openToolInSession(sid, panelId);
  } else {
    openToolInActiveTab(panelId);
  }
}

/**
 * 判断当前是否处于二叉树布局。
 * 规则：layoutTreeStore 中存在非空的 tree.root 即认为已启用二叉树布局。
 */
export function isTreeLayoutActive(): boolean {
  try {
    const state = useLayoutTreeStore.getState();
    return Boolean(state?.tree?.root);
  } catch {
    return false;
  }
}
