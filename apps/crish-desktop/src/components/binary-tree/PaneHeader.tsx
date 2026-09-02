/**
 * PaneHeader — 窗格专属独立标签栏（高度严格锁定 36px）
 *
 * 核心契约：
 * 1. 物理嵌套于 TreeLeafPanel 内部，充当卡片岛屿外置头顶；
 * 2. 无论单窗格还是多分屏，与下方内容卡片严格 1:1 同宽、左对齐；
 * 3. 只承载本叶 leaf.tabs 会话标签；工具标签在抽屉头；
 * 4. 支持横向滚轮重定向与 Smart Pinning 智能固定加号。
 * 条带只画已发送成功的真会话；未提交的新对话不占标签。
 * 禁止复活 ChatHeader / UnitSessionTabStrip / GlobalSessionTabBar。
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import type { LayoutLeaf } from '../../store/types';
import { useSessionStore } from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { isPendingDraft } from '../../store/draftSession';
import { useSessionTabDrag } from '../shell/SessionTabDragContext';
import styles from './PaneHeader.module.css';

export interface PaneHeaderProps {
  leaf: LayoutLeaf;
  isActive: boolean;
  isChat: boolean;
}

/** 本叶条带成员：维 01 SessionTab 形状（含草稿） */
interface LeafSessionTab {
  tabId: string;
  sessionId: string;
  title?: string;
}

/** 维 03 门面：两实参 activateTab / addTab / removeTab */
type SessionShellCommands = {
  activateTab: (leafId: string, tabId: string) => void;
  addTab: (leafId: string) => void;
  removeTab: (leafId: string, tabId: string) => void;
};

function sessionShell(): SessionShellCommands {
  return getCompositionRoot().shell as unknown as SessionShellCommands;
}

function readLeafTabs(leaf: LayoutLeaf): LeafSessionTab[] {
  const raw = leaf.tabs as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is LeafSessionTab =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as LeafSessionTab).tabId === 'string' &&
      !isPendingDraft((t as LeafSessionTab).sessionId)
  );
}

function readActiveTabId(leaf: LayoutLeaf): string {
  const id = (leaf as LayoutLeaf & { activeTabId?: string }).activeTabId;
  return typeof id === 'string' ? id : '';
}

/** 关 active 时的邻居：优先左邻，否则右邻（与维 02 removeTab 一致） */
function neighborTabId(
  tabs: LeafSessionTab[],
  closingTabId: string
): string | null {
  if (tabs.length <= 1) return null;
  const idx = tabs.findIndex((t) => t.tabId === closingTabId);
  if (idx < 0) return null;
  const neighbor = idx > 0 ? tabs[idx - 1] : tabs[idx + 1];
  return neighbor?.tabId ?? null;
}

const TAB_LEAVE_MS = 220;

