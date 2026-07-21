import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import styles from './Sidebar.module.css';
import { Tooltip } from './settings/SettingsUI';
import { useLayoutStore } from '../store/layoutStore';
import { useSidebarSessions } from '../store/sessionStore';
import {
  canUseDemoMode,
  getAppMode,
  isDemoMode,
  switchAppMode,
} from '../api/appMode';
import {
  getActiveProjectId,
  listProjects,
  type ProjectEntry,
} from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  sessionListDisplayTitle,
} from '../api/sessionTitle';
import { getSessionStoreState } from '../api/storeAccess';
import { SettingsQuickMenu } from './SettingsQuickMenu';
import { isUpdateAvailable } from '../api/updateStore';
import { clearAgentPanelFocus } from '../api/openAgentPanel';
import { emitUiEvent, onUiEvent } from '../api/uiEvents';
import { SidebarNav } from './sidebar/SidebarNav';
import { SidebarSessionList } from './sidebar/SidebarSessionList';
import {
  SidebarContextMenus,
  archiveUndoToastMessage,
  branchUndoToastMessage,
  BRANCH_TITLE_SUFFIX,
  clampContextMenuPosition,
  type SessionContextMenuState,
  type SessionMenuAction,
} from './sidebar/SidebarContextMenus';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { configService } from '../services/ConfigService';
import { Menu, RefreshCw } from 'lucide-react';

/** 侧栏宽度合法区间（与拖拽 / 键盘步进共用） */
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 360;
const SIDEBAR_WIDTH_DEFAULT = 260;
const SIDEBAR_RESIZE_STEP = 12;
const SIDEBAR_RESIZE_STEP_LARGE = 24;

interface SidebarProps {
  onShowToast: ShowToastFn;
  hoverExpanded?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  /** 顶栏搜索：过滤会话标题与消息正文等（见 sessionSearch）。 */
  searchQuery?: string;
  searchInput?: string;
  onSearchChange?: (val: string) => void;
}

const SIDEBAR_LIST_PREFS_KEY = 'crish_sidebar_list_prefs';

type SortType = 'active' | 'name';
type GroupType = 'folder' | 'none';
type FilterType = 'all' | 'pinned';

interface SidebarListPrefs {
  sortType: SortType;
  groupType: GroupType;
  filterType: FilterType;
}

const DEFAULT_LIST_PREFS: SidebarListPrefs = {
  sortType: 'active',
  groupType: 'folder',
  filterType: 'all',
};

