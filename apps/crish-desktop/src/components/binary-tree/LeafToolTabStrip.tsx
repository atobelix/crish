/**
 * LeafToolTabStrip — 独立工具 leaf 的顶部标签栏。
 *
 * 与 RightToolDockHeader 的区别：
 * - RightToolDockHeader 基于 tab.rightDock（旧版右坞模型）
 * - LeafToolTabStrip 基于 leaf.tabs / leaf.activeTab（BinaryTreeWorkspace 独立 leaf 模型）
 *
 * 仅当工具 leaf 有多个 tab 时渲染；单 tab 工具 leaf 不显示标签栏（避免占行）。
 */

import React, { useCallback, useState } from 'react';
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
import { Tooltip } from '../Tooltip';
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
      (e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        removeTabFromLeaf(leaf.id, tabId);
      },
      [leaf.id, removeTabFromLeaf]
    );

    const addTabToLeaf = useLayoutTreeStore((s) => s.addTabToLeaf);
    const [showAddMenu, setShowAddMenu] = useState(false);

    // 单 tab 或无 tab 时不渲染标签栏（已调整为无 tabs 时才不渲染，以保证加号可用）
    if (tabs.length === 0) return null;

    const availablePanels = Object.keys(PANEL_LABELS).filter(
      (pid) => !tabs.includes(pid)
    );

    return (
      <div
        className={styles.header}
        data-leaf-tool-tab-strip="true"
        data-tab-strip-leaf-id={leaf.id}
        data-tab-count={tabs.length}
      >
        <div className={styles.tabs} role="tablist" aria-label="工具面板">
          {tabs.map((tabId) => {
            const isActive = tabId === activeTab;
            let label = PANEL_LABELS[tabId] || tabId;
            if (tabId.startsWith('file-viewer:')) {
              const filePath = tabId.substring('file-viewer:'.length);
              label = filePath.replace(/^.*[\\/]/, '') || filePath;
            }
            const showCloseBtn = tabs.length > 1;
            return (
              <button
                key={tabId}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-tool-tab-id={tabId}
                className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                onClick={() => handleActivate(tabId)}
              >
                <span className={styles.tabLabel}>{label}</span>
                {showCloseBtn && (
                  <Tooltip content={`关闭 ${label}`}>
                    <span
                      className={styles.tabClose}
                      role="button"
                      tabIndex={0}
                      aria-label={`关闭 ${label}`}
                      onClick={(e) => handleClose(e, tabId)}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleClose(e as unknown as React.MouseEvent, tabId);
                        }
                      }}
                    >
                      <X size={12} strokeWidth={2} aria-hidden />
                    </span>
                  </Tooltip>
                )}
              </button>
            );
          })}

          {/* 添加面板加号按钮 */}
          {availablePanels.length > 0 && (
            <div className={styles.addTabContainer}>
              <Tooltip content="添加功能面板">
                <button
                  type="button"
                  className={styles.addTabBtn}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setShowAddMenu(!showAddMenu);
                  }}
                  aria-label="添加功能面板"
                  aria-expanded={showAddMenu}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>

              {showAddMenu && (
                <>
                  <div
                    className={styles.menuBackdrop}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setShowAddMenu(false);
                    }}
                  />
                  <div className={styles.addDropdownMenu} role="menu">
                    {availablePanels.map((pid) => {
                      const label = PANEL_LABELS[pid] || pid;
                      return (
                        <button
                          key={pid}
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (leaf.sessionId) {
                              openToolInSession(leaf.sessionId, pid);
                            } else {
                              openToolInActiveTab(pid);
                            }
                            setActiveTab(leaf.id, pid);
                            setShowAddMenu(false);
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* 展开状态下的侧栏关闭按钮，常驻最右侧 */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: '4px' }}>
            <Tooltip content="收起右侧面板">
              <button
                type="button"
                className={styles.addTabBtn}
                onClick={() => {
                  collapseActiveTabRightDock(true);
                }}
                aria-label="收起右侧面板"
              >
                <IconSidebarRight size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    );
  }
);

LeafToolTabStrip.displayName = 'LeafToolTabStrip';
