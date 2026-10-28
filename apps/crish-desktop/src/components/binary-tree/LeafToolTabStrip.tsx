/**
 * apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
 *
 * 统一窗格头部组件（单一真源，支持单窗格与多分屏窗格）
 * 对齐 Dock Split System Architecture V2 规范。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ToolTab, ToolViewId } from '../../store/storeAccess';
import { openToolInSession } from '../../store/storeAccess';
import { viewRegistry } from '../../services/view-registry';
import { Tooltip, Button } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import { toolTabStripVars } from './tabStripVars';
import { useNonPassiveWheel } from '../../hooks/useNonPassiveWheel';
import { useTablistKeyboard } from '../../hooks/useTablistKeyboard';
import { useToolTabLifecycle } from '../../hooks/useToolTabLifecycle';
import { useTabStripOverflow } from '../../hooks/useTabStripOverflow';
import { isBrowserTabId, ToolTabFavicon } from './ToolTabFavicon';
import { ToolTabAddButton } from './ToolTabAddButton';
import { useDockTabDrag } from './dockTabDragContext';
import { SidePanelNavToolbar } from './SidePanelNavToolbar';
import { SidePanelLauncherHub } from './SidePanelLauncherHub';
import styles from './LeafToolTabStrip.module.css';

export interface LeafToolTabStripProps {
  paneId?: string;
  leafId: string;
  sessionId?: string | null;
  tabs: readonly ToolTab[];
  activeTabId: string | null;
  isSolo?: boolean;
  isMaximized?: boolean;
  canClosePane?: boolean;
  canSplitHorizontal?: boolean;
  canSplitVertical?: boolean;
  showNavToolbar?: boolean;
  onRefreshNav?: () => void;
  onOpenExternalNav?: () => void;
  showLauncherOnEmpty?: boolean;
  onSelectTab?: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab?: (viewId: ToolViewId) => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onToggleSolo?: () => void;
  onToggleMaximize?: () => void;
  onClosePane?: () => void;
  className?: string;
}

export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
  ({
    paneId,
    leafId,
    sessionId,
    tabs: rawTabs,
    activeTabId: propActiveTabId,
    isSolo,
    isMaximized,
    canClosePane,
    canSplitHorizontal,
    canSplitVertical,
    showNavToolbar,
    onRefreshNav,
    onOpenExternalNav,
    showLauncherOnEmpty,
    onSelectTab,
    onCloseTab,
    onAddTab,
    onSplitRight,
    onSplitDown,
    onToggleSolo,
    onToggleMaximize,
    onClosePane,
    className,
    ...restProps
  }) => {
    const { t } = useI18n();
    // 兼容可能传入的扁平 tabs（如单测或过渡期）并统一为结构化 ToolTab
    const tabs = useMemo(() => {
      if (!Array.isArray(rawTabs)) return [];
      return rawTabs.map((t): ToolTab =>
        typeof t === 'string' ? { tabId: t, viewId: t as ToolViewId } : t
      );
    }, [rawTabs]);

    const activeTabId =
      propActiveTabId ??
      (restProps as { activeTab?: string }).activeTab ??
      tabs[0]?.tabId ??
      null;

    const [booted, setBooted] = useState(false);
    const tabsTrackRef = useRef<HTMLDivElement>(null);
    const tabsListRef = useRef<HTMLDivElement>(null);

    // 入场动画门控：与 PaneHeader 同一契约，首轮挂载不重播
    useEffect(() => {
      setBooted(true);
    }, []);

    // 1. 生命周期状态机与溢出检测
    const { closingTabIds, triggerCloseTab, finalizeClose } =
      useToolTabLifecycle({
        onFinalizeClose: onCloseTab,
      });
    const { hasOverflow } = useTabStripOverflow(tabsTrackRef, tabs.length);

    // 2. 滚轮水平滚动与键盘漫游
    const handleTrackWheel = useCallback((e: WheelEvent) => {
      const el = tabsTrackRef.current;
      if (!el) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, []);
    useNonPassiveWheel(tabsTrackRef, handleTrackWheel);

    const handleTablistKeyDown = useTablistKeyboard(tabsListRef, {
      tabSelector: '[role="tab"]',
      readTabId: (el) => el.getAttribute('data-tool-tab-id'),
      onActivate: (id) => onSelectTab?.(id),
    });

    // 3. 触发关闭标签（优先零延迟切向相邻 Tab）
    const handleTriggerClose = useCallback(
      (tabId: string, e?: React.MouseEvent) => {
        if (tabId === activeTabId && tabs.length > 1) {
          const idx = tabs.findIndex((t) => t.tabId === tabId);
          const nextActive = tabs[idx === 0 ? 1 : idx - 1];
          if (nextActive) onSelectTab?.(nextActive.tabId);
        }
        const tabEl = e
          ? (e.currentTarget as HTMLElement).closest('[role="tab"]')
          : null;
        triggerCloseTab(tabId, e, tabEl as HTMLElement | null);
      },
      [activeTabId, onSelectTab, tabs, triggerCloseTab]
    );

    const tabViewIds = useMemo(() => tabs.map((t) => t.viewId), [tabs]);

    // 4. 添加面板通道（优先 onAddTab，兜底 openToolInSession）
    const handleAddTab = useCallback(
      (pid: string) => {
        if (onAddTab) onAddTab(pid as ToolViewId);
        else if (sessionId) openToolInSession(sessionId, pid);
      },
      [onAddTab, sessionId]
    );

    const isMaxOrSolo = Boolean(isSolo || isMaximized);
    const handleToggleMaximize = onToggleSolo || onToggleMaximize;
    const maximizeLabel = isSolo
      ? isMaxOrSolo
        ? t('workspace.pane.restorePane')
        : t('workspace.pane.maximizePane')
      : isMaxOrSolo
        ? t('workspace.pane.restorePanel')
        : t('workspace.pane.maximizePanel');
    const maximizeTooltip = isSolo
      ? isMaxOrSolo
        ? t('workspace.pane.restoreSplitTooltip')
        : t('workspace.pane.maximizePaneTooltip')
      : isMaxOrSolo
        ? t('workspace.pane.restoreDockTooltip')
        : t('workspace.pane.maximizePanelTooltip');

    const { startDockDrag } = useDockTabDrag();
    const shouldShowLauncher =
      tabs.length === 0 && (showLauncherOnEmpty ?? !paneId);

    return (
      <header
        className={`${styles.container} ${className || ''} ${hasOverflow ? styles.hasOverflow : ''} ${shouldShowLauncher ? styles.isEmpty : ''} chat-side-panel`}
        data-leaf-tool-tab-strip="true"
        data-dock-tab-strip="true"
        data-dock-leaf-id={leafId}
        data-tab-strip-leaf-id={leafId}
        data-tab-count={tabs.length}
        data-has-overflow={hasOverflow ? 'true' : 'false'}
        data-is-maximized={isMaxOrSolo ? 'true' : 'false'}
        data-is-solo={isSolo ? 'true' : 'false'}
        data-tauri-drag-region="false"
        data-booted={booted ? 'true' : 'false'}
        style={toolTabStripVars()}
      >
        <div className={`${styles.header} side-panel-tab-header`}>
          {/* 左侧可滚动 Track 区域 */}
          <div
            ref={tabsTrackRef}
            className={`${styles.tabsTrack} side-panel-tabs-track`}
          >
            <div
              ref={tabsListRef}
              className={`${styles.tabsList} side-panel-tabs-list`}
              role="tablist"
              aria-label={t('workspace.pane.tablistAria')}
              onKeyDown={handleTablistKeyDown}
              data-tauri-drag-region="false"
            >
              {tabs.map((tab) => {
                const { tabId, viewId } = tab;
                const label =
                  tab.title || viewRegistry.getTitle(viewId) || viewId;
                const iconName = viewRegistry.getIcon(viewId);
                const isActive = tabId === activeTabId;
                const isLeaving = closingTabIds.has(tabId);

                return (
                  <div
                    key={tabId}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`${styles.tab} ${isActive ? styles.tabActive : ''} side-panel-tab-item`}
                    data-leaving={isLeaving || undefined}
                    data-tool-tab-id={tabId}
                    data-tab-id={tabId}
                    data-tauri-drag-region="false"
                    onClick={() => !isActive && onSelectTab?.(tabId)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        e.stopPropagation();
                        handleTriggerClose(tabId, e);
                      }
                    }}
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      startDockDrag({
                        sourceLeafId: leafId,
                        tabId,
                        title: label,
                        e,
                      });
                    }}
                    onTransitionEnd={(e) => {
                      if (
                        !isLeaving ||
                        e.target !== e.currentTarget ||
                        e.propertyName !== 'max-width'
                      )
                        return;
                      finalizeClose(tabId);
                    }}
                  >
                    {(iconName ||
                      isBrowserTabId(viewId) ||
                      isBrowserTabId(tabId)) && (
                      <span
                        className={`${styles.tabIcon} side-panel-tab-icon`}
                        data-testid="tool-icon"
                      >
                        <ToolTabFavicon
                          tabId={tabId}
                          iconName={iconName}
                          isBrowser={
                            isBrowserTabId(viewId) || isBrowserTabId(tabId)
                          }
                        />
                      </span>
                    )}
                    <Tooltip content={label} side="bottom">
                      <span className={`${styles.tabLabel} tab-item-title`}>
                        {label}
                      </span>
                    </Tooltip>
                    <Tooltip
                      content={t('workspace.pane.closeTabWithLabel', { label })}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        className={`${styles.tabCloseBtn} tab-item-close-btn`}
                        onClick={(e) => handleTriggerClose(tabId, e)}
                        aria-label={t('workspace.pane.closeTabWithLabel', {
                          label,
                        })}
                      >
                        <AppIcon name="x" size={10} />
                      </Button>
                    </Tooltip>
                  </div>
                );
              })}
              <ToolTabAddButton
                tabs={tabViewIds}
                isInFlow
                openPanel={handleAddTab}
              />
            </div>
          </div>

          {/* 右侧固定窗格操作集群 */}
          <div
            className={`${styles.fixedCluster} side-panel-tab-fixed-cluster`}
          >
            <ToolTabAddButton
              tabs={tabViewIds}
              isInFlow={false}
              openPanel={handleAddTab}
            />
            {onSplitRight && (
              <Tooltip
                content={
                  canSplitHorizontal
                    ? t('workspace.pane.splitRightTooltip')
                    : t('workspace.pane.splitRightDisabledTooltip')
                }
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.sideBtn} ${styles.paneActionBtn} side-panel-btn`}
                  disabled={!canSplitHorizontal}
                  onClick={onSplitRight}
                  aria-label={t('workspace.pane.splitRight')}
                >
                  <AppIcon name="split-horizontal" size={12} />
                </Button>
              </Tooltip>
            )}
            {onSplitDown && (
              <Tooltip
                content={
                  canSplitVertical
                    ? t('workspace.pane.splitDownTooltip')
                    : t('workspace.pane.splitDownDisabledTooltip')
                }
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.sideBtn} ${styles.paneActionBtn} side-panel-btn`}
                  disabled={!canSplitVertical}
                  onClick={onSplitDown}
                  aria-label={t('workspace.pane.splitDown')}
                >
                  <AppIcon name="split-vertical" size={12} />
                </Button>
              </Tooltip>
            )}
            {handleToggleMaximize && (
              <Tooltip content={maximizeTooltip} side="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.sideBtn} ${styles.paneActionBtn} side-panel-btn side-panel-btn-maximize`}
                  onClick={handleToggleMaximize}
                  aria-label={maximizeLabel}
                >
                  <AppIcon
                    name={isMaxOrSolo ? 'minimize' : 'maximize'}
                    size={12}
                  />
                </Button>
              </Tooltip>
            )}
            {canClosePane && onClosePane && (
              <Tooltip content={t('workspace.pane.closePane')} side="bottom">
                <Button
                  type="button"
                  variant="ghost"
                  className={`${styles.sideBtn} ${styles.paneActionBtn} ${styles.paneCloseBtn} side-panel-btn side-panel-btn-close`}
                  onClick={onClosePane}
                  aria-label={t('workspace.pane.closePane')}
                >
                  <AppIcon name="x" size={12} />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
        {showNavToolbar && (
          <SidePanelNavToolbar
            onRefresh={onRefreshNav}
            onOpenExternal={onOpenExternalNav}
          />
        )}
        {shouldShowLauncher && (
          <SidePanelLauncherHub onOpenPanel={handleAddTab} />
        )}
      </header>
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
