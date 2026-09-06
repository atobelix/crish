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
import { useSessionStore, useLayoutStore } from '../../store/storeAccess';
import { useLayoutTreeStore, collectLeaves } from '../../store/layout-tree';
import { getCompositionRoot } from '../../app/compositionRoot';
import { isPendingDraft, mintDraftSessionId } from '../../store/draftSession';
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

/** 关 active 时的邻居：优先左邻，否则右邻（与维 02 removeTab 一致），排除已在离场中的标签 */
function nextAvailableNeighborId(
  tabs: LeafSessionTab[],
  closingTabId: string,
  closingIds: Set<string>
): string | null {
  const alive = tabs.filter(
    (t) => t.tabId === closingTabId || !closingIds.has(t.tabId)
  );
  if (alive.length <= 1) return null;
  const idx = alive.findIndex((t) => t.tabId === closingTabId);
  if (idx < 0) return null;
  const neighbor = idx > 0 ? alive[idx - 1] : alive[idx + 1];
  return neighbor?.tabId ?? null;
}

const TAB_LEAVE_MS = 220;
const DEFAULT_TAB_WIDTH = 240;
const MIN_TAB_WIDTH = 28;
const TAB_GAP = 4;
// 叉号中心相对标签右边缘距离：右 padding 6px + 按钮 18px 半宽 9px = 15px
const CLOSE_BTN_RIGHT_OFFSET = 15;

