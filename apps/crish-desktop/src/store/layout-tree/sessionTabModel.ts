/**
 * 叶子拥有的会话标签 — 类型、工厂与只读查询。
 *
 * 写源：LayoutLeaf.tabs: SessionTab[] + activeTabId。
 * 草稿哨兵按 tab 唯一（`__pending_draft__:${tabId}`），禁止全局单例写入 tab。
 */

import {
  type DockTree,
  createDefaultDockTree,
  openToolInDock,
  activateDockTab,
  findToolTab,
  collectSpatialLeaves,
  type ToolViewId,
} from './dockLayoutModel';

export { createToolTab, openToolInDock } from './dockLayoutModel';

import {
  DRAFT_SESSION_ID_PREFIX,
  PENDING_DRAFT_SESSION_ID,
  isDraftSessionId,
  mintDraftSessionId,
} from './sessionTabIdentity';
import { t as translate } from '../../i18n';

export {
  DRAFT_SESSION_ID_PREFIX,
  PENDING_DRAFT_SESSION_ID,
  isChatTab,
  isDraftSessionId,
  isRealSessionId,
  mintDraftSessionId,
} from './sessionTabIdentity';

/** 缺省工作区 key（与 GENERAL_FOLDER 字面对齐） */
export const DEFAULT_WORKSPACE_KEY = '对话'; // i18n-allow: 持久化工作区标识，不参与 UI 翻译

/**
 * 右坞分屏与标签状态 — Clean Break SSOT
 * 彻底从 RightToolDockState 删除 openPanelIds 与 activePanelId，
 * 唯一单一真理源收敛为 tree: DockTree。
 */
export interface RightToolDockState {
  readonly collapsed: boolean;
  readonly widthRatio: number;
  readonly tree: DockTree; // 唯一的右坞分屏与标签状态真理源！
}

export const DEFAULT_RIGHT_DOCK: RightToolDockState = {
  collapsed: true,
  widthRatio: 0.5,
  tree: createDefaultDockTree(),
};

/**
 * 一次性冷迁移纯函数：将旧版扁平右坞状态无损迁移为 V2 DockTree。
 *
 * 保证：
 * 1. 若输入已包含合法 DockTree，保留其 tree 并剥离旧字段；
 * 2. 若输入为旧版 { openPanelIds, activePanelId, collapsed?, widthRatio? }，
 *    通过 openToolInDock 重建二叉树，并正确激活 activePanelId；
 * 3. 输出对象严格删除 openPanelIds 与 activePanelId，实现单一真理源（SSOT）收敛。
 */
export function migrateLegacyDockStateToV2(
  rawDock: unknown
): RightToolDockState {
  if (!rawDock || typeof rawDock !== 'object') {
    return {
      collapsed: DEFAULT_RIGHT_DOCK.collapsed,
      widthRatio: DEFAULT_RIGHT_DOCK.widthRatio,
      tree: createDefaultDockTree(),
    };
  }

  const raw = rawDock as Record<string, unknown>;

  const collapsed =
    typeof raw.collapsed === 'boolean'
      ? raw.collapsed
      : DEFAULT_RIGHT_DOCK.collapsed;

  const widthRatio =
    typeof raw.widthRatio === 'number' && Number.isFinite(raw.widthRatio)
      ? raw.widthRatio
      : DEFAULT_RIGHT_DOCK.widthRatio;

  // 1. 若输入已经包含合法的 tree，直接返回纯净结构（严格剥离旧字段）
  if (
    raw.tree &&
    typeof raw.tree === 'object' &&
    'root' in (raw.tree as Record<string, unknown>)
  ) {
    return {
      collapsed,
      widthRatio,
      tree: raw.tree as DockTree,
    };
  }

  // 2. 若输入为旧版扁平结构或无合法 tree：根据 openPanelIds 与 activePanelId 重建 DockTree
  let tree = createDefaultDockTree();
  const rawPanelIds = Array.isArray(raw.openPanelIds)
    ? (raw.openPanelIds as unknown[])
    : [];

  const panelIds = rawPanelIds.filter(
    (id): id is string => typeof id === 'string' && Boolean(id.trim())
  );

  let activeTargetTabId: string | null = null;
  const rawActivePanelId =
    typeof raw.activePanelId === 'string' && raw.activePanelId.trim()
      ? raw.activePanelId.trim()
      : null;

  for (const pid of panelIds) {
    const res = openToolInDock(tree, { viewId: pid as ToolViewId });
    tree = res.tree;
    if (rawActivePanelId && pid === rawActivePanelId) {
      activeTargetTabId = res.tabId;
    }
  }

  // 若指定了 activePanelId 且找到了对应 tab，则激活该 Tab 并聚焦该窗格
  if (activeTargetTabId) {
    const found = findToolTab(tree, activeTargetTabId);
    if (found) {
      tree = activateDockTab(tree, found.leaf.id, activeTargetTabId);
    }
  } else if (panelIds.length > 0) {
    const leaves = collectSpatialLeaves(tree.root);
    const firstWithTabs = leaves.find((l) => l.tabs.length > 0);
    if (firstWithTabs && firstWithTabs.activeTabId) {
      tree = {
        ...tree,
        activeDockLeafId: firstWithTabs.id,
      };
    }
  }

  return {
    collapsed,
    widthRatio,
    tree,
  };
}

