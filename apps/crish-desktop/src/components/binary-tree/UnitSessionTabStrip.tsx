/**
 * UnitSessionTabStrip — 每个 chat 域 Conversation Unit 顶部的会话标签行。
 *
 * 仅多 chat 分屏时挂载（单 unit 用 AppTopBar GlobalSessionTabBar）。
 * 多 unit：标签 + UnitChromeActions 同一行（30px），与右坞 header 齐平，
 * 避免 AppTopBar + 标签 + ChatHeader 叠成三行。
 *
 * 行为：
 * - 点击 → activateTab / openOrFocusSession
 * - 关闭 → closeTabBySessionId
 * - + → openNewDraftTab（当前工作区草稿）
 * - 拖拽（D5 / useTopBarDrag）：
 *   - 同条 / 跨条悬停另一 tab → reorderSessionTab
 *   - 拖到画布 split 区 → planSessionCanvasDrop（move 不 clone）
 * - 键盘 a11y（S4.5）：roving tabindex + Arrow/Home/End；Delete 关标签
 * - 溢出 fade：scroll 时写 data-overflow-start/end（CSS 已接线）
 *
 * 订阅（D0-5 / strip-subscribe-narrow）：
 * - openTabs 仅在条带相关字段变化时通知（忽略 rightDock 等）
 * - layout 只投影 chat unit 列表，不订整棵 tree.root
 * - 注意：勿在 selector 中引用未导入符号（曾因 listChatLeaves 未导入导致运行时崩溃）。
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
import { getSessionById } from '../../api/store-access/componentAccess';
import { useLayoutTreeStore } from '../../api/store-access/componentAccess';
import {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  listChatUnits,
  tabsForUnit,
  type ChatUnitRef,
  type TabSurface,
} from '../../api/store-access/componentAccess';
import { isPendingDraft } from '../../api/store-access/componentAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { emitUiEvent } from '../../api/uiEvents';
import { Tooltip } from '../ui';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import styles from './UnitSessionTabStrip.module.css';

const ICON_SIZE = 16;
const TAB_ICON_STROKE = 1.75;

export interface UnitSessionTabStripProps {
  /** 本 chat leaf id（data 属性 / a11y） */
  leafId: string;
  /** leaf 绑定的 sessionId；多 unit 归属依据 */
  leafSessionId?: string;
  /**
   * 会话标签拖拽入口（BinaryTreeWorkspace 单例 useTopBarDrag）。
   * 未传入时退化为纯点击（测试 / 故事书兜底）。
   */
  startSessionDrag?: (
    sessionId: string,
    title: string,
    e: React.PointerEvent
  ) => void;
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

/**
 * openTabs 条带相关字段相等：rightDock / 其它壳层字段变化不触发 strip re-render。
 * 导出供测试锁定 D0-5 契约。
 */
export function openTabsStripRelevantEqual(
  a: readonly TabSurface[],
  b: readonly TabSurface[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.tabId !== y.tabId ||
      x.sessionId !== y.sessionId ||
      x.title !== y.title ||
      x.workspaceKey !== y.workspaceKey ||
      x.kind !== y.kind
    ) {
      return false;
    }
  }
  return true;
}

/**
 * chat unit 列表相等（leafId + sessionId）；非 chat 布局扰动不触发 strip。
 * 导出供测试锁定 D0-5 契约。
 */
export function chatUnitsEqual(
  a: readonly ChatUnitRef[],
  b: readonly ChatUnitRef[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]!.leafId !== b[i]!.leafId ||
      (a[i]!.sessionId ?? '') !== (b[i]!.sessionId ?? '')
    ) {
      return false;
    }
  }
  return true;
}

/** 读 scroll 容器溢出边，供 data-overflow-* / 测 */
export function readStripOverflow(el: HTMLElement): {
  start: boolean;
  end: boolean;
} {
  const maxScroll = el.scrollWidth - el.clientWidth;
  if (maxScroll <= 1) {
    return { start: false, end: false };
  }
  const left = el.scrollLeft;
  return {
    start: left > 1,
    end: left < maxScroll - 1,
  };
}

