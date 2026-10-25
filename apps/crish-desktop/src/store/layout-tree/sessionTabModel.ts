/**
 * 叶子拥有的会话标签 — 类型、工厂与只读查询。
 *
 * 写源：LayoutLeaf.tabs: SessionTab[] + activeTabId。
 * 草稿哨兵按 tab 唯一（`__pending_draft__:${tabId}`），禁止全局单例写入 tab。
 */
import type { LayoutLeaf, LayoutNode } from './types';
import { collectLeaves } from './layoutTreeTraversal';

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

export interface TabLocation {
  leaf: LayoutLeaf;
  tab: SessionTab;
  index: number;
}

export function findTabById(
  root: LayoutNode,
  tabId: string
): TabLocation | null {
  if (!tabId) return null;
  for (const leaf of collectLeaves(root)) {
    const index = leaf.tabs.findIndex((t) => t.tabId === tabId);
    if (index >= 0) {
      return { leaf, tab: leaf.tabs[index]!, index };
    }
  }
  return null;
}

export function findTabBySessionId(
  root: LayoutNode,
  sessionId: string
): TabLocation | null {
  if (!sessionId) return null;
  for (const leaf of collectLeaves(root)) {
    const index = leaf.tabs.findIndex(
      (t) => isChatTab(t) && t.sessionId === sessionId
    );
    if (index >= 0) {
      return { leaf, tab: leaf.tabs[index]!, index };
    }
  }
  return null;
}

export function findLeafByTabId(
  root: LayoutNode,
  tabId: string
): LayoutLeaf | null {
  return findTabById(root, tabId)?.leaf ?? null;
}

export function listChatLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((l) => l.panelId === 'chat');
}

export function listAllSessionTabs(root: LayoutNode): SessionTab[] {
  const out: SessionTab[] = [];
  for (const leaf of collectLeaves(root)) {
    out.push(...leaf.tabs);
  }
  return out;
}

export function listRealSessionIds(root: LayoutNode): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tab of listAllSessionTabs(root)) {
    if (
      !isChatTab(tab) ||
      !isRealSessionId(tab.sessionId) ||
      seen.has(tab.sessionId)
    ) {
      continue;
    }
    seen.add(tab.sessionId);
    ids.push(tab.sessionId);
  }
  return ids;
}

export function findDuplicateRealSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  const bySid = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const leaf of collectLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (!isChatTab(tab) || !isRealSessionId(tab.sessionId)) continue;
      const list = bySid.get(tab.sessionId);
      const loc = { leafId: leaf.id, tabId: tab.tabId };
      if (list) list.push(loc);
      else bySid.set(tab.sessionId, [loc]);
    }
  }
  const dups = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const [sid, locs] of bySid) {
    if (locs.length >= 2) dups.set(sid, locs);
  }
  return dups;
}

export function findDuplicateSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  const bySid = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const leaf of collectLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (!isChatTab(tab) || !tab.sessionId) continue;
      const list = bySid.get(tab.sessionId);
      const loc = { leafId: leaf.id, tabId: tab.tabId };
      if (list) list.push(loc);
      else bySid.set(tab.sessionId, [loc]);
    }
  }
  const dups = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const [sid, locs] of bySid) {
    if (locs.length >= 2) dups.set(sid, locs);
  }
  return dups;
}

/** 本叶未提交新对话所用的草稿哨兵（按叶 id，不进 tabs） */
export function leafDraftSessionId(leafId: string): string {
  return mintDraftSessionId(leafId);
}

/** 条带无选中：正在看未提交的新对话界面 */
export function isComposingLeaf(leaf: {
  tabs: SessionTab[];
  activeTabId: string;
}): boolean {
  if (!leaf.activeTabId) return true;
  return !leaf.tabs.some((t) => t.tabId === leaf.activeTabId);
}

export function activeSessionIdOf(leaf: LayoutLeaf): string {
  const hit = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
  if (hit && isChatTab(hit)) return hit.sessionId;
  return leafDraftSessionId(leaf.id);
}

/** 非空 sessionId 是否已属于树上某个 tab（可排除正在搬运的 tabId）。I1 入口。 */
export function sessionIdTaken(
  root: LayoutNode,
  sessionId: string | null | undefined,
  exceptTabId?: string
): boolean {
  if (!sessionId) return false;
  for (const leaf of collectLeaves(root)) {
    for (const t of leaf.tabs) {
      if (isChatTab(t) && t.sessionId === sessionId && t.tabId !== exceptTabId)
        return true;
    }
  }
  return false;
}
