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
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import { SidePanelLauncherHub } from './SidePanelLauncherHub';
import { SidePanelNavToolbar } from './SidePanelNavToolbar';
import {
  useLayoutTreeStore,
  useLayoutStore,
  selectTabModeEnabled,
  useWorkspaceShellStore,
  collapseActiveTabRightDock,
  openToolInSession,
  openToolInActiveTab,
  type LayoutLeaf,
} from '../../store/storeAccess';
import { Tooltip } from '../ui';
import {
  SmartExpandablePanel,
  type MenuItem,
} from '../ui/SmartExpandablePanel';
import { ResizeObserverManager } from '../../services/ResizeObserverManager';
import { viewRegistry } from '../../services/view-registry';
import styles from './LeafToolTabStrip.module.css';

export interface LeafToolTabStripProps {
  leaf?: LayoutLeaf;
  leafId?: string;
  sessionId?: string | null;
  tabs?: string[];
  activeTab?: string;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onAddTab?: (panelId: string) => void;
  onToggleMaximize?: () => void;
  onCollapse?: () => void;
  isMaximized?: boolean;
  showNavToolbar?: boolean;
}

export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
  ({
    leaf,
    leafId: propLeafId,
    sessionId: propSessionId,
    tabs: propTabs,
    activeTab: propActiveTab,
    onSelectTab,
    onCloseTab,
    onAddTab,
    onToggleMaximize,
    onCollapse,
    isMaximized: propIsMaximized,
    showNavToolbar,
  }) => {
    const leafId = propLeafId ?? leaf?.id ?? '';
    const sessionId = propSessionId ?? leaf?.sessionId ?? null;
    const rawTabs = propTabs ?? leaf?.tabs ?? [];
    const tabs = useMemo(() => rawTabs, [rawTabs]);
    const activeTab = propActiveTab ?? leaf?.activeTab ?? (tabs[0] || '');

    const setActiveTab = useLayoutTreeStore((s) => s.setActiveTab);
    const removeTabFromLeaf = useLayoutTreeStore((s) => s.removeTabFromLeaf);
    const tabModeEnabled = useLayoutStore(selectTabModeEnabled);

    const dockOpenIds = useWorkspaceShellStore((s) => {
      const sid = (sessionId || '').trim();
      const tab = sid
        ? s.openTabs.find((t) => t.sessionId === sid)
        : s.openTabs.find((t) => t.tabId === s.activeTabId);
      return tab?.rightDock?.openPanelIds;
    });

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
          } else if (leafId) {
            setActiveTab(leafId, tabId);
          }
        }
      },
      [activeTab, leafId, onSelectTab, setActiveTab]
    );

    const triggerCloseTab = useCallback(
      (tabId: string, e?: React.MouseEvent) => {
        if (e) {
          e.stopPropagation();
        }
        if (closingTabIds.has(tabId)) return;

        // 如果关闭的是激活 Tab，零视觉延迟切换到相邻 Tab
        if (tabId === activeTab && tabs.length > 1) {
          const idx = tabs.indexOf(tabId);
          const nextActive = tabs[idx === 0 ? 1 : idx - 1];
          if (nextActive) {
            if (onSelectTab) {
              onSelectTab(nextActive);
            } else if (leafId) {
              setActiveTab(leafId, nextActive);
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
          } else if (leafId) {
            removeTabFromLeaf(leafId, tabId);
          }
        }, 220);
      },
      [
        activeTab,
        closingTabIds,
        leafId,
        onCloseTab,
        onSelectTab,
        removeTabFromLeaf,
        setActiveTab,
        tabs,
      ]
    );

    const openPanel = useCallback(
      (pid: string) => {
        if (onAddTab) {
          onAddTab(pid);
        } else {
          if (sessionId) {
            openToolInSession(sessionId, pid);
          } else {
            openToolInActiveTab(pid);
          }
          if (tabModeEnabled && leafId) {
            setActiveTab(leafId, pid);
          }
        }
      },
      [leafId, sessionId, setActiveTab, tabModeEnabled, onAddTab]
    );

    const handleToggleMaximize = useCallback(() => {
      if (onToggleMaximize) {
        onToggleMaximize();
      } else {
        setIsMaximizedLocal((prev) => !prev);
      }
    }, [onToggleMaximize]);

    const handleCollapse = useCallback(() => {
      if (onCollapse) {
        onCollapse();
      } else if (sessionId) {
        openToolInSession(sessionId, 'chat');
      } else {
        collapseActiveTabRightDock(true);
      }
    }, [onCollapse, sessionId]);

    const occupied = useMemo(
      () => new Set(dockOpenIds?.length ? dockOpenIds : tabs),
      [dockOpenIds, tabs]
    );
    const availablePanels = useMemo(
      () =>
        viewRegistry
          .getToolViews()
          .map((v) => v.id)
          .filter((pid) => !occupied.has(pid)),
      [occupied, registryVersion]
    );

    const showCloseBtn = tabs.length > 1;
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

    const shouldShowNavToolbar =
      !isEmpty &&
      (showNavToolbar !== undefined
        ? showNavToolbar
        : isNavigableView(activeTab));

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
          onSelect: () => openPanel(pid),
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
      <div
        className={`${styles.container} ${
          hasOverflow ? styles.hasOverflow : ''
        } ${isEmpty ? styles.isEmpty : ''} ${
          isMaximized ? styles.isMaximized : ''
        } chat-side-panel`}
        data-leaf-tool-tab-strip="true"
        data-tab-strip-leaf-id={leafId}
        data-tab-count={tabs.length}
        data-tab-mode={tabModeEnabled ? 'on' : 'off'}
        data-has-overflow={hasOverflow ? 'true' : 'false'}
        data-is-maximized={isMaximized ? 'true' : 'false'}
        data-is-empty={isEmpty ? 'true' : 'false'}
      >
        {/* Row 1: Tab Strip (30px 高度) */}
        <header
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
              {renderAddButton(true)}
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
            <Tooltip content="收起右侧面板" side="bottom">
              <button
                type="button"
                className={`${styles.sideBtn} ${styles.btnCollapse} side-panel-btn side-panel-btn-collapse`}
                onClick={handleCollapse}
                aria-label="收起右侧面板"
              >
                <IconSidebarRight size={14} />
              </button>
            </Tooltip>
          </div>
        </header>

        {/* Row 2: 导航工具条 (32px 高度，特定视图展示，空态隐藏) */}
        {shouldShowNavToolbar && <SidePanelNavToolbar />}

        {/* 空态 Launcher Hub 居中卡片 (0 个 Tab 时展示) */}
        {isEmpty && <SidePanelLauncherHub onOpenPanel={openPanel} />}
      </div>
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
