/**
 * 叶子拥有的会话标签 — 类型、工厂与只读查询。
 *
 * 写源：LayoutLeaf.tabs: SessionTab[] + activeTabId。
 * 草稿哨兵按 tab 唯一（`__pending_draft__:${tabId}`），禁止全局单例写入 tab。
 */
import type { LayoutLeaf, LayoutNode } from './types';
import { collectLeaves } from './layoutTreeQuery';

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

export interface SessionTab {
  tabId: string;
  /** 真会话 id，或 `__pending_draft__:${tabId}`。禁止精确等于 PENDING_DRAFT_SESSION_ID */
  sessionId: string;
  title: string;
  workspaceKey: string;
  dock: RightToolDockState;
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

export function isRealSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.trim() !== '' && !isDraftSessionId(id);
}

export function createDraftTab(opts?: {
  tabId?: string;
  title?: string;
  workspaceKey?: string;
  dock?: Partial<RightToolDockState>;
} | string): SessionTab {
  const normalizedOpts =
    typeof opts === 'string'
      ? { workspaceKey: opts }
      : (opts ?? {});

  const tabId =
    typeof normalizedOpts.tabId === 'string' && normalizedOpts.tabId.trim()
      ? normalizedOpts.tabId.trim()
      : mintTabId();

  const titleRaw =
    typeof normalizedOpts.title === 'string'
      ? normalizedOpts.title.trim()
      : '';
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
}): SessionTab {
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
  const titleRaw =
    typeof input.title === 'string' ? input.title.trim() : '';
  const title =
    titleRaw || (isDraftSessionId(sessionId) ? '新对话' : raw) || '新对话';
  const wkRaw =
    typeof input.workspaceKey === 'string'
      ? input.workspaceKey.trim()
      : typeof input.workspaceKey === 'object' &&
          input.workspaceKey !== null
        ? String(
            (input.workspaceKey as Record<string, unknown>)
              .workspaceKey || ''
          ).trim()
        : '';
  const workspaceKey = wkRaw || DEFAULT_WORKSPACE_KEY;
  return {
    tabId,
    sessionId,
    title,
    workspaceKey,
    dock: createDefaultDock(input.dock),
  };
}

/**
 * 工厂层防御：补 dock、拒绝空 tabId、把精确全局哨兵重铸为 per-tab 哨兵。
 * 已有 `__pending_draft__:${tabId}` 不重铸（move/split 搬对象不走工厂，但 createLeaf 归一化须保持）。
 */
export function normalizeSessionTab(t: unknown): SessionTab {
  if (!t || typeof t !== 'object') return createDraftTab();
  const o = t as Partial<SessionTab> & Record<string, unknown>;
  const tabId = typeof o.tabId === 'string' && o.tabId.trim() ? o.tabId.trim() : '';
  if (!tabId) return createDraftTab();
  const rawSid = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';
  const sessionId =
    !rawSid || rawSid === PENDING_DRAFT_SESSION_ID
      ? mintDraftSessionId(tabId)
      : rawSid;
  const titleRaw = typeof o.title === 'string' ? o.title.trim() : '';
  const title =
    titleRaw || (isDraftSessionId(sessionId) ? '新对话' : sessionId) || '新对话';
  const wkRaw = typeof o.workspaceKey === 'string' ? o.workspaceKey.trim() : '';
  const workspaceKey = wkRaw || DEFAULT_WORKSPACE_KEY;
  const dock =
    o.dock && typeof o.dock === 'object'
      ? createDefaultDock(o.dock)
      : createDefaultDock();
  return { tabId, sessionId, title, workspaceKey, dock };
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
    const index = leaf.tabs.findIndex((t) => t.sessionId === sessionId);
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
    if (!isRealSessionId(tab.sessionId) || seen.has(tab.sessionId)) continue;
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
      if (!isRealSessionId(tab.sessionId)) continue;
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
      if (!tab.sessionId) continue;
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
  if (hit) return hit.sessionId;
  return leafDraftSessionId(leaf.id);
}

/** 非空 sessionId 是否已属于树上某个 tab（可排除正在搬运的 tabId）。I1 入口。 */
export function sessionIdTaken(
  root: LayoutNode,
  sessionId: string,
  exceptTabId?: string
): boolean {
  if (!sessionId) return false;
  for (const leaf of collectLeaves(root)) {
    for (const t of leaf.tabs) {
      if (t.sessionId === sessionId && t.tabId !== exceptTabId) return true;
    }
  }
  return false;
}