/** 从 localStorage 安全读取侧栏排序/分组/筛选偏好 */
function loadSidebarListPrefs(): SidebarListPrefs {
  try {
    const raw = localStorage.getItem(SIDEBAR_LIST_PREFS_KEY);
    if (!raw) return { ...DEFAULT_LIST_PREFS };
    const parsed = JSON.parse(raw) as Partial<SidebarListPrefs>;
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

/**
 * 在新窗口打开会话只读快照（与 AgentCard.openAgentInNewWindow 一致）。
 * 完整交互式多窗口依赖独立 Webview；此处先提供可读副本。
 */
function openSessionInNewWindow(session: {
  title?: string;
  messages?: Array<{
    sender?: string;
    text?: string;
    status?: string;
    toolCalls?: Array<{ name?: string; status?: string; output?: string }>;
  }>;
}): void {
  const w = window.open(
    '',
    '_blank',
    'noopener,noreferrer,width=960,height=800'
  );
  if (!w) return;
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const title = sessionListDisplayTitle(session);
  const lines: string[] = [];
  lines.push(`<h1>${esc(title)}</h1>`);
  lines.push(
    `<p class="meta">会话只读快照 · ${esc(String(session.messages?.length || 0))} 条消息</p>`
  );
  for (const m of session.messages || []) {
    if (m.sender === 'user') {
      lines.push(`<div class="u">${esc(m.text || '')}</div>`);
    } else {
      lines.push(
        `<div class="a">${esc(m.text || (m.status === 'processing' ? '生成中…' : ''))}</div>`
      );
      for (const tc of m.toolCalls || []) {
        lines.push(
          `<div class="t"><b>${esc(tc.name || 'tool')}</b> ${esc(tc.status || '')}<pre>${esc(
            (tc.output || '').slice(0, 2000)
          )}</pre></div>`
        );
      }
    }
  }
  if (!(session.messages && session.messages.length)) {
    lines.push('<p class="meta">（暂无消息）</p>');
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;padding:20px;max-width:800px;margin:0 auto;color:#222;background:#fafafa}
h1{font-size:18px;margin:0 0 8px}.meta{color:#888;font-size:12px;margin:0 0 20px}
.u{background:#e8eef8;padding:10px 12px;border-radius:12px;margin:10px 0 10px auto;max-width:85%;width:fit-content;white-space:pre-wrap}
.a{background:#fff;border:1px solid #eee;padding:10px 12px;border-radius:12px;margin:10px 0;white-space:pre-wrap}
.t{font-size:12px;color:#666;margin:6px 0 6px 8px}pre{white-space:pre-wrap;font-size:11px;background:#f4f4f5;padding:8px;border-radius:6px}
</style></head><body>${lines.join('\n')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  try {
    w.addEventListener('load', revoke, { once: true });
  } catch {
    /* ignore */
  }
  w.location.href = url;
  window.setTimeout(revoke, 60_000);
}

/**
 * 侧栏壳层设计要点（与 Claude 区分）：
 * - 主 CTA 为轻量描边胶囊，非实心品牌条
 * - 导航文案安静；分区标签为 microcaps
 * - 项目 = 文件夹；未分组时对话为扁平最近列表
 * - 底栏：设置 + 可选开发模式芯片，无网关营销文案
 * - 新建仅走 store.createSession（复用空壳，防幽灵会话）
 */
export const Sidebar: React.FC<SidebarProps> = React.memo(
  ({
    onShowToast,
    hoverExpanded,
    onHoverEnter,
    onHoverLeave,
    searchQuery = '',
    searchInput = '',
    onSearchChange,
  }) => {
    // zustand v5 需 traditional equality：无搜索忽略正文流式，有搜索退回引用比较
    const searchTrimmed = searchQuery.trim();
    const isSearching = searchTrimmed.length > 0;
    const sessions = useSidebarSessions(isSearching);
    const activeSessionId = useLayoutStore((s) => s.activeSessionId);
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
    const setActiveSessionId = useLayoutStore((s) => s.setActiveSessionId);
    const createSession = useLayoutStore((s) => s.createSession);
    const pinSession = useLayoutStore((s) => s.pinSession);
    const unpinSession = useLayoutStore((s) => s.unpinSession);
    const archiveSession = useLayoutStore((s) => s.archiveSession);
    const unarchiveSession = useLayoutStore((s) => s.unarchiveSession);
    const branchSession = useLayoutStore((s) => s.branchSession);
    const renameSession = useLayoutStore((s) => s.renameSession);
    const splitScreenWorkspace = useLayoutStore((s) => s.splitScreenWorkspace);
    const moveSessionRealtime = useLayoutStore((s) => s.moveSessionRealtime);

    const [contextMenu, setContextMenu] =
      useState<SessionContextMenuState | null>(null);
    const [renamingSessionId, setRenamingSessionId] = useState<string | null>(
      null
    );
    const [activeNav, setActiveNav] = useState('chat');
    const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
    const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
    const [sortDropdownCoords, setSortDropdownCoords] = useState<{
      x: number;
      y: number;
    } | null>(null);
    const [sortType, setSortType] = useState<SortType>(
      () => loadSidebarListPrefs().sortType
    );
    const [groupType, setGroupType] = useState<GroupType>(
      () => loadSidebarListPrefs().groupType
    );
    const [filterType, setFilterType] = useState<FilterType>(
      () => loadSidebarListPrefs().filterType
    );
    const [projects, setProjects] = useState<ProjectEntry[]>(() =>
      listProjects()
    );
    const [, setActiveProjectId] = useState<string | null>(() =>
      getActiveProjectId()
    );
    const [collapsedProjects, setCollapsedProjects] = useState<
      Record<string, boolean>
    >({});
    const [projectsSectionCollapsed, setProjectsSectionCollapsed] =
      useState(false);
    const [generalCollapsed, setGeneralCollapsed] = useState(false);
    const [updateAvailable, setUpdateAvailableState] = useState(() =>
      isUpdateAvailable()
    );
    /** 当前侧栏像素宽（拖拽/键盘同步，供分隔条 a11y） */
    const [sidebarWidthPx, setSidebarWidthPx] = useState(SIDEBAR_WIDTH_DEFAULT);

    const menuRef = useRef<HTMLDivElement>(null);
    const sortMenuRef = useRef<HTMLDivElement>(null);
    const sidebarRef = useRef<HTMLDivElement>(null);
    /** 连点「新对话」防抖：createSession 已复用空壳，仍避免同帧重复 emit */
    const newSessionLockRef = useRef(false);

    // 持久化排序/分组/筛选，刷新后恢复
    useEffect(() => {
      try {
        const prefs: SidebarListPrefs = { sortType, groupType, filterType };
        localStorage.setItem(SIDEBAR_LIST_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* ignore */
      }
    }, [sortType, groupType, filterType]);

    // 再扫：切「仅置顶」时展开置顶区，避免筛完却看不见（与 partition 空壳过滤配合）
    useEffect(() => {
      if (filterType === 'pinned') setPinnedCollapsed(false);
    }, [filterType]);

    useEffect(() => {
      return onUiEvent('project-changed', () => {
        setProjects(listProjects());
        setActiveProjectId(getActiveProjectId());
      });
    }, []);

    const { sidebarBehavior } = useResponsiveLayout();

    const [overlayOpen, setOverlayOpen] = useState(false);

    // 侧栏宽独立于主题/密度；启动恢复用户拖拽宽度
    useEffect(() => {
      try {
        // Restore from ConfigService first
        const layout = configService.get('workspace.layout') as
          { sidebarWidth?: number } | undefined;
        const restoredWidth = layout?.sidebarWidth;
        if (
          typeof restoredWidth === 'number' &&
          restoredWidth >= SIDEBAR_WIDTH_MIN &&
          restoredWidth <= SIDEBAR_WIDTH_MAX
        ) {
          document.documentElement.style.setProperty(
            '--sidebar-width',
            `${restoredWidth}px`
          );
          setSidebarWidthPx(restoredWidth);
          return;
        }
        // Fallback to legacy localStorage
        const raw = localStorage.getItem('crish_sidebar_width');
        const n = raw ? parseInt(raw, 10) : NaN;
        if (
          !Number.isNaN(n) &&
          n >= SIDEBAR_WIDTH_MIN &&
          n <= SIDEBAR_WIDTH_MAX
        ) {
          document.documentElement.style.setProperty(
            '--sidebar-width',
            `${n}px`
          );
          setSidebarWidthPx(n);
        } else {
          const cssW = parseInt(
            getComputedStyle(document.documentElement).getPropertyValue(
              '--sidebar-width'
            ),
            10
          );
          if (!Number.isNaN(cssW) && cssW >= SIDEBAR_WIDTH_MIN) {
            setSidebarWidthPx(Math.min(cssW, SIDEBAR_WIDTH_MAX));
          }
        }
      } catch {
        /* ignore */
      }
    }, []);

    // 保证侧栏收起/展开状态与全局 CSS 变量同步，防拖拽关闭后点击无响应
    useEffect(() => {
      if (document.body.classList.contains('is-resizing')) {
        return;
      }
      if (sidebarCollapsed) {
        document.documentElement.style.setProperty('--sidebar-width', '0px');
      } else {
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${sidebarWidthPx}px`
        );
        window.dispatchEvent(new Event('crish-sidebar-resize'));
      }
    }, [sidebarCollapsed, sidebarWidthPx]);

    useEffect(() => {
      return onUiEvent('update-changed', () => {
        setUpdateAvailableState(isUpdateAvailable());
      });
    }, []);

    useEffect(() => {
      const handleOutsideClick = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setContextMenu(null);
        }
        if (
          sortMenuRef.current &&
          !sortMenuRef.current.contains(e.target as Node)
        ) {
          const sortBtn = (e.target as HTMLElement).closest('.sort-btn');
          if (!sortBtn) setSortDropdownOpen(false);
        }
      };
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setContextMenu(null);
          setSortDropdownOpen(false);
        }
      };
      document.addEventListener('click', handleOutsideClick);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('click', handleOutsideClick);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, []);

    const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
      e.preventDefault();
      setRenamingSessionId(null);
      const { x, y } = clampContextMenuPosition(e.clientX, e.clientY);
      setContextMenu({ x, y, sessionId });
    };

    const handleAction = (action: SessionMenuAction) => {
      if (!contextMenu) return;
      const { sessionId } = contextMenu;
      const targetSession = getSessionStoreState().sessionsById[sessionId];
      setContextMenu(null);
      if (!targetSession) return;

      switch (action) {
        case 'open-current':
          setActiveSessionId(sessionId);
          break;
        case 'open-split':
          setActiveSessionId(sessionId);
          clearAgentPanelFocus();
          splitScreenWorkspace(sessionId);
          break;
        case 'open-new': {
          openSessionInNewWindow(targetSession);
          break;
        }
        case 'rename':
          // 内联重命名；无 toast
          setRenamingSessionId(sessionId);
          break;
        case 'pin':
          // 置顶即时生效，不 toast
          pinSession(sessionId);
          break;
        case 'unpin':
          unpinSession(sessionId);
          break;
        case 'archive': {
          // 归档可撤销：文案与 ChatCard/App 分叉路径同构（已归档: 标题 + Undo）
          const title = sessionListDisplayTitle(targetSession);
          archiveSession(sessionId);
          onShowToast(archiveUndoToastMessage(title), () => {
            unarchiveSession(sessionId);
          });
          break;
        }
        case 'branch': {
          // 分叉可撤销：toast + Undo 归档新分叉并切回原会话（与顶栏/ESC 路径一致）
          const title = sessionListDisplayTitle(targetSession);
          const newTitle = `${title}${BRANCH_TITLE_SUFFIX}`;
          const oldId = sessionId;
          branchSession(sessionId, newTitle);
          const newBranchId = getSessionStoreState().activeSessionId;
          onShowToast(branchUndoToastMessage(title), () => {
            if (newBranchId && newBranchId !== oldId) {
              archiveSession(newBranchId);
            }
            setActiveSessionId(oldId);
          });
          break;
        }
        case 'export': {
          // 成功静默（浏览器下载即反馈）；仅失败 toast。分叉/归档均可导出。
          // sessionExport 冷路径：与 ChatCard 一致，export handler 内 dynamic import
          const session = targetSession;
          void (async () => {
            try {
              const { tryDownloadSessionMarkdown } =
                await import('../api/sessionExport');
              const result = tryDownloadSessionMarkdown(session, new Date(), {
                sessionsById: useLayoutStore.getState().sessionsById,
              });
              if (result.ok === false) {
                onShowToast(result.error || '导出失败');
              }
            } catch {
              onShowToast('导出失败');
            }
          })();
          break;
        }
        default:
          break;
      }
    };

    const persistSidebarWidth = useCallback((px: number) => {
      try {
        localStorage.setItem('crish_sidebar_width', String(px));
        const layout = configService.get('workspace.layout') as {
          sidebarWidth?: number;
        };
        configService.set('workspace.layout', { ...layout, sidebarWidth: px });
      } catch {
        /* ignore */
      }
    }, []);

    const applySidebarWidth = useCallback(
      (px: number, opts?: { persist?: boolean; collapse?: boolean }) => {
        if (opts?.collapse) {
          useLayoutStore.setState({ sidebarCollapsed: true });
          document.documentElement.style.setProperty('--sidebar-width', '0px');
          return;
        }
        const capped = Math.min(
          Math.max(px, SIDEBAR_WIDTH_MIN),
          SIDEBAR_WIDTH_MAX
        );
        useLayoutStore.setState({ sidebarCollapsed: false });
        document.documentElement.style.setProperty(
          '--sidebar-width',
          `${capped}px`
        );
        setSidebarWidthPx(capped);
        window.dispatchEvent(new Event('crish-sidebar-resize'));
        if (opts?.persist !== false) persistSidebarWidth(capped);
      },
      [persistSidebarWidth]
    );

    /**
     * 唯一新建入口：仅 store.createSession（内部复用空壳 + 剪枝同伴，误触不刷幽灵列表）。
     * 不自造 session id、不走 slash/聊天流。标题统一 EMPTY_SESSION_TITLE。
     * 若当前筛「仅置顶」，切回全部，否则新建未置顶会话会被 partition 滤掉、侧栏无反馈。
     * 再扫：展开「对话」区，保证活动空壳在窗口化/折叠后仍可见。
     */
    const handleNewSession = useCallback(() => {
      if (newSessionLockRef.current) return;
      newSessionLockRef.current = true;
      try {
        if (filterType === 'pinned') setFilterType('all');
        setGeneralCollapsed(false);
        // activate 默认 true → 复用同 folder 空壳；无则 mint 一条「新会话」
        createSession({ title: EMPTY_SESSION_TITLE });
        setActiveNav('chat');
        setRenamingSessionId(null);
        emitUiEvent('open-chat');
      } finally {
        // 微任务释放：同一次点击冒泡 / 双击不会叠两次 UI 事件
        queueMicrotask(() => {
          newSessionLockRef.current = false;
        });
      }
    }, [createSession, filterType]);

    const handleCommitRename = useCallback(
      (sessionId: string, title: string) => {
        setRenamingSessionId(null);
        if (!title) return;
        renameSession(sessionId, title);
      },
      [renameSession]
    );

    const handleOpenScheduled = useCallback(() => {
      setActiveNav('scheduled');
      // 主对话区展示定时任务，不进设置页
      emitUiEvent('open-scheduled');
    }, []);

    const handleSelectSession = useCallback(
      (id: string) => {
        setActiveSessionId(id);
        clearAgentPanelFocus();
        setActiveNav('chat');
        setRenamingSessionId(null);
        // 再扫：选中后退出「仅置顶」以外的折叠干扰——若会话未置顶且对话区折叠则展开
        const target = getSessionStoreState().sessionsById[id];
        if (target && !target.isPinned) {
          setGeneralCollapsed(false);
          // 项目会话：展开对应项目组，避免选中却在折叠文件夹里
          if (target.folder) {
            setCollapsedProjects((prev) =>
              prev[target.folder!] ? { ...prev, [target.folder!]: false } : prev
            );
          }
        }
        emitUiEvent('open-chat');
      },
      [setActiveSessionId]
    );

    const handleOpenProject = useCallback((id: string) => {
      setActiveProjectId(id);
      setCollapsedProjects((prev) => ({ ...prev, [id]: false }));
    }, []);

    const handleToggleProjectCollapsed = useCallback((id: string) => {
      setCollapsedProjects((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const handleToggleGeneral = useCallback(() => {
      setGeneralCollapsed((v) => !v);
    }, []);

    const handleTogglePinned = useCallback(() => {
      setPinnedCollapsed((v) => !v);
    }, []);

    const handleToggleProjectsSection = useCallback(() => {
      setProjectsSectionCollapsed((v) => !v);
    }, []);

    const handleAddProject = useCallback(() => {
      emitUiEvent('pick-workspace');
    }, []);

    const handleStartRename = useCallback((id: string) => {
      setRenamingSessionId(id);
    }, []);

    const handleCancelRename = useCallback(() => {
      setRenamingSessionId(null);
    }, []);

    const handleSidebarResizeStart = (e: React.PointerEvent) => {
      e.preventDefault();
      document.body.classList.add('is-resizing');
      const startX = e.clientX;
      const startWidth =
        parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--sidebar-width'
          ),
          10
        ) || SIDEBAR_WIDTH_DEFAULT;
      let isCurrentlyCollapsed = useLayoutStore.getState().sidebarCollapsed;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        let newWidth = startWidth + dx;
        if (newWidth < 80) {
          if (!isCurrentlyCollapsed) {
            isCurrentlyCollapsed = true;
            useLayoutStore.setState({ sidebarCollapsed: true });
          }
          document.documentElement.style.setProperty('--sidebar-width', '0px');
        } else {
          if (newWidth > SIDEBAR_WIDTH_MAX) newWidth = SIDEBAR_WIDTH_MAX;
          if (isCurrentlyCollapsed) {
            isCurrentlyCollapsed = false;
            useLayoutStore.setState({ sidebarCollapsed: false });
          }
          document.documentElement.style.setProperty(
            '--sidebar-width',
            `${newWidth}px`
          );
          window.dispatchEvent(new Event('crish-sidebar-resize'));
        }
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        document.body.classList.remove('is-resizing');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        const finalWidth = startWidth + (upEvent.clientX - startX);
        if (finalWidth < 80) {
          applySidebarWidth(0, { collapse: true, persist: false });
        } else {
          applySidebarWidth(finalWidth, { persist: true });
        }
      };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    };

    /** 键盘调整侧栏宽：←/→ 微调，Shift 加大步进，Home/End 到边界 */
    const handleSidebarResizeKeyDown = (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? SIDEBAR_RESIZE_STEP_LARGE : SIDEBAR_RESIZE_STEP;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        applySidebarWidth(sidebarWidthPx - step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        applySidebarWidth(sidebarWidthPx + step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        applySidebarWidth(SIDEBAR_WIDTH_MIN);
      } else if (e.key === 'End') {
        e.preventDefault();
        applySidebarWidth(SIDEBAR_WIDTH_MAX);
      }
    };

    const handleSortBtnClick = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      const btn = e.currentTarget as HTMLElement;
      const rect = btn.getBoundingClientRect();
      setSortDropdownCoords({ x: rect.left, y: rect.top + rect.height + 4 });
      setSortDropdownOpen((open) => !open);
    }, []);

    /** 折叠且非悬停展开：对读屏隐藏壳层，避免焦点进不可见控件 */
    const chromeHidden = Boolean(sidebarCollapsed && !hoverExpanded);

    /** 顶栏搜索状态：侧栏壳层播报（搜索输入在顶栏，结果在此） */
    const searchStatusText = useMemo(() => {
      if (!isSearching) return '';
      const q =
        searchTrimmed.length > 24
          ? `${searchTrimmed.slice(0, 24)}…`
          : searchTrimmed;
      return `正在筛选会话：${q}`;
    }, [isSearching, searchTrimmed]);

    const filterLabel = filterType === 'pinned' ? '仅置顶' : '全部会话';
    const densityHint = isSearching
      ? 'search'
      : filterType === 'pinned'
        ? 'pinned'
        : 'default';

    const handleOverlayClose = useCallback(() => {
      setOverlayOpen(false);
      setSidebarCollapsed(true);
    }, [setSidebarCollapsed]);

    const handleHamburgerClick = useCallback(() => {
      if (sidebarBehavior === 'overlay') {
        setOverlayOpen(true);
        setSidebarCollapsed(false);
      } else {
        setSidebarCollapsed(!sidebarCollapsed);
      }
    }, [sidebarBehavior, sidebarCollapsed, setSidebarCollapsed]);

    const isOverlayActive = sidebarBehavior === 'overlay' && overlayOpen;

    return (
      <>
        {/* Hamburger toggle — always visible in overlay mode */}
        {sidebarBehavior === 'overlay' && (
          <button
            type="button"
            className={`${styles.hamburger} ${isOverlayActive ? styles.hamburgerActive : ''}`}
            aria-label={isOverlayActive ? '关闭侧栏菜单' : '打开侧栏菜单'}
            aria-expanded={isOverlayActive}
            onClick={handleHamburgerClick}
          >
            <Menu size={18} strokeWidth={1.75} aria-hidden />
          </button>
        )}

        {/* Overlay backdrop */}
        {isOverlayActive && (
          <div
            className={styles.overlayBackdrop}
            aria-hidden="true"
            onClick={handleOverlayClose}
          />
        )}

        <aside
          ref={sidebarRef}
          className={`${styles.sidebar} crish-sidebar ${sidebarCollapsed ? styles.collapsed : ''} ${hoverExpanded ? styles.tempExpanded : ''} ${isOverlayActive ? styles.overlay : ''} ${sidebarBehavior === 'icon-collapse' && !isOverlayActive ? styles.iconCollapse : ''}`}
          role="navigation"
          aria-label="侧栏导航"
          data-sidebar-filter={filterType}
          data-sidebar-density={densityHint}
          data-searching={isSearching ? '1' : '0'}
          data-sidebar-collapsed={sidebarCollapsed ? '1' : '0'}
          data-sidebar-behavior={sidebarBehavior}
          onMouseEnter={onHoverEnter}
          onMouseLeave={onHoverLeave}
        >
          {/* 顶栏搜索结果状态：输入在 header，读屏在此同步播报（无 sr-only token，clip 隐藏） */}
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            {searchStatusText}
            {!isSearching && filterType === 'pinned'
              ? `筛选：${filterLabel}`
              : null}
          </div>

          {/* 折叠且非悬停时隐藏主 chrome，分隔条仍可键盘操作以展开 */}
          <div
            className={styles.sidebarTop}
            aria-hidden={chromeHidden || undefined}
            inert={chromeHidden ? true : undefined}
            role="group"
            aria-label="侧栏快捷操作：新建对话与定时任务"
          >
            <SidebarNav
              activeNav={activeNav}
              onNewSession={handleNewSession}
              onOpenScheduled={handleOpenScheduled}
              searchInput={searchInput}
              onSearchChange={onSearchChange}
            />
          </div>

          <div
            className={styles.sidebarScroll}
            data-sidebar-chrome="scroll"
            aria-hidden={chromeHidden || undefined}
            inert={chromeHidden ? true : undefined}
          >
            <SidebarSessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              searchQuery={searchQuery}
              sortType={sortType}
              groupType={groupType}
              filterType={filterType}
              projects={projects}
              collapsedProjects={collapsedProjects}
              generalCollapsed={generalCollapsed}
              pinnedCollapsed={pinnedCollapsed}
              projectsSectionCollapsed={projectsSectionCollapsed}
              renamingSessionId={renamingSessionId}
              onSelectSession={handleSelectSession}
              onContextMenuSession={handleContextMenu}
              onToggleProjectCollapsed={handleToggleProjectCollapsed}
              onToggleGeneral={handleToggleGeneral}
              onTogglePinned={handleTogglePinned}
              onToggleProjectsSection={handleToggleProjectsSection}
              onOpenProject={handleOpenProject}
              onSortBtnClick={handleSortBtnClick}
              onNewSession={handleNewSession}
              onAddProject={handleAddProject}
              onMoveSessionRealtime={moveSessionRealtime}
              onStartRename={handleStartRename}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
            />
          </div>

          <div
            className={styles.sidebarFooter}
            role="contentinfo"
            aria-label="侧栏底栏"
            aria-hidden={chromeHidden || undefined}
            inert={chromeHidden ? true : undefined}
          >
            {canUseDemoMode() && (
              <Tooltip content="开发切换：正式 / 演示 (正式包不会出现)">
                <button
                  type="button"
                  className={`${styles.modeChip} ${isDemoMode() ? styles.isDemo : ''}`}
                  aria-label={
                    isDemoMode()
                      ? '当前演示模式，点击切换为正式'
                      : '当前正式模式，点击切换为演示'
                  }
                  aria-pressed={isDemoMode()}
                  onClick={() => {
                    const next = getAppMode() === 'demo' ? 'normal' : 'demo';
                    switchAppMode(next);
                  }}
                >
                  {isDemoMode() ? '演示' : '正式'}
                </button>
              </Tooltip>
            )}
            <div className={styles.footerActions}>
              <SettingsQuickMenu onShowToast={onShowToast} />
              {updateAvailable ? (
                <Tooltip content="有新版本，点击安装更新">
                  <button
                    type="button"
                    className={`${styles.footerUpdate} ${styles.isVisible}`}
                    aria-label="安装更新"
                    onClick={() => {
                      void (async () => {
                        const { applyUpdateWhenIdle } =
                          await import('../api/updateStore');
                        const r = await applyUpdateWhenIdle();
                        onShowToast?.(r.message);
                        if (r.ok) setUpdateAvailableState(false);
                      })();
                    }}
                  >
                    <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
                    <span className={styles.footerUpdateLabel}>更新</span>
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>

          <div
            className={styles.sidebarResizer}
            id="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            aria-valuenow={sidebarCollapsed ? 0 : sidebarWidthPx}
            aria-valuetext={
              sidebarCollapsed ? '已收起' : `侧栏宽度 ${sidebarWidthPx} 像素`
            }
            tabIndex={0}
            onPointerDown={handleSidebarResizeStart}
            onKeyDown={handleSidebarResizeKeyDown}
            style={{ touchAction: 'none' }}
          />

          <SidebarContextMenus
            menuRef={menuRef}
            sortMenuRef={sortMenuRef}
            contextMenu={contextMenu}
            onSessionAction={handleAction}
            sortDropdownOpen={sortDropdownOpen}
            sortDropdownCoords={sortDropdownCoords}
            sortType={sortType}
            groupType={groupType}
            filterType={filterType}
            onSetSortType={setSortType}
            onSetGroupType={setGroupType}
            onSetFilterType={setFilterType}
            onCloseSortDropdown={() => setSortDropdownOpen(false)}
            onCloseContextMenu={() => setContextMenu(null)}
          />
        </aside>
      </> /* end overlay fragment */
    );
  }
);

Sidebar.displayName = 'Sidebar';
