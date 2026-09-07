import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { SidePanelLauncherHub } from './SidePanelLauncherHub';
import {
  useLayoutStore,
  selectTabModeEnabled,
  openToolInSession,
  openToolInActiveTab,
  getCompositionRoot,
  type LayoutLeaf,
} from '../../store/storeAccess';
import { Tooltip } from '../ui';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import { viewRegistry } from '../../services/view-registry';
import { SidePanelNavToolbar } from './SidePanelNavToolbar';
import {
  TAB_GAP_PX,
  TAB_HEIGHT_PX,
  TOOL_TAB_WIDTH_MAX_PX,
} from '../../utils/tabStripGeometry';
import { DURATION_FAST_MS, readTransitionMs } from '../../utils/motionTokens';
import { useNonPassiveWheel } from '../../hooks/useNonPassiveWheel';
import { useTablistKeyboard } from '../../hooks/useTablistKeyboard';
import { isBrowserTabId, ToolTabFavicon } from './ToolTabFavicon';
import { ToolTabAddButton } from './ToolTabAddButton';
import styles from './LeafToolTabStrip.module.css';

export interface LeafToolTabStripProps {
  leaf?: LayoutLeaf;
  leafId?: string;
  sessionId?: string | null;
  /** 本叶 active SessionTab.tabId，写坞用 */
  sessionTabId?: string;
  tabs?: string[];
  activeTab?: string;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onAddTab?: (panelId: string) => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
  showNavToolbar?: boolean;
  className?: string;
}

type DockPatch = {
  collapsed?: boolean;
  openPanelIds?: string[];
  activePanelId?: string | null;
};

function updateTabDock(tabId: string, patch: DockPatch): void {
  const fn = (
    getCompositionRoot().shell as unknown as {
      updateTabDock?: (id: string, p: DockPatch) => void;
    }
  ).updateTabDock;
  fn?.(tabId, patch);
}

function readDockFromLeaf(leaf: LayoutLeaf | undefined): {
  openPanelIds: string[];
  activePanelId: string;
  sessionId: string | null;
  sessionTabId: string;
} | null {
  if (!leaf) return null;
  const raw = leaf.tabs as unknown;
  if (!Array.isArray(raw)) return null;
  const sessionTabs = raw.filter(
    (t): t is { tabId: string; sessionId: string; dock?: { openPanelIds?: string[]; activePanelId?: string | null } } =>
      typeof t === 'object' && t !== null && typeof (t as { tabId?: string }).tabId === 'string'
  );
  if (sessionTabs.length === 0) return null;
  const activeTabId = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  const tab =
    sessionTabs.find((t) => t.tabId === activeTabId) ?? sessionTabs[0];
  if (!tab) return null;
  return {
    openPanelIds: tab.dock?.openPanelIds ?? [],
    activePanelId: tab.dock?.activePanelId ?? '',
    sessionId: tab.sessionId ?? null,
    sessionTabId: tab.tabId,
  };
}

