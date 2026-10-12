import { sessionListDisplayTitle } from '../../api/sessionTitle';
import {
  readSidebarListPrefsCache,
  readSidebarSectionsCache,
  writeSidebarListPrefsCache,
  writeSidebarSectionsCache,
  RUNTIME_CACHE_KEYS,
} from '../../api/cache/runtimeCache';

/**
 * 例外声明（T05.5.1 tokens 唯一源）：
 * buildSessionPreviewHtml 输出的内联 <style> 是独立 HTML 文档（Blob 独立上下文），
 * 不继承应用 CSS 变量，其中的 hex 属预览模板数据，不做 token 化。
 */

/** 展开态钳制下限（参考 [160, 480]；默认宽仍走产品 260） */
export const SIDEBAR_WIDTH_MIN = 160;
/** 展开态钳制上限 */
export const SIDEBAR_WIDTH_MAX = 480;
/** 产品默认宽（双击重置；不要改成演示 240） */
export const SIDEBAR_WIDTH_DEFAULT = 260;
/** 拖过此宽度折叠侧栏 */
export const SIDEBAR_COLLAPSE_PX = 120;
/** 侧栏分割条命中宽度 */
export const SIDEBAR_RESIZER_HIT_PX = 6;
export const SIDEBAR_RESIZE_STEP = 12;
export const SIDEBAR_RESIZE_STEP_LARGE = 24;

/** 展开态宽度钳到 [MIN, MAX]；非有限值回落到默认宽 */
export function clampSidebarExpandedWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(Math.max(px, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX);
}

/** 拖动中宽度低于折叠阈值 → 收起 */
export function shouldCollapseSidebar(widthPx: number): boolean {
  return Number.isFinite(widthPx) && widthPx < SIDEBAR_COLLAPSE_PX;
}

export const SIDEBAR_LIST_PREFS_KEY = RUNTIME_CACHE_KEYS.SIDEBAR_LIST_PREFS;
/** 侧栏分区折叠状态（pinned / general / projects / 各 projectId） */
export const SIDEBAR_SECTIONS_KEY = RUNTIME_CACHE_KEYS.SIDEBAR_SECTIONS;

export type SortType = 'active' | 'name';
export type GroupType = 'folder' | 'none';
export type FilterType = 'all' | 'pinned';

export interface SidebarListPrefs {
  sortType: SortType;
  groupType: GroupType;
  filterType: FilterType;
}

export interface SidebarSectionsState {
  pinned: boolean;
  general: boolean;
  projects: boolean;
  projectIds: Record<string, boolean>;
}

const DEFAULT_LIST_PREFS: SidebarListPrefs = {
  sortType: 'active',
  groupType: 'folder',
  filterType: 'all',
};

const DEFAULT_SECTIONS_STATE: SidebarSectionsState = {
  pinned: false,
  general: false,
  projects: false,
  projectIds: {},
};

export function loadSidebarListPrefs(): SidebarListPrefs {
  try {
    const parsed = readSidebarListPrefsCache<Partial<SidebarListPrefs> | null>(
      null
    );
    if (!parsed) return { ...DEFAULT_LIST_PREFS };
    return {
      sortType:
        parsed.sortType === 'name' || parsed.sortType === 'active'
          ? parsed.sortType
          : DEFAULT_LIST_PREFS.sortType,
      groupType:
        parsed.groupType === 'none' || parsed.groupType === 'folder'
          ? parsed.groupType
          : DEFAULT_LIST_PREFS.groupType,
      filterType:
        parsed.filterType === 'pinned' || parsed.filterType === 'all'
          ? parsed.filterType
          : DEFAULT_LIST_PREFS.filterType,
    };
  } catch {
    return { ...DEFAULT_LIST_PREFS };
  }
}

export function loadSidebarSectionsState(): SidebarSectionsState {
  try {
    const parsed =
      readSidebarSectionsCache<Partial<SidebarSectionsState> | null>(null);
    if (!parsed) return { ...DEFAULT_SECTIONS_STATE, projectIds: {} };
    const projectIds =
      parsed.projectIds &&
      typeof parsed.projectIds === 'object' &&
      !Array.isArray(parsed.projectIds)
        ? (parsed.projectIds as Record<string, boolean>)
        : {};
    return {
      pinned: Boolean(parsed.pinned),
      general: Boolean(parsed.general),
      projects: Boolean(parsed.projects),
      projectIds,
    };
  } catch {
    return { ...DEFAULT_SECTIONS_STATE, projectIds: {} };
  }
}

export function saveSidebarSectionsState(state: SidebarSectionsState): void {
  try {
    writeSidebarSectionsCache(state);
  } catch {
    /* ignore quota / private mode */
  }
}

export function saveSidebarListPrefs(prefs: SidebarListPrefs): void {
  try {
    writeSidebarListPrefsCache(prefs);
  } catch {
    /* ignore quota / private mode */
  }
}

function isTauriRuntime(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
    );
  } catch {
    return false;
  }
}

export function buildSessionWindowLabel(sessionId: string): string {
  const clean = (sessionId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `session-${clean || 'view'}`;
}

export function buildSessionWindowUrl(sessionId: string): string {
  const sid = (sessionId || '').trim();
  if (!sid) return '/';
  return `/?session=${encodeURIComponent(sid)}`;
}

/**
 * 在新窗口打开会话：
 * - Tauri 桌面端：创建独立原生 WebviewWindow（若该会话窗口已打开则直接还原并聚焦），
 *   通过 `/?session=<id>` 路由冷启动完整交互式工作台并定焦到该会话；
 * - 浏览器环境：通过 `window.open('/?session=<id>')` 打开独立完整工作台窗口。
 */
export function openSessionInNewWindow(session: {
  id?: string;
  title?: string;
  messages?: Array<{
    sender?: string;
    text?: string;
    status?: string;
    toolCalls?: Array<{ name?: string; status?: string; output?: string }>;
  }>;
}): void {
  const sessionId = (session.id || '').trim();
  const title = sessionListDisplayTitle(session);
  const label = buildSessionWindowLabel(sessionId || title);
  const targetUrl = buildSessionWindowUrl(sessionId);

  if (isTauriRuntime() && sessionId) {
    void (async () => {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
          await existing.unminimize().catch(() => {
            /* swallow-ok: window might not be minimized */
          });
          await existing.show().catch(() => {
            /* swallow-ok: window might already be shown */
          });
          await existing.setFocus().catch(() => {
            /* swallow-ok: window focus might fail silently */
          });
          return;
        }
        const win = new WebviewWindow(label, {
          url: targetUrl,
          title: `Crish — ${title}`,
          width: 1200,
          height: 820,
          minWidth: 960,
          minHeight: 640,
          resizable: true,
          decorations: false,
          dragDropEnabled: true,
          visible: false,
          transparent: true,
        });
        win.once('tauri://created', () => {
          window.setTimeout(() => {
            void win.show().catch(() => {
              /* swallow-ok: window already shown or destroyed */
            });
            void win.setFocus().catch(() => {
              /* swallow-ok: focus attempt */
            });
          }, 1000);
        });
        win.once('tauri://error', () => {
          window.open(
            targetUrl,
            label,
            'noopener,noreferrer,width=1200,height=820'
          );
        });
      } catch {
        window.open(
          targetUrl,
          label,
          'noopener,noreferrer,width=1200,height=820'
        );
      }
    })();
    return;
  }

  window.open(targetUrl, label, 'noopener,noreferrer,width=1200,height=820');
}
