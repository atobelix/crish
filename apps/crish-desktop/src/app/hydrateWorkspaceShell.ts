/**
 * 冷启动门闩：默认 clean 单 chat；设置可 restore 上次 workspace（含 multi-unit）。
 *
 * Policy (D-D / S3):
 * - Default OFF → safe single-chat clean (never force multi-unit restore)
 * - Opt-in `ui.restoreLastWorkspace` → restore tree + tabs when tree validates
 * - Opt-in + invalid/corrupt multi-unit tree → same clean fallback
 *
 * @see analysis/shell_workspace_redesign.md §4.6.1
 * @see docs/architecture/multi-unit-layout-restore-adr.md
 */

import {
  loadLegacyOpenTabsMap,
  ensureAdapterShape,
  ensureChatOnlyTree,
} from '../store/workspace-shell';
import {
  validateRestorableLayoutTree,
  syncShellDocksFromTree,
  listBoundSessionIdsFromTree,
  applySafeCleanColdStart,
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
} from '../store/workspace-shell/layoutRestorePolicy';
import { getSessionById } from '../store/sessionStore';
import { listChatLeaves } from '../store/layout-tree';
import { getCompositionRoot } from './compositionRoot';
import { getSettingsState } from '../store/storeAccess';
import type { Settings } from '../api/clientApi';

/** @deprecated use RESTORE_LAST_WORKSPACE_SETTING_KEY — kept for call-site clarity. @see RESTORE_LAST_WORKSPACE_SETTING_KEY */
const RESTORE_KEY = RESTORE_LAST_WORKSPACE_SETTING_KEY;

export function readRestoreLastWorkspace(): boolean {
  try {
    // 优先 appSettings（经 compositionRoot.layout）
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
    /* swallow-ok: 恢复开关读取失败时回退默认 clean 启动 */
  }
  return false; // 默认 clean
}

/**
 * 在首帧工作区绘制前调用（bootstrap 链）。
 * 保证 clean 模式不会闪现多 leaf 脏布局；restore 仅在树校验通过时保留 multi-unit。
 */
export function hydrateWorkspaceShell(): void {
  const root = getCompositionRoot();
  const restore = readRestoreLastWorkspace();
  const shell = root.shell.getState();
  // layout-tree via compositionRoot.tree（≠ root.layout / layoutStore）
  const treeStore = root.tree.getState();

  if (!restore) {
    applySafeCleanColdStart();
    root.shell.setShellReady(true);
    return;
  }

  // restore opt-in：校验持久化树；失败则安全单 chat
  const verdict = validateRestorableLayoutTree(treeStore.tree);
  if (!verdict.ok) {
    if (import.meta.env?.DEV) {
      console.warn(
        '[hydrateWorkspaceShell] restore rejected:',
        verdict.reason,
        '→ clean single chat'
      );
    }
    applySafeCleanColdStart();
    root.shell.setShellReady(true);
    return;
  }

  // 有效树：归一 adapter（不折叠 multi），再恢复 tabs
  ensureAdapterShape();
  const map = loadLegacyOpenTabsMap();
  const known = new Map<string, { title?: string; folder?: string }>();
  const sessions = root.layout.getSessions() || [];
  for (const s of sessions) {
    known.set(s.id, { title: s.title, folder: s.folder });
  }
  for (const id of Object.keys(map).flatMap((k) => map[k] || [])) {
    if (!known.has(id)) {
      const s = getSessionById(id);
      if (s) known.set(s.id, { title: s.title, folder: s.folder });
    }
  }
  // 树内已绑定 session 也记入 known（map 不全时仍能建 tab）
  for (const sid of listBoundSessionIdsFromTree(treeStore.tree)) {
    if (!known.has(sid)) {
      const s = getSessionById(sid);
      if (s) known.set(sid, { title: s.title, folder: s.folder });
      else known.set(sid, {});
    }
  }

  if (Object.keys(map).length) {
    // 勿用默认 collapsed dock 投影到已恢复的 multi-unit 树
    shell.migrateFromOpenTabsMap(map, known, { projectActiveDock: false });
  } else {
    // 无 open-tabs map：按树内绑定 session 建 tabs，或 clean draft
    const bound = listBoundSessionIdsFromTree(root.tree.getState().tree);
    if (bound.length === 0) {
      shell.resetToCleanDraft();
      // reset 会 ensureChatOnlyTree：单 chat 无 session 时保留单 leaf
      ensureChatOnlyTree();
    } else {
      // workspaceKey：优先 known.folder，否则 general
      const byFolder: Record<string, string[]> = {};
      for (const sid of bound) {
        const meta = known.get(sid);
        const fk = (meta?.folder || '').trim() || '__general__';
        if (!byFolder[fk]) byFolder[fk] = [];
        byFolder[fk]!.push(sid);
      }
      shell.migrateFromOpenTabsMap(byFolder, known, {
        projectActiveDock: false,
      });
    }
  }

  // 从树反推每个 tab 的 rightDock（保留 multi-unit 坞状态元数据）
  const restoredTree = root.tree.getState().tree;
  syncShellDocksFromTree(restoredTree);
  ensureAdapterShape();

  // 多 unit 时全局 toolColumnCollapsed 不应藏邻居 tool
  const chats = listChatLeaves(restoredTree.root);
  if (chats.length > 1) {
    root.tree.getState().setToolColumnCollapsed(false);
  }

  root.shell.setShellReady(true);
}

/** 供设置页写入 */
export function setRestoreLastWorkspace(value: boolean): void {
  try {
    localStorage.setItem(
      RESTORE_LAST_WORKSPACE_LS_KEY,
      value ? 'true' : 'false'
    );
  } catch {
    /* swallow-ok: 恢复开关写失败仅影响下次启动还原 */
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
