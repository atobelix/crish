/**
 * GlobalSessionTabBar — 全局会话标签行（最顶 AppTopBar 中间）。
 *
 * 决策：docs/plans/progress/shell-global-tab-bar.md
 * - openTabs 唯一主标签 UI；非 per-leaf multi-strip
 * - 默认 variant=caption 嵌在 AppTopBar（最顶可见，对齐参考图）
 * - tab 等宽；「+」→ openNewDraftTab only
 *
 * 数据属性：data-global-session-tab-bar / data-topbar-session-id
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { MessageSquarePlus, Pin, X } from 'lucide-react';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
} from '../../api/projectStore';
import { currentWorkspaceFolderKey } from '../../api/workspaceChromeTabs';
import {
  EMPTY_SESSION_TITLE,
  sessionListDisplayTitle,
} from '../../api/sessionTitle';
import { getSessionById } from '../../store/sessionStore';
import {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  resolveStripWorkspaceKey,
  createDefaultDock,
  type TabSurface,
} from '../../store/workspace-shell';
import { isPendingDraft } from '../../store/draftSession';
import { getCompositionRoot } from '../../app/compositionRoot';
import { emitUiEvent } from '../../api/uiEvents';
import { Tooltip } from '../Tooltip';
import {
  openTabsStripRelevantEqual,
  readStripOverflow as readUnitStripOverflow,
} from '../binary-tree/UnitSessionTabStrip';
import styles from './GlobalSessionTabBar.module.css';

/** Re-export for shell barrel / tests（与 UnitSessionTabStrip 同形窄相等） */
export { openTabsStripRelevantEqual };

/** 读 scroll 容器溢出边（别名：index 与历史 API 名） */
export function readStripOverflow(el: HTMLElement): {
  start: boolean;
  end: boolean;
} {
  return readUnitStripOverflow(el);
}

const ICON_SIZE = 16;
const TAB_ICON_STROKE = 1.75;