export function createDefaultDock(
  partial?: Partial<RightToolDockState> | unknown
): RightToolDockState {
  if (partial && typeof partial === 'object') {
    return migrateLegacyDockStateToV2(partial);
  }
  return {
    collapsed: DEFAULT_RIGHT_DOCK.collapsed,
    widthRatio: DEFAULT_RIGHT_DOCK.widthRatio,
    tree: createDefaultDockTree(),
  };
}

export type TabKind = 'chat' | 'terminal' | 'browser';

export interface BaseSessionTab {
  readonly tabId: string;
  readonly title: string;
  readonly workspaceKey: string;
}

export interface ChatTab extends BaseSessionTab {
  readonly kind: 'chat';
  readonly sessionId: string;
  readonly dock: RightToolDockState; // 仅 ChatTab 拥有右坞！
}

export interface StandaloneTerminalTab extends BaseSessionTab {
  readonly kind: 'terminal';
  readonly isStandalone: true;
  readonly terminalKey: string; // 形如 "standalone:term_${tabId}"
  readonly cwd: string; // 用户系统家目录，如 C:\Users\orange
  readonly dock?: never; // 绝不允许挂载右坞！
  readonly sessionId?: undefined;
}

export interface StandaloneBrowserTab extends BaseSessionTab {
  readonly kind: 'browser';
  readonly isStandalone: true;
  readonly url: string;
  readonly dock?: never; // 绝不允许挂载右坞！
  readonly sessionId?: undefined;
}

export type TerminalTab = StandaloneTerminalTab; // 统一为 StandaloneTerminalTab
export type BrowserTab = StandaloneBrowserTab;
export type SessionTab = ChatTab | StandaloneTerminalTab | StandaloneBrowserTab;
export type UnifiedTab = SessionTab;
export type BaseTab = BaseSessionTab;

export function isTerminalTab(tab: unknown): tab is StandaloneTerminalTab {
  if (!tab || typeof tab !== 'object') return false;
  return (tab as Record<string, unknown>).kind === 'terminal';
}

export function isBrowserTab(tab: unknown): tab is StandaloneBrowserTab {
  if (!tab || typeof tab !== 'object') return false;
  return (tab as Record<string, unknown>).kind === 'browser';
}

const DOCK_PANEL_IDS = new Set([
  'files',
  'diff',
  'terminal',
  'overview',
  'preview',
  'runtime',
  'agent',
  'flow-dag',
  'file-viewer',
]);

/**
 * 顶层大窗口合法标签类型断言守卫（Phase 3 构造级跨域防线）
 * 仅允许：合法聊天会话 (ChatTab) 或 显式声明的全局常规独立终端 (StandaloneTerminalTab)。
 * 严禁任何右坞工具标签（ToolTab，如 terminal / preview / files / diff 等）越界进入顶层二叉树。
 */
export function assertIsSessionLevelTab(
  tab: unknown
): asserts tab is SessionTab {
  if (typeof tab === 'string') {
    const lower = tab.trim().toLowerCase();
    if (
      DOCK_PANEL_IDS.has(lower) ||
      lower.startsWith('tool_') ||
      lower.startsWith('tool-') ||
      lower.startsWith('dtab_') ||
      lower.startsWith('dtab-') ||
      lower.startsWith('panel_') ||
      lower.startsWith('panel-') ||
      lower.startsWith('dock_') ||
      lower.startsWith('dock-') ||
      lower.startsWith('dleaf_') ||
      lower.startsWith('dleaf-')
    ) {
      throw new Error(
        `[SECURITY_VIOLATION] 右坞工具面板严禁进入顶层大窗口布局树: tabId=${tab}` // i18n-allow: 开发者面向的安全不变量错误
      );
    }
    return;
  }
  if (!tab || typeof tab !== 'object') {
    throw new Error('[SECURITY_VIOLATION] Invalid tab data format');
  }
  const candidate = tab as Partial<SessionTab> & Record<string, unknown>;

  const isChat =
    candidate.kind === 'chat' && typeof candidate.sessionId === 'string';
  const isStandaloneTerminal =
    candidate.kind === 'terminal' && candidate.isStandalone === true;
  const isStandaloneBrowser =
    candidate.kind === 'browser' && candidate.isStandalone === true;

  if (!isChat && !isStandaloneTerminal && !isStandaloneBrowser) {
    throw new Error(
      `[SECURITY_VIOLATION] 右坞工具面板严禁进入顶层大窗口布局树: kind=${String(
        // i18n-allow: 开发者面向的安全不变量错误
        candidate.kind
      )}, tabId=${String(candidate.tabId)}`
    );
  }
}