export const PaneHeader: React.FC<PaneHeaderProps> = React.memo(
  ({ leaf, isActive, isChat }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [closingTabIds, setClosingTabIds] = useState<Set<string>>(() => new Set());
    const [enteringTabIds, setEnteringTabIds] = useState<Set<string>>(() => new Set());
    const leaveTimersRef = useRef<Map<string, number>>(new Map());
    const enterTimersRef = useRef<Map<string, number>>(new Map());
    const knownTabIdsRef = useRef<Set<string>>(new Set());
    const isInitialMountRef = useRef(true);
    const [lockedTabWidth, setLockedTabWidth] = useState<number | null>(null);
    const isHoveringRef = useRef(false);

    const { startSessionDrag } = useSessionTabDrag();
    const sessionsById = useSessionStore((s) => s.sessionsById);

    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
    const setChatMainSurface = useLayoutStore((s) => s.setChatMainSurface);
    const leavesCount = useLayoutTreeStore(
      (s) => collectLeaves(s.tree.root).length
    );
    const isMultiPane = leavesCount > 1;

    // 条带成员计算：已提交会话 tabs，分屏下若无真会话但有草稿保留草稿以支持关闭
    const visibleTabs = useMemo(() => {
      const committedTabs = readLeafTabs(leaf);
      if (committedTabs.length > 0) {
        return committedTabs;
      }
      const raw = leaf.tabs as unknown;
      if (Array.isArray(raw) && raw.length > 0) {
        const first = raw[0] as LeafSessionTab;
        return [
          {
            tabId: first.tabId || `draft-${leaf.id}`,
            sessionId: first.sessionId || '',
            title: '新对话',
          },
        ];
      }
      return isMultiPane
        ? [{ tabId: `pane-${leaf.id}`, sessionId: '', title: '新对话' }]
        : [];
    }, [leaf.id, leaf.tabs, isMultiPane]);

    // 监听新标签入场，触发自然生长动画（首轮挂载不重播，后续新增时平滑生长）
    useEffect(() => {
      const currentIds = new Set(visibleTabs.map((t) => t.tabId));
      if (isInitialMountRef.current) {
        isInitialMountRef.current = false;
        knownTabIdsRef.current = currentIds;
        return;
      }
      const newIds = [...currentIds].filter((id) => !knownTabIdsRef.current.has(id));
      newIds.forEach((id) => knownTabIdsRef.current.add(id));

      if (newIds.length > 0) {
        setEnteringTabIds((prev) => new Set([...prev, ...newIds]));
        newIds.forEach((id) => {
          const timer = window.setTimeout(() => {
            setEnteringTabIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            enterTimersRef.current.delete(id);
          }, 190);
          enterTimersRef.current.set(id, timer);
        });
      }

      knownTabIdsRef.current.forEach((id) => {
        if (!currentIds.has(id)) knownTabIdsRef.current.delete(id);
      });
    }, [visibleTabs]);

    const activeTabId = readActiveTabId(leaf);
    const activeSessionId = useSessionStore((s) => s.activeSessionId);
    const isLeafDraft =
      activeSessionId === mintDraftSessionId(leaf.id) ||
      (isPendingDraft(activeSessionId) && leaf.activeTabId === '');
    const effectiveActiveTabId =
      activeTabId || (isLeafDraft ? '' : visibleTabs[0]?.tabId || '');
    void isActive;

    const clearLockedWidth = useCallback(() => {
      setLockedTabWidth(null);
    }, []);

    const handleHeaderMouseEnter = useCallback(() => {
      isHoveringRef.current = true;
    }, []);

    const handleHeaderMouseLeave = useCallback(
      (e: React.MouseEvent) => {
        const nextTarget = e.relatedTarget;
        if (
          nextTarget &&
          typeof Node !== 'undefined' &&
          nextTarget instanceof Node
        ) {
          const headerEl =
            containerRef.current?.closest('[data-pane-header="true"]') ||
            e.currentTarget;
          if (headerEl.contains(nextTarget)) {
            return;
          }
        }
        isHoveringRef.current = false;
        clearLockedWidth();
      },
      [clearLockedWidth]
    );

    useEffect(
      () => () => {
        leaveTimersRef.current.forEach((t) => window.clearTimeout(t));
        leaveTimersRef.current.clear();
        enterTimersRef.current.forEach((t) => window.clearTimeout(t));
        enterTimersRef.current.clear();
      },
      []
    );

    // 智能固定加号（Smart Pinning）与容器宽度监听
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const checkMetrics = () => {
        const overflow = el.scrollWidth > el.clientWidth + 2;
        setHasOverflow(overflow);
        setContainerWidth(el.clientWidth);
      };

      checkMetrics();

      let ro: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(checkMetrics);
        ro.observe(el);
      }

      return () => {
        ro?.disconnect();
      };
    }, [visibleTabs.length]);

    // 严格等宽基准宽度计算：有空余时标准 240px，空间紧缩时全员严格同比例均分压缩，严禁溢出视野
    const naturalTabWidth = useMemo(() => {
      const count = visibleTabs.length;
      if (count <= 0 || containerWidth <= 0) {
        return DEFAULT_TAB_WIDTH;
      }
      const nonTabSpace = 36;
      const available = Math.max(0, containerWidth - nonTabSpace);
      const totalNeeded = count * DEFAULT_TAB_WIDTH + (count - 1) * TAB_GAP;
      if (totalNeeded <= available) {
        return DEFAULT_TAB_WIDTH;
      }
      const fitted = Math.floor((available - (count - 1) * TAB_GAP) / count);
      return Math.max(MIN_TAB_WIDTH, fitted);
    }, [visibleTabs.length, containerWidth]);

    const effectiveTabWidth = lockedTabWidth ?? naturalTabWidth;

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
        if (closingTabIds.has(tab.tabId)) return;
        sessionShell().activateTab(leaf.id, tab.tabId);
      },
      [closingTabIds, leaf.id]
    );

    const handleTabClose = useCallback(
      (e: React.MouseEvent, tab: LeafSessionTab) => {
        e.stopPropagation();
        if (closingTabIds.has(tab.tabId)) return;

        const tabs = visibleTabs;
        const currentActive = readActiveTabId(leaf);
        // 关的是本叶 active 且还有邻居：立刻切邻居，优先右邻（正好滑到光标下）
        if (tab.tabId === currentActive && tabs.length > 1) {
          const nextActiveId = nextAvailableNeighborId(
            tabs,
            tab.tabId,
            closingTabIds
          );
          if (nextActiveId) {
            sessionShell().activateTab(leaf.id, nextActiveId);
          }
        }

        // 当前存活（尚未处于离场中）的标签列表
        const currentAlive = tabs.filter((t) => !closingTabIds.has(t.tabId));
        const closingIndex = currentAlive.findIndex((t) => t.tabId === tab.tabId);
        // 是否删的是最右端标签（右侧已经没有其它标签可供向左补位）
        const isRightmost = closingIndex >= 0 && closingIndex === currentAlive.length - 1;
        const remainingCount = currentAlive.length - 1;

        const measureWidth = (target: EventTarget | null) => {
          const tabEl = (target as HTMLElement | null)?.closest?.('[role="tab"]') as HTMLElement | null;
          const w = tabEl?.getBoundingClientRect().width || tabEl?.offsetWidth;
          return w && w > 0 ? Math.round(w) : effectiveTabWidth;
        };

        if (remainingCount > 0) {
          if (!isRightmost) {
            // 分支 A：右侧还有存活标签，右邻标签等宽平移补位，叉号自动落在鼠标光标下
            setLockedTabWidth((prev) => (prev != null && prev > 0 ? prev : measureWidth(e.currentTarget)));
          } else {
            // 分支 B：删的是末尾标签（右侧已无标签可向左补位）
            const containerEl = containerRef.current;
            const containerRect = containerEl?.getBoundingClientRect();
            const mouseXInContainer =
              containerRect && e.clientX > 0
                ? e.clientX - containerRect.left + (containerEl?.scrollLeft || 0)
                : null;

            if (mouseXInContainer != null && mouseXInContainer > 0) {
              const neededWidth =
                (mouseXInContainer +
                  CLOSE_BTN_RIGHT_OFFSET -
                  (remainingCount - 1) * TAB_GAP) /
                remainingCount;

              if (neededWidth <= DEFAULT_TAB_WIDTH) {
                setLockedTabWidth(Math.max(MIN_TAB_WIDTH, Math.round(neededWidth)));
              } else {
                setLockedTabWidth(DEFAULT_TAB_WIDTH);
              }
            } else {
              setLockedTabWidth((prev) => (prev != null && prev > 0 ? prev : measureWidth(e.currentTarget)));
            }
          }
        } else {
          clearLockedWidth();
        }

        setClosingTabIds((prev) => new Set(prev).add(tab.tabId));

        const timerId = window.setTimeout(() => {
          sessionShell().removeTab(leaf.id, tab.tabId);
          setClosingTabIds((prev) => {
            const next = new Set(prev);
            next.delete(tab.tabId);
            return next;
          });
          leaveTimersRef.current.delete(tab.tabId);
        }, TAB_LEAVE_MS);

        leaveTimersRef.current.set(tab.tabId, timerId);
      },
      [closingTabIds, effectiveTabWidth, leaf, visibleTabs, clearLockedWidth]
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
      clearLockedWidth();
      sessionShell().addTab(leaf.id);
    }, [clearLockedWidth, leaf.id]);

    if (!isChat) {
      return null;
    }

    if (chatMainSurface === 'scheduled') {
      return (
        <div
          className={styles.paneHeader}
          data-pane-header="true"
          data-tauri-drag-region
          onPointerDown={handleHeaderPointerDown}
        />
      );
    }

    return (
      <div
        className={`${styles.paneHeader} ${hasOverflow ? styles.hasOverflow : ''}`}
        data-pane-header="true"
        data-tauri-drag-region
        onPointerDown={handleHeaderPointerDown}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <div
          ref={containerRef}
          className={`${styles.tabsContainer} ${lockedTabWidth != null ? styles.isLocked : ''}`}
          style={
            {
              '--tab-item-width': `${effectiveTabWidth}px`,
              ...(lockedTabWidth != null
                ? { '--tab-locked-width': `${lockedTabWidth}px` }
                : {}),
            } as React.CSSProperties
          }
          data-locked={lockedTabWidth != null ? 'true' : 'false'}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
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
              const isSelected = tab.tabId === effectiveActiveTabId;
              const session = tab.sessionId
                ? sessionsById[tab.sessionId]
                : undefined;
              const title = session?.title || tab.title || '新对话';
              const isLeaving = closingTabIds.has(tab.tabId);
              const isEntering = enteringTabIds.has(tab.tabId);

              return (
                <div
                  key={tab.tabId}
                  className={`${styles.tabItem} ${isSelected ? styles.tabItemActive : ''} ${isLeaving ? styles.tabItemLeaving : ''} ${isEntering ? styles.tabItemEntering : ''}`}
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
                  aria-selected={isSelected}
                  aria-label={title}
                  data-tab-id={tab.tabId}
                  data-session-id={tab.sessionId || undefined}
                >
                  <span className={styles.tabTitle}>{title}</span>
                  <button
                    type="button"
                    className={styles.tabCloseBtn}
                    onClick={(e) => handleTabClose(e, tab)}
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
