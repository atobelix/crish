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

import { isPrimaryPanel } from './panelIdentity';
import {
  openToolInActiveTab,
  openToolInSession,
} from '../workspace-shell/openTool';
import { ensureAdapterShape } from '../workspace-shell/adapterShape';

/**
 * 在二叉树布局下聚焦或打开指定面板。
 *
 * Shell redesign：tool 面板一律走 shell openTool（per-session RightToolDock），
 * 禁止再 split 出全局 tool leaf 而忽略会话。chat 仅 ensure adapter。
 *
 * @param panelId 目标面板
 * @param sessionId 可选；多 unit 时传入则打开该 session 的坞，否则活动 tab
 * @param params 可选；下发给该面板的结构化参数
 */
export function focusOrOpenTreePanel(
  panelId: string,
  sessionId?: string | null,
  params?: Record<string, unknown>
): void {
  if (panelId === 'chat' || isPrimaryPanel(panelId)) {
    ensureAdapterShape();
    return;
  }

  const sid = (sessionId || '').trim();
  if (sid) {
    openToolInSession(sid, panelId, params);
  } else {
    openToolInActiveTab(panelId, params);
  }
}
