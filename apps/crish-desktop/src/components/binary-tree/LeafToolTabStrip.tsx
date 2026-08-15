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
import {
  useLayoutTreeStore,
  type LayoutLeaf,
} from '../../api/store-access/componentAccess';
import {
  collapseActiveTabRightDock,
  openToolInSession,
  openToolInActiveTab,
} from '../../api/store-access/componentAccess';
import { Button, TabStrip, Tooltip, Menu } from '../ui';
import styles from './LeafToolTabStrip.module.css';

const PANEL_LABELS: Record<string, string> = {
  overview: '总览',
  files: '文件',
  diff: '差异',
  terminal: '终端',
  preview: '预览',
  runtime: '运行时',
  agent: '协作体',
};

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
      (e: React.MouseEvent | React.KeyboardEvent, tabId: string) => {
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

    const availablePanels = Object.keys(PANEL_LABELS).filter(
      (pid) => !tabs.includes(pid)
    );

    const labelOf = (tabId: string) => {
      if (tabId.startsWith('file-viewer:')) {
        const filePath = tabId.substring('file-viewer:'.length);
        return filePath.replace(/^.*[\\/]/, '') || filePath;
      }
      return PANEL_LABELS[tabId] || tabId;
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
                  <button
                    type="button"
                    className={styles.tabClose}
                    tabIndex={-1}
                    aria-label={`关闭 ${label}`}
                    onClick={(e) => handleClose(e, tab.id)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.addTabBtn}
                      aria-label="添加功能面板"
                      icon={<Plus size={14} />}
                    />
                  }
                  options={availablePanels.map((pid) => ({
                    id: pid,
                    label: PANEL_LABELS[pid] || pid,
                    onClick: () => openPanel(pid),
                  }))}
                />
              </div>
            )}

            {/* 展开状态下的侧栏关闭按钮，常驻最右侧 */}
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                paddingRight: '4px',
              }}
            >
              <Tooltip content="收起右侧面板">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
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