export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
  ({
    leaf,
    leafId: propLeafId,
    sessionId: propSessionId,
    sessionTabId: propSessionTabId,
    tabs: propTabs,
    activeTab: propActiveTab,
    onSelectTab,
    onCloseTab,
    onAddTab,
    onToggleMaximize,
    isMaximized: propIsMaximized,
    showNavToolbar,
    className,
  }) => {
    const dockFromLeaf = readDockFromLeaf(leaf);
    const leafId = propLeafId ?? leaf?.id ?? '';
    const sessionId = propSessionId ?? dockFromLeaf?.sessionId ?? null;
    const sessionTabId = propSessionTabId ?? dockFromLeaf?.sessionTabId ?? '';
    const rawTabs = propTabs ?? dockFromLeaf?.openPanelIds ?? [];
    const tabs = useMemo(() => rawTabs, [rawTabs]);
    const activeTab =
      propActiveTab ?? dockFromLeaf?.activePanelId ?? (tabs[0] || '');

    const tabModeEnabled = useLayoutStore(selectTabModeEnabled);

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const [isMaximizedLocal, setIsMaximizedLocal] = useState(false);
    const isMaximized =
      propIsMaximized !== undefined ? propIsMaximized : isMaximizedLocal;

    const [hasOverflow, setHasOverflow] = useState(false);
    const [booted, setBooted] = useState(false);
    const closingIdsRef = useRef<Set<string>>(new Set());
    const [closingTabIds, setClosingTabIds] = useState<Set<string>>(
      () => new Set()
    );
    const fuseTimersRef = useRef<Map<string, number>>(new Map());

    const tabsTrackRef = useRef<HTMLDivElement>(null);
    const tabsListRef = useRef<HTMLDivElement>(null);

    // 入场动画门控：与 PaneHeader 同一契约，首轮挂载不重播
    useEffect(() => {
      setBooted(true);
    }, []);

    // 组件卸载：清保险丝计时
    useEffect(
      () => () => {
        fuseTimersRef.current.forEach((t) => window.clearTimeout(t));
        fuseTimersRef.current.clear();
      },
      []
    );

    // 溢出检测
    const checkOverflow = useCallback(() => {
      const el = tabsTrackRef.current;
      if (!el) return;
      const isOverflow = el.scrollWidth > el.clientWidth + 2;
      setHasOverflow(isOverflow);
    }, []);

    useLayoutEffect(() => {
      checkOverflow();
      const el = tabsTrackRef.current;
      if (!el) return;
      const ro = ResizeObserverManager.getInstance();
      ro.observe(el, checkOverflow);
      return () => {
        ro.unobserve(el, checkOverflow);
      };
    }, [checkOverflow, tabs.length]);

    // 滚轮横向滑动（原生非被动监听，preventDefault 无告警）
    const handleTrackWheel = useCallback(
      (e: WheelEvent) => {
        const el = tabsTrackRef.current;
        if (!el) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          el.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      []
    );

    useNonPassiveWheel(tabsTrackRef, handleTrackWheel);

    const handleActivate = useCallback(
      (tabId: string) => {
        if (tabId !== activeTab) {
          if (onSelectTab) {
            onSelectTab(tabId);
          } else if (sessionTabId) {
            updateTabDock(sessionTabId, { activePanelId: tabId });
          }
        }
      },
      [activeTab, onSelectTab, sessionTabId]
    );

    const handleTablistKeyDown = useTablistKeyboard(tabsListRef, {
      tabSelector: '[role="tab"]',
      readTabId: (el) => el.getAttribute('data-tool-tab-id'),
      onActivate: handleActivate,
    });

    const finalizeClose = useCallback(
      (tabId: string) => {
        if (!closingIdsRef.current.has(tabId)) return;
        closingIdsRef.current.delete(tabId);
        setClosingTabIds(new Set(closingIdsRef.current));
        const fuse = fuseTimersRef.current.get(tabId);
        if (fuse != null) {
          window.clearTimeout(fuse);
          fuseTimersRef.current.delete(tabId);
        }
        if (onCloseTab) {
          onCloseTab(tabId);
          return;
        }
        if (!sessionTabId) return;
        const nextIds = tabs.filter((id) => id !== tabId);
        if (nextIds.length === 0) {
          updateTabDock(sessionTabId, {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
          });
        } else {
          updateTabDock(sessionTabId, {
            openPanelIds: nextIds,
          });
        }
      },
      [onCloseTab, sessionTabId, tabs]
    );

    const triggerCloseTab = useCallback(
      (tabId: string, e?: React.MouseEvent) => {
        if (e) {
          e.stopPropagation();
        }
        if (closingIdsRef.current.has(tabId)) return;

        // 关闭的是激活工具 tab：先切 dock.activePanelId（轻量 display 切换，保持零延迟）
        if (tabId === activeTab && tabs.length > 1) {
          const idx = tabs.indexOf(tabId);
          const nextActive = tabs[idx === 0 ? 1 : idx - 1];
          if (nextActive) {
            if (onSelectTab) {
              onSelectTab(nextActive);
            } else if (sessionTabId) {
              updateTabDock(sessionTabId, { activePanelId: nextActive });
            }
          }
        }

        closingIdsRef.current.add(tabId);
        setClosingTabIds(new Set(closingIdsRef.current));

        // 保险丝：transitionend 万一丢失，按真实 computed 时长 ×3 兜底摘除
        const tabEl = e
          ? (e.currentTarget as HTMLElement).closest('[role="tab"]')
          : null;
        const ms =
          (tabEl instanceof HTMLElement
            ? readTransitionMs(tabEl, 'max-width')
            : 0) || DURATION_FAST_MS;
        const fuse = window.setTimeout(() => finalizeClose(tabId), ms * 3);
        fuseTimersRef.current.set(tabId, fuse);
      },
      [
        activeTab,
        finalizeClose,
        onSelectTab,
        sessionTabId,
        tabs,
      ]
    );

    const openPanel = useCallback(
      (pid: string) => {
        if (onAddTab) {
          onAddTab(pid);
        } else if (sessionId) {
          openToolInSession(sessionId, pid);
        } else {
          openToolInActiveTab(pid);
        }
      },
      [sessionId, onAddTab]
    );

    const handleToggleMaximize = useCallback(() => {
      if (onToggleMaximize) {
        onToggleMaximize();
      } else {
        setIsMaximizedLocal((prev) => !prev);
      }
    }, [onToggleMaximize]);

    const isEmpty = tabs.length === 0;
    const shouldShowNavToolbar = !isEmpty && Boolean(showNavToolbar);

    return (
      <header
        className={`${styles.container} ${
          className || ''
        } ${hasOverflow ? styles.hasOverflow : ''} ${
          isEmpty ? styles.isEmpty : ''
        } chat-side-panel`}
        data-leaf-tool-tab-strip="true"
        data-tab-strip-leaf-id={leafId}
        data-tab-count={tabs.length}
        data-tab-mode={tabModeEnabled ? 'on' : 'off'}
        data-has-overflow={hasOverflow ? 'true' : 'false'}
        data-is-maximized={isMaximized ? 'true' : 'false'}
        data-is-empty={isEmpty ? 'true' : 'false'}
        data-tauri-drag-region="false"
        data-booted={booted ? 'true' : 'false'}
        style={
          {
            '--tab-height': `${TAB_HEIGHT_PX}px`,
            '--tab-gap': `${TAB_GAP_PX}px`,
            '--tool-tab-width-max': `${TOOL_TAB_WIDTH_MAX_PX}px`,
          } as React.CSSProperties
        }
      >
        {/* Row 1: Tab Strip（高度与全局顶栏同源） */}
        <div
          className={`${styles.header} ${
            hasOverflow ? styles.hasOverflow : ''
          } side-panel-tab-header`}
        >
          {/* 左侧可滚动 Track 区域 */}
          <div
            ref={tabsTrackRef}
            className={`${styles.tabsTrack} side-panel-tabs-track`}
          >
            <div
              ref={tabsListRef}
              className={`${styles.tabsList} side-panel-tabs-list`}
              role="tablist"
              aria-label="工具面板标签栏"
              onKeyDown={handleTablistKeyDown}
              data-tauri-drag-region="false"
            >
              {tabs.map((tabId) => {
                const label = viewRegistry.getTitle(tabId);
                const Icon = viewRegistry.getIcon(tabId);
                const isActive = tabId === activeTab;
                const isLeaving = closingTabIds.has(tabId);

                return (
                  <div
                    key={tabId}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`${styles.tab} ${
                      isActive ? styles.tabActive : ''
                    } side-panel-tab-item`}
                    data-leaving={isLeaving || undefined}
                    onClick={() => handleActivate(tabId)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        triggerCloseTab(tabId);
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1) e.preventDefault();
                    }}
                    onPointerDown={(e) => {
                      // 工具 tab 不再切会话树；顺序走 updateTabDock
                      e.stopPropagation();
                    }}
                    onTransitionEnd={(e) => {
                      if (!isLeaving) return;
                      if (e.target !== e.currentTarget) return;
                      if (e.propertyName !== 'max-width') return;
                      if (!closingIdsRef.current.has(tabId)) return;
                      finalizeClose(tabId);
                    }}
                    data-tauri-drag-region="false"
                    data-tool-tab-id={tabId}
                    data-tab-id={tabId}
                  >
                    {(Icon || isBrowserTabId(tabId)) && (
                      <span className={`${styles.tabIcon} side-panel-tab-icon`}>
                        <ToolTabFavicon tabId={tabId} Icon={Icon} />
                      </span>
                    )}
                    <span className={`${styles.tabLabel} tab-item-title`}>
                      {label}
                    </span>
                    <Tooltip content={`关闭 ${label}`}>
                      <button
                        type="button"
                        className={`${styles.tabCloseBtn} tab-item-close-btn`}
                        onClick={(e) => triggerCloseTab(tabId, e)}
                        aria-label={`关闭 ${label}`}
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })}
              {!hasOverflow && (
                <ToolTabAddButton
                  tabs={tabs}
                  isInFlow
                  openPanel={openPanel}
                />
              )}
            </div>
          </div>

          {/* 右侧固定操作区 */}
          <div
            className={`${styles.fixedCluster} side-panel-tab-fixed-cluster`}
          >
            <ToolTabAddButton tabs={tabs} isInFlow={false} openPanel={openPanel} />
            <Tooltip
              content={isMaximized ? '恢复面板' : '最大化面板'}
              side="bottom"
            >
              <button
                type="button"
                className={`${styles.sideBtn} side-panel-btn side-panel-btn-maximize`}
                onClick={handleToggleMaximize}
                aria-label={isMaximized ? '恢复面板' : '最大化面板'}
              >
                {isMaximized ? (
                  <Minimize2 size={14} strokeWidth={2} />
                ) : (
                  <Maximize2 size={14} strokeWidth={2} />
                )}
              </button>
            </Tooltip>
          </div>
        </div>

        {/* Row 2: 导航工具条 (仅在显式开启时展示) */}
        {shouldShowNavToolbar && <SidePanelNavToolbar />}

        {/* 空态 Launcher Hub 居中卡片 (0 个 Tab 时展示) */}
        {isEmpty && <SidePanelLauncherHub onOpenPanel={openPanel} />}
      </header>
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
