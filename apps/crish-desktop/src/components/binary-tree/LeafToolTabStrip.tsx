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
  Plus,
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
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import { viewRegistry } from '../../services/view-registry';
import { SidePanelNavToolbar } from './SidePanelNavToolbar';
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
    const [enteringTabId, setEnteringTabId] = useState<string | null>(null);
    const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set());

    const tabsTrackRef = useRef<HTMLDivElement>(null);
    const prevTabsRef = useRef<string[]>(tabs);

    // Tab 进入动画监听
    useEffect(() => {
      const prev = prevTabsRef.current;
      const newlyAdded = tabs.find((t) => !prev.includes(t));
      prevTabsRef.current = tabs;
      if (newlyAdded) {
        setEnteringTabId(newlyAdded);
        const timer = setTimeout(() => {
          setEnteringTabId((cur) => (cur === newlyAdded ? null : cur));
        }, 220);
        return () => clearTimeout(timer);
      }
      return undefined;
    }, [tabs]);

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

    // 滚轮横向滑动
    const handleTrackWheel = useCallback(
      (e: React.WheelEvent<HTMLDivElement>) => {
        const el = tabsTrackRef.current;
        if (!el) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          el.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      []
    );

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

    const triggerCloseTab = useCallback(
      (tabId: string, e?: React.MouseEvent) => {
        if (e) {
          e.stopPropagation();
        }
        if (closingTabIds.has(tabId)) return;

        // 关闭的是激活工具 tab：先切 dock.activePanelId，不是 leaf.activeTabId
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

        setClosingTabIds((prev) => new Set(prev).add(tabId));

        setTimeout(() => {
          setClosingTabIds((prev) => {
            const next = new Set(prev);
            next.delete(tabId);
            return next;
          });
          if (onCloseTab) {
            onCloseTab(tabId);
          } else if (sessionTabId) {
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
          }
        }, 220);
      },
      [
        activeTab,
        closingTabIds,
        onCloseTab,
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

    const occupied = useMemo(() => new Set(tabs), [tabs]);
    const availablePanels = useMemo(
      () =>
        viewRegistry
          .getToolViews()
          .map((v) => v.id)
          .filter(
            (pid) => pid === 'preview' || pid === 'terminal' || !occupied.has(pid)
          ),
      [occupied, registryVersion]
    );

    const showCloseBtn = true;
    const isEmpty = tabs.length === 0;

    const isNavigableView = (id?: string) => {
      if (!id) return false;
      const lower = id.toLowerCase();
      return (
        lower === 'preview' ||
        lower === 'browser' ||
        lower === 'web' ||
        lower.startsWith('preview:') ||
        lower.startsWith('browser:')
      );
    };

    const shouldShowNavToolbar = !isEmpty && Boolean(showNavToolbar);

    const renderAddButton = (isInFlow: boolean) => {
      const btnClass = `${styles.addBtn} ${
        isInFlow ? styles.inFlow : styles.pinned
      } ${isInFlow ? 'in-flow' : 'pinned'} side-panel-add-btn`;

      const btnElement = (
        <button
          type="button"
          className={btnClass}
          aria-label="添加功能面板"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      );

      if (availablePanels.length === 0) {
        return (
          <Tooltip content="添加工具标签" side="bottom">
            {btnElement}
          </Tooltip>
        );
      }

      const addMenuItems: MenuItem[] = availablePanels.map((pid) => {
        const Icon = viewRegistry.getIcon(pid);
        return {
          id: pid,
          label: viewRegistry.getTitle(pid),
          icon: Icon ? <Icon size={13} /> : undefined,
          onSelect: () => {
            if (pid === 'preview') {
              if (!tabs.includes('preview')) {
                openPanel('preview');
              } else {
                let nextIdx = 2;
                while (tabs.includes(`preview:${nextIdx}`)) {
                  nextIdx++;
                }
                openPanel(`preview:${nextIdx}`);
              }
            } else if (pid === 'terminal') {
              if (!tabs.includes('terminal')) {
                openPanel('terminal');
              } else {
                let nextIdx = 2;
                while (tabs.includes(`terminal:${nextIdx}`)) {
                  nextIdx++;
                }
                openPanel(`terminal:${nextIdx}`);
              }
            } else {
              openPanel(pid);
            }
          },
        };
      });

      return (
        <SmartExpandablePanel
          position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
          trigger={
            <Tooltip content="添加工具标签" side="bottom">
              {btnElement}
            </Tooltip>
          }
          items={addMenuItems}
          className={styles.leafToolAddPanel}
        />
      );
    };

    return (
      <header
        className={`${styles.container} ${
          className || ''
        } ${hasOverflow ? styles.hasOverflow : ''} ${
          isEmpty ? styles.isEmpty : ''
        } ${isMaximized ? styles.isMaximized : ''} chat-side-panel`}
        data-leaf-tool-tab-strip="true"
        data-tab-strip-leaf-id={leafId}
        data-tab-count={tabs.length}
        data-tab-mode={tabModeEnabled ? 'on' : 'off'}
        data-has-overflow={hasOverflow ? 'true' : 'false'}
        data-is-maximized={isMaximized ? 'true' : 'false'}
        data-is-empty={isEmpty ? 'true' : 'false'}
      >
        {/* Row 1: Tab Strip (38px 高度) */}
        <div
          className={`${styles.header} ${
            hasOverflow ? styles.hasOverflow : ''
          } side-panel-tab-header`}
        >
          {/* 左侧可滚动 Track 区域 */}
          <div
            ref={tabsTrackRef}
            className={`${styles.tabsTrack} side-panel-tabs-track`}
            onWheel={handleTrackWheel}
          >
            <div
              className={`${styles.tabsList} side-panel-tabs-list`}
              role="tablist"
              aria-label="工具面板标签栏"
            >
              {tabs.map((tabId) => {
                const label = viewRegistry.getTitle(tabId);
                const Icon = viewRegistry.getIcon(tabId);
                const isActive = tabId === activeTab;
                const isEntering = tabId === enteringTabId;
                const isLeaving = closingTabIds.has(tabId);

                return (
                  <div
                    key={tabId}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`${styles.tab} ${
                      isActive ? styles.tabActive : ''
                    } ${isEntering ? styles.isEntering : ''} ${
                      isLeaving ? styles.isLeaving : ''
                    } side-panel-tab-item`}
                    onClick={() => handleActivate(tabId)}
                    onAuxClick={(e) => {
                      if (e.button === 1 && showCloseBtn) {
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
                    data-tool-tab-id={tabId}
                    data-tab-id={tabId}
                  >
                    {Icon && (
                      <span className={`${styles.tabIcon} side-panel-tab-icon`}>
                        <Icon size={13} aria-hidden />
                      </span>
                    )}
                    <span className={`${styles.tabLabel} tab-item-title`}>
                      {label}
                    </span>
                    {showCloseBtn ? (
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
                    ) : null}
                  </div>
                );
              })}
              {!hasOverflow && renderAddButton(true)}
            </div>
          </div>

          {/* 右侧固定操作区 */}
          <div
            className={`${styles.fixedCluster} side-panel-tab-fixed-cluster`}
          >
            {renderAddButton(false)}
            <Tooltip
              content={isMaximized ? '恢复面板' : '最大化面板'}
              side="bottom"
            >
              <button
                type="button"
                className={`${styles.sideBtn} ${styles.btnMaximize} side-panel-btn side-panel-btn-maximize`}
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