export const assertIsSessionTab = assertIsSessionLevelTab;

export function mintTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraftTab(
  opts?:
    | {
        tabId?: string;
        title?: string;
        workspaceKey?: string;
        dock?: Partial<RightToolDockState> | unknown;
      }
    | string
): ChatTab {
  const normalizedOpts =
    typeof opts === 'string' ? { workspaceKey: opts } : (opts ?? {});

  const tabId =
    typeof normalizedOpts.tabId === 'string' && normalizedOpts.tabId.trim()
      ? normalizedOpts.tabId.trim()
      : mintTabId();

  const titleRaw =
    typeof normalizedOpts.title === 'string' ? normalizedOpts.title.trim() : '';
  const title = titleRaw || translate('chat.untitledSession');

  const wkRaw =
    typeof normalizedOpts.workspaceKey === 'string'
      ? normalizedOpts.workspaceKey.trim()
      : typeof normalizedOpts.workspaceKey === 'object' &&
          normalizedOpts.workspaceKey !== null
        ? String(
            (normalizedOpts.workspaceKey as Record<string, unknown>)
              .workspaceKey || ''
          ).trim()
        : '';
  const workspaceKey = wkRaw || DEFAULT_WORKSPACE_KEY;

  return {
    kind: 'chat',
    tabId,
    sessionId: mintDraftSessionId(tabId),
    title,
    workspaceKey,
    dock: createDefaultDock(normalizedOpts.dock),
  };
}

/** 维 02 `addTab` / 根删光兜底使用的 mint 别名 */
export function mintDraftTab(
  optsOrWorkspaceKey?:
    | string
    | {
        tabId?: string;
        title?: string;
        workspaceKey?: string;
        dock?: Partial<RightToolDockState> | unknown;
      }
): SessionTab {
  if (typeof optsOrWorkspaceKey === 'string') {
    return createDraftTab({ workspaceKey: optsOrWorkspaceKey });
  }
  return createDraftTab(optsOrWorkspaceKey);
}

export function createSessionTab(input: {
  sessionId: string;
  title?: string;
  workspaceKey?: string;
  tabId?: string;
  dock?: Partial<RightToolDockState> | unknown;
}): ChatTab {
  const tabId =
    typeof input.tabId === 'string' && input.tabId.trim()
      ? input.tabId.trim()
      : mintTabId();
  const raw = (input.sessionId || '').trim();
  const sessionId =
    !raw || raw === PENDING_DRAFT_SESSION_ID
      ? mintDraftSessionId(tabId)
      : raw.startsWith(DRAFT_SESSION_ID_PREFIX)
        ? mintDraftSessionId(tabId)
        : raw;
  const titleRaw = typeof input.title === 'string' ? input.title.trim() : '';
  const title =
    titleRaw ||
    (isDraftSessionId(sessionId) ? translate('chat.untitledSession') : raw) ||
    translate('chat.untitledSession');
  const wkRaw =
    typeof input.workspaceKey === 'string'
      ? input.workspaceKey.trim()
      : typeof input.workspaceKey === 'object' && input.workspaceKey !== null
        ? String(
            (input.workspaceKey as Record<string, unknown>).workspaceKey || ''
          ).trim()
        : '';
  const workspaceKey = wkRaw || DEFAULT_WORKSPACE_KEY;
  return {
    kind: 'chat',
    tabId,
    sessionId,
    title,
    workspaceKey,
    dock: createDefaultDock(input.dock),
  };
}