export interface GlobalSessionTabBarProps {
  /**
   * 会话标签拖拽入口（App 顶栏 / useTopBarDrag）。
   * 未传入时退化为纯点击。
   */
  startSessionDrag?: (
    sessionId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
  /**
   * caption：嵌在 AppTopBar 中间（最顶一行，对齐参考图）
   * standalone：独立条（备用）
   */
  variant?: 'caption' | 'standalone';
}

function currentWsKey(): string {
  return (
    canonicalSessionFolder(currentWorkspaceFolderKey(getActiveProjectId())) ||
    GENERAL_FOLDER
  );
}

function resolveTabTitle(sessionId: string, shellTitle?: string): string {
  if (isPendingDraft(sessionId)) {
    return (shellTitle || '').trim() || '新对话';
  }
  const fromShell = (shellTitle || '').trim();
  if (fromShell) return fromShell;
  const sess = getSessionById(sessionId);
  if (sess) {
    return sessionListDisplayTitle(sess) || sess.title || EMPTY_SESSION_TITLE;
  }
  return EMPTY_SESSION_TITLE || '未命名会话';
}

function tabsInWorkspace(
  openTabs: readonly TabSurface[],
  workspaceKey: string
): TabSurface[] {
  const ws = (workspaceKey ?? '').trim();
  return openTabs.filter((t) => (t.workspaceKey ?? '').trim() === ws);
}

export const GlobalSessionTabBar: React.FC<GlobalSessionTabBarProps> =
  React.memo(({ startSessionDrag, variant = 'caption' }) => {
    const openTabs = useStoreWithEqualityFn(
      useWorkspaceShellStore,
      (s) => s.openTabs,
      openTabsStripRelevantEqual
    );
    const activeTabId = useWorkspaceShellStore((s) => s.activeTabId);
    const activeSessionId = useWorkspaceShellStore(selectActiveTabSessionId);

    const sessionTabs = useMemo(() => {
      const fallback = currentWsKey();
      // draft 态：用当前项目 key 展示该工作区全部真实 tab（勿因 draft workspace 滤空）
      const workspaceKey = isPendingDraft(activeSessionId || '')
        ? fallback
        : resolveStripWorkspaceKey(
            openTabs,
            activeTabId,
            activeSessionId,
            fallback
          );
      // 标签行只显示真实会话；PENDING_DRAFT 不是带字标签
      const realOpen = openTabs.filter((t) => !isPendingDraft(t.sessionId));
      let pool = tabsInWorkspace(realOpen, workspaceKey);
      if (pool.length === 0 && realOpen.length > 0) {
        pool = [...realOpen];
      }
      const seen = new Set(pool.map((t) => t.tabId));
      const list = [...pool];
      if (activeTabId) {
        const active = realOpen.find((t) => t.tabId === activeTabId);
        if (active && !seen.has(active.tabId)) {
          list.push(active);
          seen.add(active.tabId);
        }
      }
      // 仅恢复真实会话（禁止把 draft 合成假标签）
      if (
        list.length === 0 &&
        activeSessionId &&
        !isPendingDraft(activeSessionId)
      ) {
        list.push({
          tabId: `recover_${activeSessionId}`,
          kind: 'conversation',
          sessionId: activeSessionId,
          workspaceKey: fallback || GENERAL_FOLDER,
          title: resolveTabTitle(activeSessionId),
          rightDock: createDefaultDock(),
        });
      }
      return list.map((t) => {
        const sess = getSessionById(t.sessionId);
        return {
          tabId: t.tabId,
          sessionId: t.sessionId,
          title: resolveTabTitle(t.sessionId, t.title),
          pinned: Boolean(sess?.isPinned),
        };
      });
    }, [openTabs, activeTabId, activeSessionId]);

    // 丢 tab 恢复：仅真实会话；draft 态不 openOrFocus（会污染 openTabs）
    useEffect(() => {
      const sid = (activeSessionId || '').trim();
      if (!sid || isPendingDraft(sid)) return;
      const shell = useWorkspaceShellStore.getState();
      if (shell.openTabs.some((t) => t.sessionId === sid)) return;
      shell.openOrFocusSession(sid);
    }, [activeSessionId, openTabs.length]);

    const selectSession = useCallback((sessionId: string) => {
      const shell = useWorkspaceShellStore.getState();
      const existing = shell.openTabs.find((t) => t.sessionId === sessionId);
      if (existing) {
        if (shell.activeTabId !== existing.tabId) {
          shell.activateTab(existing.tabId);
        }
        return;
      }
      shell.openOrFocusSession(sessionId);
    }, []);

    const onCloseSession = useCallback(
      (sessionId: string, e?: React.MouseEvent | React.KeyboardEvent) => {
        e?.preventDefault();
        e?.stopPropagation();
        useWorkspaceShellStore
          .getState()
          .closeTabBySessionId(sessionId, currentWsKey());
      },
      []
    );

    /** 与侧栏「新对话」同一条 shell 路径 */
    const onNewSession = useCallback(() => {
      getCompositionRoot().shell.openNewDraftTab(
        getActiveProjectId() || undefined
      );
      emitUiEvent('open-chat');
    }, []);

    const activeIndex = useMemo(() => {
      if (sessionTabs.length === 0) return -1;
      // 新对话草稿态：无标签高亮（空界面，不是某个 tab）
      if (isPendingDraft(activeSessionId || '')) return -1;
      for (let i = 0; i < sessionTabs.length; i++) {
        if (sessionTabs[i]!.sessionId === activeSessionId) return i;
      }
      // activeTabId 兜底
      if (activeTabId) {
        const byId = sessionTabs.findIndex((t) => t.tabId === activeTabId);
        if (byId >= 0) return byId;
      }
      return -1;
    }, [sessionTabs, activeSessionId, activeTabId]);

    // ── roving tabindex ─────────────────────────────────────────
    const [rovingIndex, setRovingIndex] = useState(0);
    const tabElsRef = useRef<Array<HTMLDivElement | null>>([]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [overflowStart, setOverflowStart] = useState(false);
    const [overflowEnd, setOverflowEnd] = useState(false);

    useEffect(() => {
      if (sessionTabs.length === 0) {
        setRovingIndex(0);
        return;
      }
      const next =
        activeIndex >= 0
          ? Math.min(activeIndex, sessionTabs.length - 1)
          : Math.min(rovingIndex, sessionTabs.length - 1);
      setRovingIndex(next);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      sessionTabs.length,
      activeIndex,
      sessionTabs.map((t) => t.sessionId).join('|'),
    ]);

    const focusTabAt = useCallback(
      (index: number, activate: boolean) => {
        if (sessionTabs.length === 0) return;
        const i = Math.max(0, Math.min(index, sessionTabs.length - 1));
        setRovingIndex(i);
        const el = tabElsRef.current[i];
        if (el) {
          try {
            el.focus({ preventScroll: false });
          } catch {
            /* jsdom */
          }
          if (typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
        if (activate) {
          const tab = sessionTabs[i];
          if (tab) selectSession(tab.sessionId);
        }
      },
      [sessionTabs, selectSession]
    );

    const onTabKeyDown = useCallback(
      (e: React.KeyboardEvent, index: number) => {
        const n = sessionTabs.length;
        if (n === 0) return;
        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowDown':
            e.preventDefault();
            focusTabAt((index + 1) % n, true);
            break;
          case 'ArrowLeft':
          case 'ArrowUp':
            e.preventDefault();
            focusTabAt((index - 1 + n) % n, true);
            break;
          case 'Home':
            e.preventDefault();
            focusTabAt(0, true);
            break;
          case 'End':
            e.preventDefault();
            focusTabAt(n - 1, true);
            break;
          case 'Enter':
          case ' ':
            e.preventDefault();
            {
              const tab = sessionTabs[index];
              if (tab) selectSession(tab.sessionId);
            }
            break;
          case 'Delete':
          case 'Backspace':
            {
              const tab = sessionTabs[index];
              if (tab) {
                e.preventDefault();
                onCloseSession(tab.sessionId, e);
              }
            }
            break;
          default:
            break;
        }
      },
      [sessionTabs, focusTabAt, selectSession, onCloseSession]
    );

    const updateOverflow = useCallback(() => {
      const el = scrollRef.current;
      if (!el) {
        setOverflowStart(false);
        setOverflowEnd(false);
        return;
      }
      const { start, end } = readStripOverflow(el);
      setOverflowStart((prev) => (prev === start ? prev : start));
      setOverflowEnd((prev) => (prev === end ? prev : end));
    }, []);

    useLayoutEffect(() => {
      updateOverflow();
    }, [sessionTabs.length, sessionTabs, updateOverflow]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      updateOverflow();
      el.addEventListener('scroll', updateOverflow, { passive: true });
      const ro =
        typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => updateOverflow())
          : null;
      ro?.observe(el);
      return () => {
        el.removeEventListener('scroll', updateOverflow);
        ro?.disconnect();
      };
    }, [updateOverflow, sessionTabs.length]);

    return (
      <div
        className={`${styles.bar} ${variant === 'caption' ? styles.barCaption : styles.barStandalone}`}
        data-testid="global-session-tab-bar"
        data-global-session-tab-bar="true"
        data-variant={variant}
        data-tab-count={sessionTabs.length}
        data-overflow-start={overflowStart ? 'true' : undefined}
        data-overflow-end={overflowEnd ? 'true' : undefined}
        role="navigation"
        aria-label="会话标签"
      >
        <div
          ref={scrollRef}
          className={styles.scroll}
          role="tablist"
          aria-label="会话"
          aria-orientation="horizontal"
        >
          {sessionTabs.map((tab, index) => {
            const active = tab.sessionId === activeSessionId;
            const isRovingStop = index === rovingIndex;
            return (
              <div
                key={tab.tabId || tab.sessionId}
                ref={(node) => {
                  tabElsRef.current[index] = node;
                }}
                data-testid="global-session-tab"
                data-session-id={tab.sessionId}
                data-tab-id={tab.tabId}
                data-topbar-session-id={tab.sessionId}
                draggable={false}
                className={`${styles.tab} ${active ? styles.isActive : ''}`}
                role="tab"
                aria-selected={active}
                tabIndex={isRovingStop ? 0 : -1}
                onKeyDown={(e) => onTabKeyDown(e, index)}
                onFocus={() => setRovingIndex(index)}
                onPointerDown={
                  startSessionDrag
                    ? (e) => startSessionDrag(tab.sessionId, tab.title, e)
                    : undefined
                }
              >
                <button
                  type="button"
                  className={styles.tabMain}
                  tabIndex={-1}
                  onClick={() => selectSession(tab.sessionId)}
                  title={tab.title}
                >
                  {tab.pinned ? (
                    <Pin
                      size={12}
                      strokeWidth={2}
                      aria-hidden
                      className={styles.pinIcon}
                    />
                  ) : null}
                  <span className={styles.tabLabel}>{tab.title}</span>
                </button>
                <Tooltip content="关闭标签">
                  <button
                    type="button"
                    className={styles.tabClose}
                    tabIndex={-1}
                    aria-label={`关闭会话标签 ${tab.title}`}
                    onClick={(e) => onCloseSession(tab.sessionId, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            );
          })}

          <div className={styles.addWrap}>
            <Tooltip content="新建对话">
              <button
                type="button"
                className={styles.tabAdd}
                data-testid="global-strip-new-session"
                aria-label="新建对话"
                onClick={onNewSession}
              >
                <MessageSquarePlus
                  size={ICON_SIZE}
                  strokeWidth={TAB_ICON_STROKE}
                  aria-hidden
                />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    );
  });

GlobalSessionTabBar.displayName = 'GlobalSessionTabBar';
