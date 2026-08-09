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

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { TabStrip, Tooltip } from '../ui';
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

    const [showAddMenu, setShowAddMenu] = useState(false);
    // 08-步5 T4-2 键盘闭环：加号/菜单容器 ref（Esc 关闭后焦点归还加号）
    const addBtnRef = useRef<HTMLButtonElement | null>(null);
    const addMenuRef = useRef<HTMLDivElement | null>(null);

    // 打开后焦点移入菜单首项（键盘漫游起点）
    useEffect(() => {
      if (showAddMenu) {
        const first = addMenuRef.current?.querySelector<HTMLButtonElement>(
          '[role="menuitem"]'
        );
        first?.focus();
      }
    }, [showAddMenu]);

    const openPanel = useCallback(
      (pid: string) => {
        if (leaf.sessionId) {
          openToolInSession(leaf.sessionId, pid);
        } else {
          openToolInActiveTab(pid);
        }
        setActiveTab(leaf.id, pid);
        setShowAddMenu(false);
      },
      [leaf.id, leaf.sessionId, setActiveTab]
    );

    // 添加菜单键盘：↑↓/Home/End 漫游、Enter 原生激活、Esc 关闭并归还加号焦点
    const handleAddMenuKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(
          e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
        );
        if (items.length === 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          e.stopPropagation();
          const active = document.activeElement;
          const cur = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
          let next: number;
          if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
          else if (e.key === 'ArrowUp')
            next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
          else if (e.key === 'Home') next = 0;
          else next = items.length - 1;
          items[next]?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setShowAddMenu(false);
          addBtnRef.current?.focus();
        }
      },
      []
    );

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
                <Tooltip content="添加功能面板">
                  <button
                    ref={addBtnRef}
                    type="button"
                    className={styles.addTabBtn}
                    onClick={() => {
                      setShowAddMenu((v) => !v);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onKeyDown={(e) => {
                      // 键盘路径：Enter/Space 开关（preventDefault 防原生 click 二次触发）
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowAddMenu((v) => !v);
                      }
                    }}
                    aria-label="添加功能面板"
                    aria-haspopup="menu"
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
                    <div
                      ref={addMenuRef}
                      className={styles.addDropdownMenu}
                      role="menu"
                      onKeyDown={handleAddMenuKeyDown}
                    >
                      {availablePanels.map((pid) => {
                        const label = PANEL_LABELS[pid] || pid;
                        return (
                          <button
                            key={pid}
                            type="button"
                            role="menuitem"
                            className={styles.menuItem}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => openPanel(pid)}
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
            <div
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                paddingRight: '4px',
              }}
            >
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
