/**
 * 叶子拥有的会话标签 — 类型、工厂与只读查询。
 *
 * 写源：LayoutLeaf.tabs: SessionTab[] + activeTabId。
 * 草稿哨兵按 tab 唯一（`__pending_draft__:${tabId}`），禁止全局单例写入 tab。
 */

/** 全局草稿哨兵（session store / enterDraftMode 仍用）。禁止写入 SessionTab.sessionId */
export const PENDING_DRAFT_SESSION_ID = '__pending_draft__' as const;

/** 叶内 draft tab 的 sessionId 前缀。完整值 = 前缀 + tabId */
export const DRAFT_SESSION_ID_PREFIX = '__pending_draft__:' as const;

/** 缺省工作区 key（与 GENERAL_FOLDER 字面对齐） */
export const DEFAULT_WORKSPACE_KEY = '对话';

export interface RightToolDockState {
  collapsed: boolean;
  /** files | diff | terminal | overview | agent | runtime | preview … */
  openPanelIds: string[];
  activePanelId: string | null;
  /** 抽屉宽度占叶内容区比例 */
  widthRatio: number;
}

export const DEFAULT_RIGHT_DOCK: RightToolDockState = {
  collapsed: true,
  openPanelIds: [],
  activePanelId: null,
  widthRatio: 0.5,
};

export function createDefaultDock(
  partial?: Partial<RightToolDockState>
): RightToolDockState {
  return { ...DEFAULT_RIGHT_DOCK, ...partial };
}

export type TabKind = 'chat' | 'terminal' | 'browser';

export interface BaseTab {
  tabId: string;
  title: string;
  workspaceKey: string;
  dock: RightToolDockState;
  /** 可选会话 ID：ChatTab 必填且为 string；TerminalTab / BrowserTab 为 undefined */
  sessionId?: string;
}

export interface ChatTab extends BaseTab {
  kind: 'chat';
  sessionId: string;
}

export interface TerminalTab extends BaseTab {
  kind: 'terminal';
  terminalKey: string;
  cwd: string;
  sessionId?: undefined;
}

export interface BrowserTab extends BaseTab {
  kind: 'browser';
  url: string;
  favicon?: string;
  sessionId?: undefined;
}

export type UnifiedTab = ChatTab | TerminalTab | BrowserTab;
export type SessionTab = UnifiedTab;

export function isChatTab(tab: unknown): tab is ChatTab {
  if (!tab || typeof tab !== 'object') return false;
  const t = tab as Record<string, unknown>;
  return (
    t.kind === 'chat' || (!('kind' in t) && typeof t.sessionId === 'string')
  );
}

export function isTerminalTab(tab: unknown): tab is TerminalTab {
  if (!tab || typeof tab !== 'object') return false;
  return (tab as Record<string, unknown>).kind === 'terminal';
}

export function isBrowserTab(tab: unknown): tab is BrowserTab {
  if (!tab || typeof tab !== 'object') return false;
  return (tab as Record<string, unknown>).kind === 'browser';
}

export function mintTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mintDraftSessionId(tabId: string): string {
  return `${DRAFT_SESSION_ID_PREFIX}${tabId}`;
}

export function isDraftSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return (
    id === PENDING_DRAFT_SESSION_ID || id.startsWith(DRAFT_SESSION_ID_PREFIX)
  );
}

export function isRealSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.trim() !== '' && !isDraftSessionId(id);
}

export function createDraftTab(
  opts?:
    | {
        tabId?: string;
        title?: string;
        workspaceKey?: string;
        dock?: Partial<RightToolDockState>;
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
  const title = titleRaw || '新对话';

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
        dock?: Partial<RightToolDockState>;
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
  dock?: Partial<RightToolDockState>;
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
    titleRaw || (isDraftSessionId(sessionId) ? '新对话' : raw) || '新对话';
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
  dock?: Partial<RightToolDockState>;
}): TerminalTab {
  const tabId =
    typeof input?.tabId === 'string' && input.tabId.trim()
      ? input.tabId.trim()
      : mintTabId();
  const terminalKey =
    typeof input?.terminalKey === 'string' && input.terminalKey.trim()
      ? input.terminalKey.trim()
      : `term_${tabId}`;
  const cwd = typeof input?.cwd === 'string' ? input.cwd : '';
  const title =
    typeof input?.title === 'string' && input.title.trim()
      ? input.title.trim()
      : 'Terminal';
  const wkRaw =
    typeof input?.workspaceKey === 'string' ? input.workspaceKey.trim() : '';
  return {
    kind: 'terminal',
    tabId,
    title,
    workspaceKey: wkRaw || DEFAULT_WORKSPACE_KEY,
    dock: createDefaultDock(input?.dock),
    terminalKey,
    cwd,
  };
}

export function createBrowserTab(input?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  url?: string;
  favicon?: string;
  dock?: Partial<RightToolDockState>;
}): BrowserTab {
  const tabId =
    typeof input?.tabId === 'string' && input.tabId.trim()
      ? input.tabId.trim()
      : mintTabId();
  const url =
    typeof input?.url === 'string' && input.url.trim()
      ? input.url.trim()
      : 'about:blank';
  const title =
    typeof input?.title === 'string' && input.title.trim()
      ? input.title.trim()
      : 'Browser';
  const wkRaw =
    typeof input?.workspaceKey === 'string' ? input.workspaceKey.trim() : '';
  const favicon =
    typeof input?.favicon === 'string' ? input.favicon : undefined;
  return {
    kind: 'browser',
    tabId,
    title,
    workspaceKey: wkRaw || DEFAULT_WORKSPACE_KEY,
    dock: createDefaultDock(input?.dock),
    url,
    ...(favicon ? { favicon } : {}),
  };
}

/**
 * 工厂层防御：补 dock、拒绝空 tabId、把精确全局哨兵重铸为 per-tab 哨兵。
 * 支持 terminal / browser / chat 多态标签，平滑兼容旧版 localStorage。
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
  const dock =
    o.dock && typeof o.dock === 'object'
      ? createDefaultDock(o.dock as Partial<RightToolDockState>)
      : createDefaultDock();

  const kind = (typeof o.kind === 'string' ? o.kind : undefined) as
    TabKind | undefined;

  if (kind === 'terminal') {
    const terminalKey =
      typeof o.terminalKey === 'string' && o.terminalKey.trim()
        ? o.terminalKey.trim()
        : `term_${tabId}`;
    return {
      kind: 'terminal',
      tabId,
      title: titleRaw || 'Terminal',
      workspaceKey,
      dock,
      terminalKey,
      cwd: typeof o.cwd === 'string' ? o.cwd : '',
    };
  }
  if (kind === 'browser') {
    const url =
      typeof o.url === 'string' && o.url.trim() ? o.url.trim() : 'about:blank';
    const favicon = typeof o.favicon === 'string' ? o.favicon : undefined;
    return {
      kind: 'browser',
      tabId,
      title: titleRaw || 'Browser',
      workspaceKey,
      dock,
      url,
      ...(favicon ? { favicon } : {}),
    };
  }
  const rawSid = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';
  const sessionId =
    !rawSid || rawSid === PENDING_DRAFT_SESSION_ID
      ? mintDraftSessionId(tabId)
      : rawSid;
  const title =
    titleRaw ||
    (isDraftSessionId(sessionId) ? '新对话' : sessionId) ||
    '新对话';
  return { kind: 'chat', tabId, sessionId, title, workspaceKey, dock };
}

export * from './sessionTabQuery';