export const UnitSessionTabStrip: React.FC<UnitSessionTabStripProps> = React.memo(
  ({ leafId, leafSessionId, startSessionDrag }) => {
    // 窄订阅：仅 tabId/sessionId/title/workspaceKey/kind；rightDock 变化被 equality 吞掉
    const openTabs = useStoreWithEqualityFn(
      useWorkspaceShellStore,
      (s) => s.openTabs,
      openTabsStripRelevantEqual
    );
    const activeTabId = useWorkspaceShellStore((s) => s.activeTabId);
    const activeSessionId = useWorkspaceShellStore(selectActiveTabSessionId);
    // 窄订阅：只投影 chat unit 列表，不订 tree.root 整树
    const units = useStoreWithEqualityFn(
      useLayoutTreeStore,
      (s) => listChatUnits(s.tree.root),
      chatUnitsEqual
    );

    const chatLeafCount = units.length;
    const unitRef = useMemo(() => {
      const hit = units.find((u) => u.leafId === leafId);
      if (hit) return hit;
      return leafSessionId
        ? { leafId, sessionId: leafSessionId }
        : { leafId };
    }, [units, leafId, leafSessionId]);

    const sessionTabs = useMemo(() => {
      // 以 active / leaf 绑定 tab 的 workspace 为准，避免项目会话被 GENERAL「对话」滤掉
      const workspaceKey = currentWsKey();
      // draft 不是标签行条目
      const realOpen = openTabs.filter((t) => !isPendingDraft(t.sessionId));
      const placed = tabsForUnit(
        realOpen,
        unitRef,
        units,
        activeTabId,
        workspaceKey
      );
      return placed.map((t) => {
        const sess = getSessionById(t.sessionId);
        return {
          tabId: t.tabId,
          sessionId: t.sessionId,
          title: resolveTabTitle(t.sessionId, t.title),
          pinned: Boolean(sess?.isPinned),
        };
      });
    }, [openTabs, unitRef, units, activeTabId]);

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

    // ── active index（单 unit 跟 shell；多 unit 跟 leaf 绑定） ──
    const activeIndex = useMemo(() => {
      if (sessionTabs.length === 0) return -1;
      // 草稿空界面：不高亮任何真实 tab
      if (isPendingDraft(activeSessionId || '')) return -1;
      for (let i = 0; i < sessionTabs.length; i++) {
        const tab = sessionTabs[i]!;
        if (tab.sessionId === activeSessionId) return i;
        if (
          chatLeafCount > 1 &&
          leafSessionId &&
          tab.sessionId === leafSessionId
        ) {
          return i;
        }
      }
      return -1;
    }, [sessionTabs, activeSessionId, chatLeafCount, leafSessionId]);

    // ── roving tabindex（S4.5） ────────────────────────────────
    const [rovingIndex, setRovingIndex] = useState(0);
    const tabElsRef = useRef<Array<HTMLDivElement | null>>([]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [overflowStart, setOverflowStart] = useState(false);
    const [overflowEnd, setOverflowEnd] = useState(false);

    // 活动 tab 变化时把 roving 锚到活动项（列表变短时钳制）
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
      // 仅随 tabs / active 同步；勿跟 rovingIndex 形成环
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionTabs.length, activeIndex, sessionTabs.map((t) => t.sessionId).join('|')]);

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
            /* jsdom / 不可聚焦节点 */
          }
          // 溢出时滚入视野（jsdom 无 scrollIntoView）
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

    // ── overflow fade（S4.5 data-overflow-*） ──────────────────
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

    // 多 unit：标签 + 工具同一行（与右坞 header 同高），消灭第三行 chrome
    const showInlineTools = chatLeafCount > 1;

    return (
      <div
        className={styles.strip}
        data-unit-session-tab-strip="true"
        data-tab-strip-leaf-id={leafId}
        data-session-id={leafSessionId || undefined}
        data-chat-leaf-count={chatLeafCount}
        data-tab-count={sessionTabs.length}
        data-inline-tools={showInlineTools ? 'true' : undefined}
        data-overflow-start={overflowStart ? 'true' : undefined}
        data-overflow-end={overflowEnd ? 'true' : undefined}
      >
        <div
          ref={scrollRef}
          className={styles.scroll}
          role="tablist"
          aria-label="会话"
          aria-orientation="horizontal"
        >
          {sessionTabs.map((tab, index) => {
            // 单 unit：跟 shell 活动 tab；多 unit：本 leaf 绑定 session 即本条“当前”
            const active =
              tab.sessionId === activeSessionId ||
              (chatLeafCount > 1 &&
                Boolean(leafSessionId) &&
                tab.sessionId === leafSessionId);
            const isRovingStop = index === rovingIndex;
            return (
              <div
                key={tab.tabId || tab.sessionId}
                ref={(node) => {
                  tabElsRef.current[index] = node;
                }}
                data-testid="unit-session-tab"
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
                data-testid="unit-strip-new-session"
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

        {showInlineTools ? (
          <div className={styles.stripActions} data-unit-strip-actions="true">
            <UnitChromeActions activeSessionId={leafSessionId} />
          </div>
        ) : null}
      </div>
    );
  }
);

UnitSessionTabStrip.displayName = 'UnitSessionTabStrip';
