/**
 * 工作区右侧面板布局快照：按项目路径持久化到 localStorage。
 * key: crish_workspace_layout_v1 → Record<projectPath, LayoutSnapshot>
 *
 * - 保存：列宽比、组高比、卡片 id 顺序、activeCard
 * - 恢复：打开项目时 apply；同会话内用户已改过布局则不覆盖（sessionStorage）
 */

import type { WorkspaceState } from '../store/types';

export type LayoutSnapshot = {
  columns: Array<{
    widthRatio: number;
    groups: Array<{ heightRatio: number; cards: string[]; activeCardId: string }>;
  }>;
  savedAt: number;
};

const STORAGE_KEY = 'crish_workspace_layout_v1';
/** 本会话内用户已自定义过布局的项目路径（避免 project-changed 重复还原覆盖） */
const SESSION_CUSTOMIZED_KEY = 'crish_ws_layout_session_customized_v1';
/** 本会话最近一次已应用布局的路径 */
const SESSION_APPLIED_KEY = 'crish_ws_layout_session_applied_v1';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

function loadAll(): Record<string, LayoutSnapshot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj as Record<string, LayoutSnapshot>;
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, LayoutSnapshot>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

function loadSessionCustomized(): Record<string, true> {
  try {
    const raw = sessionStorage.getItem(SESSION_CUSTOMIZED_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj as Record<string, true>;
  } catch {
    return {};
  }
}

function saveSessionCustomized(map: Record<string, true>): void {
  try {
    sessionStorage.setItem(SESSION_CUSTOMIZED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 从完整 WorkspaceState 序列化为可持久化快照 */
export function snapshotFromWorkspace(workspace: WorkspaceState): LayoutSnapshot {
  return {
    columns: (workspace.columns || []).map((col) => ({
      widthRatio: typeof col.widthRatio === 'number' && col.widthRatio > 0 ? col.widthRatio : 1,
      groups: (col.groups || []).map((g) => ({
        heightRatio: typeof g.heightRatio === 'number' && g.heightRatio > 0 ? g.heightRatio : 1,
        cards: (g.cards || []).map((c) => c.id).filter(Boolean),
        activeCardId: g.activeCardId || (g.cards?.[0]?.id ?? 'chat'),
      })),
    })),
    savedAt: Date.now(),
  };
}

/** 校验并清洗快照；无效则返回 null */
export function normalizeLayoutSnapshot(raw: unknown): LayoutSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snap = raw as LayoutSnapshot;
  if (!Array.isArray(snap.columns) || snap.columns.length === 0) return null;
  const columns = snap.columns
    .map((col) => {
      if (!col || typeof col !== 'object') return null;
      const groups = Array.isArray(col.groups)
        ? col.groups
            .map((g) => {
              if (!g || typeof g !== 'object') return null;
              const cards = Array.isArray(g.cards)
                ? g.cards.filter((id): id is string => typeof id === 'string' && id.length > 0)
                : [];
              if (cards.length === 0) return null;
              const activeCardId =
                typeof g.activeCardId === 'string' && cards.includes(g.activeCardId)
                  ? g.activeCardId
                  : cards[0]!;
              return {
                heightRatio:
                  typeof g.heightRatio === 'number' && g.heightRatio > 0 ? g.heightRatio : 1,
                cards,
                activeCardId,
              };
            })
            .filter((g): g is NonNullable<typeof g> => g != null)
        : [];
      if (groups.length === 0) return null;
      return {
        widthRatio:
          typeof col.widthRatio === 'number' && col.widthRatio > 0 ? col.widthRatio : 1,
        groups,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (columns.length === 0) return null;
  return {
    columns,
    savedAt: typeof snap.savedAt === 'number' ? snap.savedAt : Date.now(),
  };
}

export function saveLayoutForProject(path: string, workspace: WorkspaceState): boolean {
  const key = normalizePath(path);
  if (!key) return false;
  const snap = snapshotFromWorkspace(workspace);
  if (!normalizeLayoutSnapshot(snap)) return false;
  const all = loadAll();
  all[key] = snap;
  saveAll(all);
  return true;
}

export function loadLayoutForProject(path: string): LayoutSnapshot | null {
  const key = normalizePath(path);
  if (!key) return null;
  const all = loadAll();
  return normalizeLayoutSnapshot(all[key] ?? null);
}

export function hasLayoutForProject(path: string): boolean {
  return loadLayoutForProject(path) != null;
}

export function markLayoutCustomizedThisSession(path: string): void {
  const key = normalizePath(path);
  if (!key) return;
  const map = loadSessionCustomized();
  map[key] = true;
  saveSessionCustomized(map);
}

export function isLayoutCustomizedThisSession(path: string): boolean {
  const key = normalizePath(path);
  if (!key) return false;
  return Boolean(loadSessionCustomized()[key]);
}

export function clearLayoutCustomizedThisSession(path: string): void {
  const key = normalizePath(path);
  if (!key) return;
  const map = loadSessionCustomized();
  if (!map[key]) return;
  delete map[key];
  saveSessionCustomized(map);
}

export function getSessionAppliedLayoutPath(): string {
  try {
    return sessionStorage.getItem(SESSION_APPLIED_KEY) || '';
  } catch {
    return '';
  }
}

export function setSessionAppliedLayoutPath(path: string): void {
  try {
    const key = normalizePath(path);
    if (key) sessionStorage.setItem(SESSION_APPLIED_KEY, key);
    else sessionStorage.removeItem(SESSION_APPLIED_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 是否应在打开项目时恢复布局：
 * - 路径切换：应恢复（用 localStorage 最新快照）
 * - 同路径再次触发：若本会话已自定义则不覆盖
 */
export function shouldRestoreLayoutForProject(path: string): boolean {
  const key = normalizePath(path);
  if (!key) return false;
  const applied = getSessionAppliedLayoutPath();
  if (applied === key) {
    // 同一项目重复事件：用户本会话已改过则跳过
    return !isLayoutCustomizedThisSession(key);
  }
  return true;
}

/**
 * 订阅布局变更自动保存 + 项目切换时保存/恢复。
 * 由 App mount 调用一次；返回 cleanup。
 *
 * 动态 import store，避免与 layoutStore → workspaceActions 形成静态循环依赖。
 */
export function initWorkspaceLayoutSync(opts?: {
  onRestored?: (path: string) => void;
  onSaved?: (path: string) => void;
}): () => void {
  let disposed = false;
  let unsub: (() => void) | null = null;
  let lastPath = '';
  let suppressSave = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let onProject: (() => void) | null = null;

  void Promise.all([
    import('../store/layoutStore'),
    import('./projectStore'),
  ]).then(([{ useLayoutStore }, { getWorkspacePath }]) => {
    if (disposed) return;

    lastPath = normalizePath(getWorkspacePath() || '');

    const flushSave = (path: string) => {
      const key = normalizePath(path);
      if (!key || suppressSave) return;
      const st = useLayoutStore.getState();
      const ws = st.workspaces[st.activeWorkspaceIndex];
      if (!ws) return;
      if (saveLayoutForProject(key, ws)) {
        opts?.onSaved?.(key);
      }
    };

    const scheduleSave = (path: string) => {
      const key = normalizePath(path);
      if (!key || suppressSave) return;
      markLayoutCustomizedThisSession(key);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushSave(key);
      }, 1000);
    };

    const tryRestore = (path: string) => {
      const key = normalizePath(path);
      if (!key) {
        setSessionAppliedLayoutPath('');
        return;
      }
      if (!shouldRestoreLayoutForProject(key)) {
        setSessionAppliedLayoutPath(key);
        return;
      }
      const snap = loadLayoutForProject(key);
      if (!snap) {
        setSessionAppliedLayoutPath(key);
        return;
      }
      suppressSave = true;
      try {
        useLayoutStore.getState().applyWorkspaceLayout(snap);
        setSessionAppliedLayoutPath(key);
        // 刚从快照恢复，不算「用户本会话自定义」
        clearLayoutCustomizedThisSession(key);
        opts?.onRestored?.(key);
      } finally {
        // 等 immer 订阅跑完再放开自动保存
        queueMicrotask(() => {
          suppressSave = false;
        });
      }
    };

    // 启动时：若已有活动项目则尝试恢复
    if (lastPath) {
      tryRestore(lastPath);
    }

    if (disposed) return;

    unsub = useLayoutStore.subscribe((state, prev) => {
      if (suppressSave || disposed) return;
      if (
        state.workspaces === prev.workspaces &&
        state.activeWorkspaceIndex === prev.activeWorkspaceIndex
      ) {
        return;
      }
      const path = getWorkspacePath();
      if (!path) return;
      scheduleSave(path);
    });

    onProject = () => {
      if (disposed) return;
      const newPath = normalizePath(getWorkspacePath() || '');
      // 切换前先落盘旧项目布局（立即，不走 debounce）
      if (lastPath && lastPath !== newPath) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        flushSave(lastPath);
      }
      if (newPath !== lastPath) {
        if (newPath) tryRestore(newPath);
        else setSessionAppliedLayoutPath('');
      }
      lastPath = newPath;
    };

    window.addEventListener('crish-project-changed', onProject);
  });

  return () => {
    disposed = true;
    unsub?.();
    if (onProject) {
      window.removeEventListener('crish-project-changed', onProject);
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
