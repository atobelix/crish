/**
 * Workspace Shell — 终端与浏览器辅助方法与 PTY 生命周期。
 */

import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
  activateWorkspaceForSessionFolder,
} from '../../api/projectStore';
import { currentWorkspaceFolderKey } from '../../api/workspaceChromeTabs';
import {
  isDefaultSessionTitle,
  resolveChromeSessionTitle,
} from '../../api/sessionTitle';
import { useSessionStore } from '../sessionStore';
import { useLayoutStore } from '../layoutStore';
import { isPendingDraft, mintDraftSessionId } from '../draftSession';
import { draftFolderRegistry } from '../draft-routing/draftFolderRegistry';
import { resolveMostActiveProjectFolder } from '../draft-routing/draftProjectResolver';
import {
  useLayoutTreeStore,
  listChatLeaves,
  findNodeById,
  isLeaf,
} from '../layout-tree';
import type { LayoutNode } from '../layout-tree/types';
import {
  ownedChatLeaves,
  pictureFromActiveLeaf,
  resolveActiveChatLeaf,
  scanRealSessionTabs,
} from './treeSessionQuery';
import {
  treeUpdateTabTitle,
  treeAddTab,
  treeResetToSingleDraftLeaf,
} from './treeSessionCommands';

export function workspaceKeyNow(): string {
  return currentWorkspaceFolderKey(getActiveProjectId());
}

export function sessionFromStore(sessionId: string) {
  const state = useSessionStore.getState();
  return (
    state.sessionsById?.[sessionId] ??
    state.sessions?.find((s) => s.id === sessionId)
  );
}

export function resolveSessionTabTitle(
  sessionId: string,
  title?: string
): string {
  return resolveChromeSessionTitle(sessionFromStore(sessionId), title);
}

export function rememberChatLeaf(
  set: (partial: { lastChatLeafId: string | null }) => void,
  leafId: string
): void {
  set({ lastChatLeafId: leafId });
}

export function syncSessionFromActiveLeaf(lastChatLeafId: string | null): void {
  const tab = pictureFromActiveLeaf(lastChatLeafId);
  const session = useSessionStore.getState();
  if (!tab) {
    const leaf = resolveActiveChatLeaf(lastChatLeafId);
    const draftId = mintDraftSessionId(leaf.id);
    if (session.activeSessionId !== draftId) {
      session.enterDraftMode(workspaceKeyNow() || GENERAL_FOLDER, {
        draftSessionId: draftId,
      });
    }
    return;
  }
  if (isPendingDraft(tab.sessionId)) {
    session.enterDraftMode(tab.workspaceKey, {
      draftSessionId: tab.sessionId,
    });
    return;
  }
  if (session.activeSessionId !== tab.sessionId) {
    session.setActiveSessionId(tab.sessionId);
  }
}

export function killPty(sessionId: string): void {
  if (!sessionId || isPendingDraft(sessionId)) return;
  void import('../../api/ptyRegistry')
    .then((m) => m.killPtyForSessionBackground(sessionId))
    .catch(() => {
      /* ignore */
    });
}

/**
 * 确定性杀终端 PTY：包含自身 primaryKey 及分屏关联的 splitKeys（如 key:split-2）。
 */
export function killTerminalPty(terminalKey?: string | null): void {
  const key = (terminalKey || '').trim();
  if (!key) return;
  void import('../../api/ptyRegistry')
    .then((m) => {
      m.killPtyForSessionBackground(key);
      const sessionIds = m.ptyRegistry.sessionIds();
      for (const sid of sessionIds) {
        if (sid.startsWith(`${key}:`)) {
          m.killPtyForSessionBackground(sid);
        }
      }
    })
    .catch(() => {
      /* ignore */
    });
}

export interface TabWithTerminalInfo {
  tabId: string;
  sessionId?: string;
  kind?: string;
  terminalKey?: string;
}

export function findRawTabForClose(
  node: LayoutNode | null | undefined,
  tabId: string
): { leafId: string; tab: TabWithTerminalInfo } | null {
  if (!node) return null;
  if (node.type === 'leaf') {
    const t = (node.tabs as unknown[] as TabWithTerminalInfo[])?.find(
      (x) => x && x.tabId === tabId
    );
    if (t) return { leafId: node.id, tab: t };
    return null;
  }
  return (
    findRawTabForClose(node.children[0], tabId) ||
    findRawTabForClose(node.children[1], tabId)
  );
}

export function cleanupActiveTerminalBeforeReplace(targetLeafId: string): void {
  const rootNode = useLayoutTreeStore.getState().tree.root;
  const leaf = findNodeById(rootNode, targetLeafId);
  if (leaf && isLeaf(leaf)) {
    const activeTab = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
    if (
      activeTab &&
      (activeTab.kind === 'terminal' ||
        (activeTab as unknown as { terminalKey?: string }).terminalKey)
    ) {
      const tInfo = activeTab as unknown as {
        terminalKey?: string;
        sessionId?: string;
      };
      killTerminalPty(tInfo.terminalKey || tInfo.sessionId);
    }
  }
}