export const PaneHeader: React.FC<PaneHeaderProps> = React.memo(
  ({ leaf, isActive, isChat }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const leaveTimerRef = useRef<number | null>(null);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [leavingTabId, setLeavingTabId] = useState<string | null>(null);

    const { startSessionDrag } = useSessionTabDrag();
    const sessionsById = useSessionStore((s) => s.sessionsById);

    // 条带成员 = 本叶已提交的真会话 tabs，禁止投影 openTabs
    const visibleTabs = useMemo(() => readLeafTabs(leaf), [leaf.tabs]);
    const activeTabId = readActiveTabId(leaf);
    void isActive;

    useEffect(
      () => () => {
        if (leaveTimerRef.current != null) {
          window.clearTimeout(leaveTimerRef.current);
        }
      },
      []
    );

    // 智能固定加号（Smart Pinning）
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const checkOverflow = () => {
        const overflow = el.scrollWidth > el.clientWidth + 2;
        setHasOverflow(overflow);
      };

      checkOverflow();

      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(checkOverflow);
        ro.observe(el);
      }

      return () => {
        ro?.disconnect();
      };
    }, [visibleTabs.length]);

    const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, []);

    const handleTabClick = useCallback(
      (tab: LeafSessionTab) => {
        sessionShell().activateTab(leaf.id, tab.tabId);
      },
      [leaf.id]
    );

    const handleTabClose = useCallback(
      (e: React.MouseEvent, tab: LeafSessionTab) => {
        e.stopPropagation();
        const tabs = readLeafTabs(leaf);
        const currentActive = readActiveTabId(leaf);
        // 关的是本叶 active 且还有邻居：立刻切邻居，避免 220ms 离场闪白
        if (tab.tabId === currentActive && tabs.length > 1) {
          const neighbor = neighborTabId(tabs, tab.tabId);
          if (neighbor) {
            sessionShell().activateTab(leaf.id, neighbor);
          }
        }
        setLeavingTabId(tab.tabId);
        if (leaveTimerRef.current != null) {
          window.clearTimeout(leaveTimerRef.current);
        }
        leaveTimerRef.current = window.setTimeout(() => {
          sessionShell().removeTab(leaf.id, tab.tabId);
          setLeavingTabId((cur) => (cur === tab.tabId ? null : cur));
          leaveTimerRef.current = null;
        }, TAB_LEAVE_MS);
      },
      [leaf]
    );

    const handleMouseDown = useCallback(
      (e: React.MouseEvent, tab: LeafSessionTab) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          handleTabClose(e, tab);
        }
      },
      [handleTabClose]
    );

    const handleAuxClick = useCallback(
      (e: React.MouseEvent, tab: LeafSessionTab) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          handleTabClose(e, tab);
        }
      },
      [handleTabClose]
    );

    const handleHeaderPointerDown = useCallback((e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest?.('button') || target.closest?.('[role="tab"]')) {
        return;
      }
      void import('@tauri-apps/api/window')
        .then((w) => w.getCurrentWindow().startDragging())
        .catch(() => {});
    }, []);

    const handleNewTab = useCallback(() => {
      sessionShell().addTab(leaf.id);
    }, [leaf.id]);

    if (!isChat) {
      return null;
    }

    return (
      <div
        className={`${styles.paneHeader} ${hasOverflow ? styles.hasOverflow : ''}`}
        data-pane-header="true"
        data-tauri-drag-region
        onPointerDown={handleHeaderPointerDown}
      >
        <div
          ref={containerRef}
          className={styles.tabsContainer}
          onWheel={handleWheel}
          onDoubleClick={(e) => {
            if (
              e.target === containerRef.current ||
              (styles.tabsList
                ? (e.target as HTMLElement).classList.contains(styles.tabsList)
                : false)
            ) {
              handleNewTab();
            }
          }}
          role="tablist"
          aria-label="窗格会话标签"
        >
          <div className={styles.tabsList}>
            {visibleTabs.map((tab) => {
              const isSelected = tab.tabId === activeTabId;
              const session = tab.sessionId
                ? sessionsById[tab.sessionId]
                : undefined;
              const title = session?.title || tab.title || '新对话';
              const isLeaving = leavingTabId === tab.tabId;

              return (
                <div
                  key={tab.tabId}
                  className={`${styles.tabItem} ${isSelected ? styles.tabItemActive : ''} ${isLeaving ? styles.tabItemLeaving : ''}`}
                  data-tauri-drag-region="false"
                  onClick={() => handleTabClick(tab)}
                  onMouseDown={(e) => handleMouseDown(e, tab)}
                  onAuxClick={(e) => handleAuxClick(e, tab)}
                  onPointerDown={(e) => {
                    if (e.button === 0) {
                      e.stopPropagation();
                      startSessionDrag(leaf.id, tab.tabId, title, e);
                    }
                  }}
                  role="tab"
                  aria-selected={tab.tabId === activeTabId}
                  title={title}
                  data-tab-id={tab.tabId}
                  data-session-id={tab.sessionId || undefined}
                >
                  <span className={styles.tabTitle}>{title}</span>
                  <button
                    type="button"
                    className={styles.tabCloseBtn}
                    onClick={(e) => handleTabClose(e, tab)}
                    title="关闭标签页"
                    aria-label={`关闭 ${title}`}
                  >
                    <X size={10} strokeWidth={2.2} />
                  </button>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className={`${styles.newTabBtn} ${styles.inFlow}`}
            data-tauri-drag-region="false"
            onClick={handleNewTab}
            title="新对话"
            aria-label="新对话"
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>

        <div className={styles.fixedCluster} data-tauri-drag-region="false">
          <button
            type="button"
            className={`${styles.newTabBtn} ${styles.pinned}`}
            data-tauri-drag-region="false"
            onClick={handleNewTab}
            title="新对话"
            aria-label="新对话"
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
    );
  }
);

PaneHeader.displayName = 'PaneHeader';