export function createTerminalTab(input?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  terminalKey?: string;
  cwd?: string;
}): StandaloneTerminalTab {
  const tabId =
    typeof input?.tabId === 'string' && input.tabId.trim()
      ? input.tabId.trim()
      : mintTabId();
  const rawTermKey =
    typeof input?.terminalKey === 'string' ? input.terminalKey.trim() : '';
  const terminalKey = rawTermKey || `standalone:term_${tabId}`;
  const cwd =
    typeof input?.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : '';
  const title =
    typeof input?.title === 'string' && input.title.trim()
      ? input.title.trim()
      : 'Terminal';
  const wkRaw =
    typeof input?.workspaceKey === 'string' ? input.workspaceKey.trim() : '';
  return {
    kind: 'terminal',
    isStandalone: true,
    tabId,
    title,
    workspaceKey: wkRaw || DEFAULT_WORKSPACE_KEY,
    terminalKey,
    cwd,
  };
}

export function createBrowserTab(input?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  url?: string;
}): StandaloneBrowserTab {
  const tabId =
    typeof input?.tabId === 'string' && input.tabId.trim()
      ? input.tabId.trim()
      : mintTabId();
  const url = input?.url?.trim() || 'about:blank';
  const title = input?.title?.trim() || translate('chat.browserTabTitle');
  const wkRaw =
    typeof input?.workspaceKey === 'string' ? input.workspaceKey.trim() : '';
  return {
    kind: 'browser',
    isStandalone: true,
    tabId,
    title,
    workspaceKey: wkRaw || DEFAULT_WORKSPACE_KEY,
    url,
  };
}

/**
 * 工厂层防御：补 dock、拒绝空 tabId、把精确全局哨兵重铸为 per-tab 哨兵。
 * 支持 browser / terminal / chat 多态标签，平滑兼容旧版序列化数据。
 * - 若 t.kind === 'browser'，规范化为 isStandalone: true，且 dock: undefined；
 * - 若 t.dock 为旧格式（存在 openPanelIds 或无 tree），调用迁移函数一次性升水为合法结构，严格删除 openPanelIds 与 activePanelId；
 * - 若 t.kind === 'terminal'，规范化为 isStandalone: true，且 dock: undefined。
 */
export function normalizeSessionTab(t: unknown): UnifiedTab {
  if (!t || typeof t !== 'object') return createDraftTab();
  const o = t as Record<string, unknown>;

  const tabId =
    typeof o.tabId === 'string' && o.tabId.trim() ? o.tabId.trim() : '';
  if (!tabId) return createDraftTab();

  const titleRaw = typeof o.title === 'string' ? o.title.trim() : '';
  const wkRaw = typeof o.workspaceKey === 'string' ? o.workspaceKey.trim() : '';
  const workspaceKey = wkRaw || DEFAULT_WORKSPACE_KEY;

  const kind = (typeof o.kind === 'string' ? o.kind : undefined) as
    TabKind | undefined;

  if (kind === 'browser') {
    return createBrowserTab({
      tabId,
      title: titleRaw || translate('chat.browserTabTitle'),
      workspaceKey,
      url: typeof o.url === 'string' ? o.url : 'about:blank',
    });
  }

  // 若 t.kind === 'terminal'，规范化为 isStandalone: true，且无 dock
  if (kind === 'terminal') {
    const rawTermKey =
      typeof o.terminalKey === 'string' ? o.terminalKey.trim() : '';
    const terminalKey = rawTermKey
      ? rawTermKey.startsWith('standalone:')
        ? rawTermKey
        : `standalone:${rawTermKey}`
      : `standalone:term_${tabId}`;
    const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : '';
    return {
      kind: 'terminal',
      isStandalone: true,
      tabId,
      title: titleRaw || 'Terminal',
      workspaceKey,
      terminalKey,
      cwd,
    };
  }

  // 默认 chat 标签：执行一次性冷迁移
  const dock = migrateLegacyDockStateToV2(o.dock);

  const rawSid = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';
  const sessionId =
    !rawSid || rawSid === PENDING_DRAFT_SESSION_ID
      ? mintDraftSessionId(tabId)
      : rawSid;
  const title =
    titleRaw ||
    (isDraftSessionId(sessionId)
      ? translate('chat.untitledSession')
      : sessionId) ||
    translate('chat.untitledSession');
  return { kind: 'chat', tabId, sessionId, title, workspaceKey, dock };
}

export {
  findTabById,
  findTabBySessionId,
  findLeafByTabId,
  listChatLeaves,
  listAllSessionTabs,
  listRealSessionIds,
  findDuplicateRealSessionIds,
  findDuplicateSessionIds,
  leafDraftSessionId,
  isComposingLeaf,
  activeSessionIdOf,
  sessionIdTaken,
} from './sessionTabQuery';
export type { TabLocation } from './sessionTabQuery';
