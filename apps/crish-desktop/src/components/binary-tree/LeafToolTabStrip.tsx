import React, { useCallback, useSyncExternalStore } from 'react';
import { Plus, X } from 'lucide-react';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
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
import { IconButton, Tooltip, Menu } from '../ui';
import { viewRegistry } from '../../services/view-registry';
import styles from './LeafToolTabStrip.module.css';

export interface LeafToolTabStripProps {
  leaf: LayoutLeaf;
}

export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
  ({ leaf }) => {
    const setActiveTab = useLayoutTreeStore((s) => s.setActiveTab);
    const removeTabFromLeaf = useLayoutTreeStore((s) => s.removeTabFromLeaf);
    const tabModeEnabled = useLayoutStore(selectTabModeEnabled);
    const dockOpenIds = useWorkspaceShellStore((s) => {
      const sid = (leaf.sessionId || '').trim();
      const tab = sid
        ? s.openTabs.find((t) => t.sessionId === sid)
        : s.openTabs.find((t) => t.tabId === s.activeTabId);
      return tab?.rightDock.openPanelIds;
    });

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const tabs = leaf.tabs;
    const activeTab = leaf.activeTab;

    const handleActivate = useCallback(
      (tabId: string) => {
        if (tabId !== activeTab) {
          setActiveTab(leaf.id, tabId);
        }
      },
      [leaf.id, activeTab, setActiveTab]
    );

    const handleClose = useCallback(
      (tabId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        removeTabFromLeaf(leaf.id, tabId);
      },
      [leaf.id, removeTabFromLeaf]
    );

    const openPanel = useCallback(
      (pid: string) => {
        if (leaf.sessionId) {
          openToolInSession(leaf.sessionId, pid);
        } else {
          openToolInActiveTab(pid);
        }
        if (tabModeEnabled) {
          setActiveTab(leaf.id, pid);
        }
      },
      [leaf.id, leaf.sessionId, setActiveTab, tabModeEnabled]
    );

    const handleCollapseDock = useCallback(() => {
      if (leaf.sessionId) {
        openToolInSession(leaf.sessionId, 'chat');
      } else {
        collapseActiveTabRightDock(true);
      }
    }, [leaf.sessionId]);

    if (tabs.length === 0) return null;

    const occupied = new Set(dockOpenIds?.length ? dockOpenIds : tabs);
    const availablePanels = viewRegistry
      .getToolViews()
      .map((v) => v.id)
      .filter((pid) => !occupied.has(pid));

    const showCloseBtn = tabs.length > 1;

    return (
      <div
        className={styles.header}
        data-leaf-tool-tab-strip="true"
        data-tab-strip-leaf-id={leaf.id}
        data-tab-count={tabs.length}
        data-tab-mode={tabModeEnabled ? 'on' : 'off'}
      >
        {/* 1. 纯 Tab 滚动区：占据剩余全部宽度，溢出时横向自适应滚动 */}
        <div
          className={styles.tabsScrollArea}
          role="tablist"
          aria-label="工具面板标签栏"
        >
          {tabs.map((tabId) => {
            const label = viewRegistry.getTitle(tabId);
            const Icon = viewRegistry.getIcon(tabId);
            const isActive = tabId === activeTab;
            return (
              <div
                key={tabId}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                onClick={() => handleActivate(tabId)}
                data-tool-tab-id={tabId}
              >
                {Icon && (
                  <Icon size={13} className={styles.tabIcon} aria-hidden />
                )}
                <span className={styles.tabLabel}>{label}</span>
                {showCloseBtn ? (
                  <Tooltip content={`关闭 ${label}`}>
                    <button
                      type="button"
                      className={styles.tabCloseBtn}
                      onClick={(e) => handleClose(tabId, e)}
                      aria-label={`关闭 ${label}`}
                    >
                      <X size={10} strokeWidth={2} />
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* 2. 吸附在右侧固定动作区（加号 + 收起按钮） */}
        <div className={styles.stickyTrailingGroup}>
          {availablePanels.length > 0 && (
            <Menu
              position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
              trigger={
                <Tooltip content="添加工具标签" side="bottom">
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="xs"
                    className={styles.addTabBtn}
                    aria-label="添加功能面板"
                    icon={<Plus size={13} />}
                  />
                </Tooltip>
              }
              options={availablePanels.map((pid) => {
                const Icon = viewRegistry.getIcon(pid);
                return {
                  id: pid,
                  label: viewRegistry.getTitle(pid),
                  icon: Icon ? <Icon size={13} /> : undefined,
                  onClick: () => openPanel(pid),
                };
              })}
            />
          )}
          <Tooltip content="收起右侧面板" side="bottom">
            <IconButton
              type="button"
              variant="ghost"
              size="xs"
              className={styles.collapseBtn}
              onClick={handleCollapseDock}
              aria-label="收起右侧面板"
              icon={<IconSidebarRight size={13} />}
            />
          </Tooltip>
        </div>
      </div>
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
