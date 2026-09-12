/**
 * 冷启动门闩：默认 clean 单 chat；设置可 restore 上次 workspace。
 *
 * restore 路径只调维 01 `migrateToLeafOwnedTabs` 一次，之后 shell 只 setShellReady。
 * 运行期不写 openTabs / legacy map。
 */

import { loadLegacyOpenTabsMap } from '../store/workspace-shell';
import {
  applySafeCleanColdStart,
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
} from '../store/workspace-shell/layoutRestorePolicy';
import { getSessionById } from '../store/sessionStore';
import * as layoutTreePkg from '../store/layout-tree';
import { getCompositionRoot } from './compositionRoot';
import { getSettingsState } from '../store/storeAccess';
import type { Settings } from '../api/clientApi';
import { clearLegacyOpenTabsMap } from '../api/workspaceChromeTabs';
import type { LayoutTree } from '../store/layout-tree/types';
import { triggerSessionMessageHydrateIfNeeded } from '../store/sessionCrudActions';
import { isPendingDraft } from '../store/draftSession';
import { staggeredIdleQueue } from '../services/idle/StaggeredIdleQueue';

/** @deprecated use RESTORE_LAST_WORKSPACE_SETTING_KEY */
const RESTORE_KEY = RESTORE_LAST_WORKSPACE_SETTING_KEY;

type MigrateFn = (input: {
  tree: unknown;
  openTabsMap?: Readonly<Record<string, string[]>>;
  activeLeafId?: string | null;
  resolveMeta?: (
    sessionId: string
  ) => { title?: string; workspaceKey?: string } | undefined;
}) =>
  | { ok: true; tree: LayoutTree; didMigrate: boolean }
  | { ok: false; tree: LayoutTree; reason: string };

function resolveMigrateFn(): MigrateFn | null {
  const fn = (layoutTreePkg as { migrateToLeafOwnedTabs?: MigrateFn })
    .migrateToLeafOwnedTabs;
  return typeof fn === 'function' ? fn : null;
}

export function readRestoreLastWorkspace(): boolean {
  try {
    const settings = getCompositionRoot().layout.getAppSettings() as
      | Record<string, unknown>
      | undefined;
    if (settings && typeof settings[RESTORE_KEY] === 'boolean') {
      return Boolean(settings[RESTORE_KEY]);
    }
    if (
      settings?.ui &&
      typeof (settings.ui as { restoreLastWorkspace?: unknown })
        .restoreLastWorkspace === 'boolean'
    ) {
      return Boolean(
        (settings.ui as { restoreLastWorkspace: boolean }).restoreLastWorkspace
      );
    }
    const raw = localStorage.getItem(RESTORE_LAST_WORKSPACE_LS_KEY);
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
  } catch {
    /* swallow-ok */
  }
  return false;
}

/**
 * 在首帧工作区绘制前调用（bootstrap 链）。
 * clean：单 draft 叶，不读 map。
 * restore：维 01 迁移一次，shell 只 setShellReady。
 */
export function hydrateWorkspaceShell(): void {
  const root = getCompositionRoot();
  const restore = readRestoreLastWorkspace();
  const treeStore = root.tree.getState();

  if (!restore) {
    applySafeCleanColdStart();
    root.shell.setShellReady(true);
    return;
  }

  const migrate = resolveMigrateFn();
  const map = loadLegacyOpenTabsMap();
  const sessions = root.layout.getSessions() || [];
  const resolveMeta = (id: string) => {
    const s =
      sessions.find((x) => x.id === id) ?? getSessionById(id) ?? undefined;
    if (!s) return undefined;
    return { title: s.title, workspaceKey: s.folder };
  };

  if (migrate) {
    const result = migrate({
      tree: treeStore.tree,
      openTabsMap: map,
      activeLeafId: treeStore.activeLeafId,
      resolveMeta,
    });
    if (!result.ok) {
      if (import.meta.env?.DEV) {
        console.warn(
          '[hydrateWorkspaceShell] migrate failed:',
          result.reason,
          '→ clean single chat'
        );
      }
      applySafeCleanColdStart();
      root.shell.setShellReady(true);
      clearLegacyOpenTabsMap();
      return;
    }
    treeStore.setTree(result.tree);
  }

  // 冷启动自愈扫描：确保全树所有拥有 Tab 的 ChatLeaf 均具备有效 activeTabId
  const currentTree = treeStore.tree;
  let hasRepaired = false;
  const listChat = (layoutTreePkg as { listChatLeaves?: (root: unknown) => Array<{ id: string; tabs: Array<{ tabId: string }>; activeTabId?: string }> })
    .listChatLeaves;
  const chatLeaves = typeof listChat === 'function' ? listChat(currentTree.root) : [];
  for (const leaf of chatLeaves) {
    if (leaf.tabs && leaf.tabs.length > 0 && !leaf.activeTabId) {
      const firstId = leaf.tabs[0]?.tabId;
      if (firstId) {
        leaf.activeTabId = firstId;
        hasRepaired = true;
      }
    }
  }
  if (hasRepaired) {
    treeStore.setTree({ ...currentTree });
  }

  // 首屏对齐全局会话与活动叶
  const activeLeafId = treeStore.activeLeafId || chatLeaves[0]?.id;
  if (activeLeafId) {
    const activeLeaf = chatLeaves.find((l) => l.id === activeLeafId);
    const activeTabId = activeLeaf?.activeTabId || activeLeaf?.tabs?.[0]?.tabId;
    if (activeLeaf && activeTabId) {
      root.shell.activateTab(activeLeaf.id, activeTabId);
    }
  }

  // 遍历所有 ChatLeaf 的首选活动 Tab，自动预流水合（消除刷新后空屏）。
  // ACT-406 / REDLINE-406：激活叶同步水合；非激活叶经 staggeredIdleQueue
  // 串行时间切片，根除多分屏同步并发 trigger 惊群。
  for (const leaf of chatLeaves as Array<{ id: string; tabs?: Array<{ tabId: string; sessionId?: string }>; activeTabId?: string }>) {
    const activeTab = leaf.tabs?.find((t) => t.tabId === leaf.activeTabId) || leaf.tabs?.[0];
    if (!activeTab?.sessionId || isPendingDraft(activeTab.sessionId)) {
      continue;
    }

    if (leaf.id === activeLeafId) {
      triggerSessionMessageHydrateIfNeeded(activeTab.sessionId);
    } else {
      const targetSessionId = activeTab.sessionId;
      staggeredIdleQueue
        .enqueue(
          async () => {
            await triggerSessionMessageHydrateIfNeeded(targetSessionId);
          },
          { name: `hydrate-pane-${leaf.id}`, priority: 1 }
        )
        .catch(() => {
          /* 非激活分片水合失败不阻断 shell 就绪 */
        });
    }
  }

  clearLegacyOpenTabsMap();
  root.shell.setShellReady(true);
}

export function setRestoreLastWorkspace(value: boolean): void {
  try {
    localStorage.setItem(
      RESTORE_LAST_WORKSPACE_LS_KEY,
      value ? 'true' : 'false'
    );
  } catch {
    /* swallow-ok */
  }
  const prev = (getSettingsState().appSettings || {}) as Record<string, unknown>;
  const ui = {
    ...((prev.ui as object) || {}),
    restoreLastWorkspace: value,
  };
  getSettingsState().setAppSettings({
    ...prev,
    [RESTORE_KEY]: value,
    ui,
  } as Settings);
}
