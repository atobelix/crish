/**
 * PaneHeader — 窗格专属独立标签栏（高度锁定 var(--header-height)）
 *
 * 核心契约：
 * 1. 物理嵌套于 TreeLeafPanel 内部，充当卡片岛屿外置头顶；
 * 2. 无论单窗格还是多分屏，与下方内容卡片严格 1:1 同宽、左对齐；
 * 3. 只承载本叶 leaf.tabs 会话标签；工具标签在抽屉头；
 * 4. 支持横向滚轮重定向与 Smart Pinning 双态加号（随流位 + 溢出固定位）。
 * 条带只画已发送成功的真会话；未提交的新对话不占标签。
 * 禁止复活 ChatHeader / UnitSessionTabStrip / GlobalSessionTabBar。
 *
 * 动效与交互单一真理路径：
 * - 入场 = @starting-style + transition，零 JS 状态，首轮挂载经 data-booted 门控；
 * - 离场 = [data-leaving] 目标态 + transitionend(flex-basis) 驱动 removeTab，
 *   保险丝按真实 computed 时长 ×3 兜底；
 * - 等宽锁定仅经 --pane-tab-item-width 单变量通道；
 * - 窗口拖拽 = 阈值门控 startDragging 单通道；标签拖拽换位走 SessionTabDragContext；
 * - 关闭量测在事件派发期内同步完成，几何数学在 paneHeaderGeometry（可穷举测试）。
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { LayoutLeaf } from '../../store/types';
import {
  useSessionStore,
  useShallow,
  useLayoutStore,
  useLayoutTreeStore,
  collectLeaves,
} from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { useSessionTabDrag } from '../shell/SessionTabDragContext';
import { NON_TAB_SPACE_PX, TAB_GAP_PX } from '../../utils/tabStripGeometry';
import { paneTabStripVars } from './tabStripVars';
import { DURATION_FAST_MS, readTransitionMs } from '../../utils/motionTokens';
import { useTablistKeyboard } from '../../hooks/useTablistKeyboard';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import {
  computeCloseLockWidth,
  computeNaturalTabWidth,
  nextAvailableNeighborId,
  type LeafSessionTab,
} from './paneHeaderGeometry';
import { isLeafInDraftMode } from './treeLeafPanelModel';
import {
  computeVisibleLeafTabs,
  isMouseStillInsideHeader,
  readActiveTabId,
  readCommittedLeafTabs,
} from './paneHeaderModel';
import { PaneTabItem } from './PaneTabItem';
import styles from './PaneHeader.module.css';
import { NewTabLauncherPopover } from './NewTabLauncherPopover';

export interface PaneHeaderProps {
  leaf: LayoutLeaf;
  isActive: boolean;
  isChat: boolean;
  isTopRow?: boolean;
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

export const PaneHeader: React.FC<PaneHeaderProps> = React.memo(
  ({ leaf, isActive, isChat, isTopRow = true }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
    const setContainerRef = useCallback((node: HTMLDivElement | null) => {
      containerRef.current = node;
      setContainerEl(node);
    }, []);
    const [containerWidth, setContainerWidth] = useState(0);
    const [booted, setBooted] = useState(false);
    const closingIdsRef = useRef<Set<string>>(new Set());
    const [closingTabIds, setClosingTabIds] = useState<Set<string>>(
      () => new Set()
    );
    const fuseTimersRef = useRef<Map<string, number>>(new Map());
    const pendingActivateRafsRef = useRef<number[]>([]);
    const [lockedTabWidth, setLockedTabWidth] = useState<number | null>(null);

    const { startSessionDrag } = useSessionTabDrag();

    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
    const leavesCount = useLayoutTreeStore(
      (s) => collectLeaves(s.tree.root).length
    );
    const isMultiPane = leavesCount > 1;

    // 条带成员计算：已提交会话 tabs，分屏下若无真会话但有草稿保留草稿以支持关闭
    const visibleTabs = useMemo(
      () => computeVisibleLeafTabs(leaf, isMultiPane),
      [leaf, isMultiPane]
    );
    const hasCommittedTabs = useMemo(
      () => readCommittedLeafTabs(leaf).length > 0,
      [leaf]
    );
    const sessionTitlesById = useSessionStore(
      useShallow((s) => {
        const titles: Record<string, string | undefined> = {};
        for (const tab of visibleTabs) {
          if (tab.sessionId) {
            titles[tab.sessionId] = s.sessionsById[tab.sessionId]?.title;
          }
        }
        return titles;
      })
    );

    // 入场动画门控：首轮挂载后的首个副作用之后才允许 @starting-style 生效
    useEffect(() => {
      setBooted(true);
    }, []);

    const activeTabId = readActiveTabId(leaf);
    const isLeafDraft = isLeafInDraftMode(leaf);
    const effectiveActiveTabId =
      activeTabId ||
      (isLeafDraft && hasCommittedTabs ? '' : visibleTabs[0]?.tabId || '');

    const clearLockedWidth = useCallback(() => {
      setLockedTabWidth(null);
    }, []);

    const handleHeaderMouseLeave = useCallback(
      (e: React.MouseEvent) => {
        if (isMouseStillInsideHeader(e, containerRef.current)) {
          return;
        }
        clearLockedWidth();
      },
      [clearLockedWidth]
    );

    // 当存在锁定宽度时，监听全局指针移动：一旦光标脱离整个顶栏物理区域，平滑解除锁定还原自然宽
    useEffect(() => {
      if (lockedTabWidth == null) return;

      const headerEl = containerRef.current?.closest(
        '[data-pane-header="true"]'
      );
      if (!headerEl) {
        clearLockedWidth();
        return;
      }
      // 锁定期间顶栏物理矩形位置固定，初始读取并缓存，杜绝 pointermove 高频触发 forced reflow
      const cachedRect = headerEl.getBoundingClientRect();

      const handlePointerMove = (e: PointerEvent) => {
        if (
          e.clientX < cachedRect.left ||
          e.clientX > cachedRect.right ||
          e.clientY < cachedRect.top ||
          e.clientY > cachedRect.bottom
        ) {
          clearLockedWidth();
        }
      };

      const handleBlur = () => {
        clearLockedWidth();
      };

      window.addEventListener('pointermove', handlePointerMove, {
        passive: true,
      });
      window.addEventListener('blur', handleBlur);
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('blur', handleBlur);
      };
    }, [lockedTabWidth, clearLockedWidth]);

    // 组件卸载：清保险丝计时与未决的邻居激活帧
    useEffect(
      () => () => {
        fuseTimersRef.current.forEach((t) => window.clearTimeout(t));
        fuseTimersRef.current.clear();
        pendingActivateRafsRef.current.forEach((id) =>
          cancelAnimationFrame(id)
        );
        pendingActivateRafsRef.current = [];
      },
      []
    );

    // 容器宽度监听（统一接入 ResizeObserverManager 批处理，动态跟随 DOM 节点挂载生命周期）
    useEffect(() => {
      if (!containerEl) return;

      const checkMetrics = (entry?: ResizeObserverEntry) => {
        const w =
          typeof entry?.contentRect?.width === 'number'
            ? Math.round(entry.contentRect.width)
            : containerEl.clientWidth;
        setContainerWidth(w);
      };

      checkMetrics();

      const ro = ResizeObserverManager.getInstance();
      ro.observe(containerEl, checkMetrics);

      return () => {
        ro.unobserve(containerEl, checkMetrics);
      };
    }, [containerEl]);

    const currentMeasuredWidth =
      containerWidth > 0
        ? containerWidth
        : containerEl?.clientWidth || containerRef.current?.clientWidth || 0;

    const effectiveTabWidth =
      lockedTabWidth ??
      computeNaturalTabWidth(visibleTabs.length, currentMeasuredWidth);

    // 强制阻止任何横向滚动漂移，保障全量标签永远在视口内全景显示
    const handleScroll = useCallback(() => {
      const el = containerRef.current;
      if (el && el.scrollLeft !== 0) {
        el.scrollLeft = 0;
      }
    }, []);

    useEffect(() => {
      const el = containerRef.current;
      if (el && el.scrollLeft !== 0) {
        el.scrollLeft = 0;
      }
    }, [containerWidth, visibleTabs.length, lockedTabWidth]);

    const handleTablistKeyDown = useTablistKeyboard(containerRef, {
      tabSelector: '[role="tab"]',
      readTabId: (el) => el.getAttribute('data-tab-id'),
      onActivate: (tabId) => {
        if (!closingIdsRef.current.has(tabId)) {
          sessionShell().activateTab(leaf.id, tabId);
        }
      },
    });

    const handleTabClick = useCallback(
      (tab: LeafSessionTab) => {
        if (closingIdsRef.current.has(tab.tabId)) return;
        sessionShell().activateTab(leaf.id, tab.tabId);
      },
      [leaf.id]
    );

    const finalizeClose = useCallback(
      (tabId: string) => {
        if (!closingIdsRef.current.has(tabId)) return;
        closingIdsRef.current.delete(tabId);
        setClosingTabIds(new Set(closingIdsRef.current));
        const fuse = fuseTimersRef.current.get(tabId);
        if (fuse != null) {
          window.clearTimeout(fuse);
          fuseTimersRef.current.delete(tabId);
        }
        sessionShell().removeTab(leaf.id, tabId);
      },
      [leaf.id]
    );

    const handleTabClose = useCallback(
      (e: React.MouseEvent, tab: LeafSessionTab) => {
        e.stopPropagation();
        if (closingIdsRef.current.has(tab.tabId)) return;

        const tabs = visibleTabs;
        const currentActive = readActiveTabId(leaf);
        // 关的是本叶 active 且还有邻居：先算邻居，延后两帧再切——
        // 条带离场首帧先行绘制，内容面切换与条带动画不同帧争抢主线程
        if (tab.tabId === currentActive && tabs.length > 1) {
          const nextActiveId = nextAvailableNeighborId(
            tabs,
            tab.tabId,
            closingIdsRef.current
          );
          if (nextActiveId) {
            const raf1 = requestAnimationFrame(() => {
              const raf2 = requestAnimationFrame(() => {
                React.startTransition(() => {
                  sessionShell().activateTab(leaf.id, nextActiveId);
                });
                pendingActivateRafsRef.current =
                  pendingActivateRafsRef.current.filter((id) => id !== raf2);
              });
              pendingActivateRafsRef.current.push(raf2);
            });
            pendingActivateRafsRef.current.push(raf1);
          }
        }

        // 当前存活（尚未处于离场中）的标签列表
        const currentAlive = tabs.filter(
          (t) => !closingIdsRef.current.has(t.tabId)
        );
        const closingIndex = currentAlive.findIndex(
          (t) => t.tabId === tab.tabId
        );
        const isRightmost =
          closingIndex >= 0 && closingIndex === currentAlive.length - 1;
        const remainingCount = currentAlive.length - 1;

        // 量测必须在事件派发期内同步完成（DOM 读数与 currentTarget 只在派发期可靠）
        const tabEl = (e.currentTarget as HTMLElement).closest(
          '[role="tab"]'
        ) as HTMLElement | null;
        const rectWidth = tabEl?.getBoundingClientRect().width || 0;
        const measuredWidth =
          rectWidth > 0
            ? Math.round(rectWidth)
            : Math.round(tabEl?.offsetWidth || 0) || effectiveTabWidth;

        if (remainingCount > 0) {
          const containerEl = containerRef.current;
          const containerRect = containerEl?.getBoundingClientRect();
          const listEl = containerEl?.querySelector(
            `.${styles.tabsList}`
          ) as HTMLElement | null;
          const listRect = listEl?.getBoundingClientRect();
          const baseLeft =
            listRect && listRect.left > 0
              ? listRect.left
              : containerRect?.left || 0;
          const mouseXInContainer =
            containerRect && e.clientX > 0
              ? e.clientX - baseLeft + (containerEl?.scrollLeft || 0)
              : null;
          const maxFittingWidth =
            containerWidth > 0
              ? Math.floor(
                  (containerWidth -
                    NON_TAB_SPACE_PX -
                    (remainingCount - 1) * TAB_GAP_PX) /
                    remainingCount
                )
              : undefined;
          const lockWidth = computeCloseLockWidth({
            isRightmost,
            remainingCount,
            mouseXInContainer,
            measuredWidth,
            maxFittingWidth,
          });
          if (isRightmost) {
            setLockedTabWidth(lockWidth);
          } else {
            setLockedTabWidth((prev) =>
              prev != null && prev > 0 ? prev : lockWidth
            );
          }
        } else {
          clearLockedWidth();
        }

        closingIdsRef.current.add(tab.tabId);
        setClosingTabIds(new Set(closingIdsRef.current));

        // 保险丝：transitionend 万一丢失，按真实 computed 时长 ×3 兜底摘除
        if (tabEl) {
          const ms = readTransitionMs(tabEl, 'flex-basis') || DURATION_FAST_MS;
          const fuse = window.setTimeout(
            () => finalizeClose(tab.tabId),
            ms * 3
          );
          fuseTimersRef.current.set(tab.tabId, fuse);
        }
      },
      [visibleTabs, leaf, effectiveTabWidth, clearLockedWidth, finalizeClose]
    );

    const handleNewTab = useCallback(() => {
      clearLockedWidth();
      sessionShell().addTab(leaf.id);
    }, [clearLockedWidth, leaf.id]);

    const handleLeaveTransitionEnd = useCallback(
      (e: React.TransitionEvent<HTMLDivElement>, tab: LeafSessionTab) => {
        if (e.target !== e.currentTarget) return;
        if (e.propertyName !== 'flex-basis') return;
        if (!closingIdsRef.current.has(tab.tabId)) return;
        finalizeClose(tab.tabId);
      },
      [finalizeClose]
    );

    if (!isChat) {
      return null;
    }

    if (chatMainSurface === 'scheduled' || chatMainSurface === 'extensions') {
      return (
        <div
          className={styles.paneHeader}
          data-pane-header="true"
          data-active={isActive ? 'true' : 'false'}
          data-top-row={isTopRow ? 'true' : undefined}
          data-tauri-drag-region={isTopRow ? '' : undefined}
        />
      );
    }

    return (
      <div
        className={styles.paneHeader}
        data-pane-header="true"
        data-active={isActive ? 'true' : 'false'}
        data-top-row={isTopRow ? 'true' : undefined}
        data-tauri-drag-region={isTopRow ? '' : undefined}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <div
          ref={setContainerRef}
          className={styles.tabsContainer}
          style={paneTabStripVars(effectiveTabWidth)}
          data-locked={lockedTabWidth != null ? 'true' : 'false'}
          data-booted={booted ? 'true' : 'false'}
          data-tauri-drag-region={isTopRow ? '' : undefined}
          onScroll={handleScroll}
          onMouseLeave={handleHeaderMouseLeave}
          onKeyDown={handleTablistKeyDown}
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
          <div className={styles.tabsList} data-tauri-drag-region="false">
            {visibleTabs.map((tab) => {
              const isSelected = tab.tabId === effectiveActiveTabId;
              const sessionTitle = tab.sessionId
                ? sessionTitlesById[tab.sessionId]
                : undefined;
              const title = sessionTitle || tab.title || '新对话';

              return (
                <PaneTabItem
                  key={tab.tabId}
                  tab={tab}
                  title={title}
                  isSelected={isSelected}
                  isLeaving={closingTabIds.has(tab.tabId)}
                  onSelect={handleTabClick}
                  onClose={handleTabClose}
                  onDragStart={(e, t) =>
                    startSessionDrag(leaf.id, t.tabId, title, e)
                  }
                  onLeaveTransitionEnd={handleLeaveTransitionEnd}
                />
              );
            })}
          </div>

          <div
            className={styles.launcherWrapper}
            data-tauri-drag-region="false"
            onDoubleClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                const triggerBtn = e.currentTarget.querySelector('button');
                triggerBtn?.click();
              }
            }}
          >
            <NewTabLauncherPopover
              leafId={leaf.id}
              onBeforeOpen={clearLockedWidth}
            />
          </div>
        </div>
      </div>
    );
  }
);

PaneHeader.displayName = 'PaneHeader';