export function addTerminalTabToShell(
  leafId: string | undefined,
  opts:
    | {
        tabId?: string;
        title?: string;
        workspaceKey?: string;
        terminalKey?: string;
        cwd?: string;
        dock?: Partial<import('./types').RightToolDockState>;
        insertIdx?: number;
      }
    | undefined,
  lastChatLeafId: string | null,
  set: (partial: { lastChatLeafId: string | null }) => void
): import('../layout-tree/sessionTabModel').TerminalTab {
  const rootNode = useLayoutTreeStore.getState().tree.root;
  const chats = ownedChatLeaves(rootNode);
  const listed = listChatLeaves(rootNode);
  const targetLeaf =
    (leafId &&
      (chats.find((l) => l.id === leafId) ||
        listed.find((l) => l.id === leafId))) ||
    resolveActiveChatLeaf(lastChatLeafId);

  const tab = useLayoutTreeStore.getState().addTerminalTab(targetLeaf.id, opts);
  rememberChatLeaf(set, targetLeaf.id);
  return tab;
}

export function addBrowserTabToShell(
  leafId: string | undefined,
  opts:
    | {
        tabId?: string;
        title?: string;
        workspaceKey?: string;
        url?: string;
        favicon?: string;
        dock?: Partial<import('./types').RightToolDockState>;
        insertIdx?: number;
      }
    | undefined,
  lastChatLeafId: string | null,
  set: (partial: { lastChatLeafId: string | null }) => void
): import('../layout-tree/sessionTabModel').BrowserTab {
  const rootNode = useLayoutTreeStore.getState().tree.root;
  const chats = ownedChatLeaves(rootNode);
  const listed = listChatLeaves(rootNode);
  const targetLeaf =
    (leafId &&
      (chats.find((l) => l.id === leafId) ||
        listed.find((l) => l.id === leafId))) ||
    resolveActiveChatLeaf(lastChatLeafId);

  const tab = useLayoutTreeStore.getState().addBrowserTab(targetLeaf.id, opts);
  rememberChatLeaf(set, targetLeaf.id);
  return tab;
}

export function syncOpenTabTitlesHelper(
  overrides?: Readonly<Record<string, string>>
): void {
  const root = useLayoutTreeStore.getState().tree.root;
  for (const tab of scanRealSessionTabs(root)) {
    if (overrides && overrides[tab.sessionId] === undefined) continue;
    const resolved = resolveSessionTabTitle(
      tab.sessionId,
      overrides?.[tab.sessionId]
    );
    if (resolved === tab.title) continue;
    if (
      isDefaultSessionTitle(resolved) &&
      tab.title.trim() &&
      !isDefaultSessionTitle(tab.title)
    ) {
      continue;
    }
    treeUpdateTabTitle(tab.sessionId, resolved);
  }
}

export function openNewDraftTabHelper(
  opts: { leafId?: string; workspaceKey?: string } | string | undefined,
  lastChatLeafId: string | null,
  set: (partial: { lastChatLeafId: string | null }) => void
): void {
  const args = typeof opts === 'string' ? { workspaceKey: opts } : (opts ?? {});
  const root = useLayoutTreeStore.getState().tree.root;
  const chats = ownedChatLeaves(root);
  const listed = listChatLeaves(root);
  const leaf =
    (args.leafId &&
      (chats.find((l) => l.id === args.leafId) ||
        listed.find((l) => l.id === args.leafId))) ||
    resolveActiveChatLeaf(lastChatLeafId);

  const rawKey = args.workspaceKey?.trim();
  const workspaceKey = rawKey
    ? canonicalSessionFolder(rawKey)
    : resolveMostActiveProjectFolder();

  treeAddTab(leaf.id, { workspaceKey });
  rememberChatLeaf(set, leaf.id);
  useLayoutStore.getState().setChatMainSurface('chat');
  const draftId = mintDraftSessionId(leaf.id);
  useSessionStore.getState().enterDraftMode(workspaceKey, {
    draftSessionId: draftId,
  });
  draftFolderRegistry.set(draftId, workspaceKey);
  try {
    activateWorkspaceForSessionFolder(workspaceKey);
  } catch {
    /* ignore */
  }
}

export function resetToCleanDraftHelper(
  workspaceKey: string | undefined,
  set: (partial: { lastChatLeafId: string | null }) => void
): void {
  const key =
    canonicalSessionFolder(workspaceKey) || workspaceKeyNow() || GENERAL_FOLDER;
  void import('../../api/ptyRegistry')
    .then((m) => m.killAllPtys())
    .catch(() => {
      /* ignore */
    });
  treeResetToSingleDraftLeaf(key);
  const leaf = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0];
  set({ lastChatLeafId: leaf?.id ?? null });
  useSessionStore.getState().enterDraftMode(key, {
    draftSessionId: leaf ? mintDraftSessionId(leaf.id) : undefined,
  });
}
