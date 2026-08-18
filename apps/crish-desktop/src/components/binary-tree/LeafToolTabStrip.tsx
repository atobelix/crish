/**
 * LeafToolTabStrip — 独立工具 leaf 的顶部标签栏。
 *
 * T-C 批次 5.2 · T12 后基于 ui/TabStrip 基座：
 * - roving tabindex / 方向键漫游由基座提供（修复 08 P3-3：此前 role=tab 无 roving）；
 * - 本层保留：leaf.tabs 数据映射、激活/关闭路径、添加面板菜单、收起按钮。
 *
 * 与 RightToolDockHeader 的区别：
 * - RightToolDockHeader 基于 tab.rightDock（旧版右坞模型）
 * - LeafToolTabStrip 基于 leaf.tabs / leaf.activeTab（BinaryTreeWorkspace 独立 leaf 模型）
 *
 * 仅当工具 leaf 有多个 tab 时渲染；单 tab 工具 leaf 不显示标签栏（避免占行）。
 */

import React, { useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import { useLayoutTreeStore, type LayoutLeaf } from '../../store/storeAccess';
import {
  collapseActiveTabRightDock,
  openToolInSession,
  openToolInActiveTab,
} from '../../store/storeAccess';
import { IconButton, TabStrip, Tooltip, Menu } from '../ui';
import { viewRegistry } from '../../services/view-registry';
import styles from './LeafToolTabStrip.module.css';

export interface LeafToolTabStripProps {
  leaf: LayoutLeaf;
}

export const LeafToolTabStrip: React.FC<LeafToolTabStripProps> = React.memo(
  ({ leaf }) => {
    const setActiveTab = useLayoutTreeStore((s) => s.setActiveTab);
    const removeTabFromLeaf = useLayoutTreeStore((s) => s.removeTabFromLeaf);

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
      (_e: React.MouseEvent | React.KeyboardEvent, tabId: string) => {
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
        setActiveTab(leaf.id, pid);
      },
      [leaf.id, leaf.sessionId, setActiveTab]
    );

    const handleCollapseDock = useCallback(() => {
      if (leaf.sessionId) {
        // 精准收起当前 leaf 所属会话的工具坞
        openToolInSession(leaf.sessionId, 'chat');
      } else {
        collapseActiveTabRightDock(true);
      }
    }, [leaf.sessionId]);

    // 单 tab 或无 tab 时不渲染标签栏（已调整为无 tabs 时才不渲染，以保证加号可用）
    if (tabs.length === 0) return null;

    const availablePanels = viewRegistry
      .getToolViews()
      .map((v) => v.id)
      .filter((pid) => !tabs.includes(pid));

    const labelOf = (tabId: string) => {
      return viewRegistry.getTitle(tabId);
    };

    const showCloseBtn = tabs.length > 1;

    return (
      <TabStrip
        className={styles.header}
        scrollClassName={styles.tabs}
        tabClassName={styles.tab}
        tabActiveClassName={styles.tabActive}
        ariaLabel="工具面板"
        activeId={activeTab ?? null}
        tabs={tabs.map((tabId) => ({
          id: tabId,
          label: labelOf(tabId),
          closable: showCloseBtn,
          data: { 'data-tool-tab-id': tabId },
        }))}
        onActiveChange={handleActivate}
        onClose={(tabId, e) => handleClose(e, tabId)}
        renderTab={(tab) => {
          const label = labelOf(tab.id);
          return (
            <>
              <span className={styles.tabLabel}>{label}</span>
              {showCloseBtn ? (
                <Tooltip content={`关闭 ${label}`}>
                  <IconButton
                    size="xs"
                    variant="ghost"
                    className={styles.tabClose}
                    tabIndex={-1}
                    aria-label={`关闭 ${label}`}
                    onClick={(e) => handleClose(e, tab.id)}
                    icon={<X size={12} strokeWidth={2} />}
                  />
                </Tooltip>
              ) : null}
            </>
          );
        }}
        trailing={
          <>
            {/* 添加面板加号按钮 */}
            {availablePanels.length > 0 && (
              <div className={styles.addTabContainer}>
                <Menu
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  trigger={
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="xs"
                      className={styles.addTabBtn}
                      aria-label="添加功能面板"
                      icon={<Plus size={14} />}
                    />
                  }
                  options={availablePanels.map((pid) => {
                    const Icon = viewRegistry.getIcon(pid);
                    return {
                      id: pid,
                      label: viewRegistry.getTitle(pid),
                      icon: Icon ? <Icon size={14} /> : undefined,
                      onClick: () => openPanel(pid),
                    };
                  })}
                />
              </div>
            )}

            {/* 展开状态下的侧栏关闭按钮，常驻最右侧 */}
            <div className={styles.trailingActions}>
              <Tooltip content="收起右侧面板">
                <IconButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={styles.addTabBtn}
                  onClick={handleCollapseDock}
                  aria-label="收起右侧面板"
                  icon={<IconSidebarRight size={14} />}
                />
              </Tooltip>
            </div>
          </>
        }
        data={{
          'data-leaf-tool-tab-strip': 'true',
          'data-tab-strip-leaf-id': leaf.id,
          'data-tab-count': tabs.length,
        }}
      />
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
