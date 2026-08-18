/**
 * GlobalSessionTabBar — 全局会话标签行（最顶 AppTopBar 中间）。
 *
 * T-C 批次 5.2 · T12 后为「TabStrip 基座 + 业务封装层」：
 * - 呈现（tablist/tab/roving/键盘/溢出 fade/关闭钮）由 ui/TabStrip 承担；
 * - 本层保留业务：窄订阅、工作区标签解析、丢 tab 恢复、选择/关闭/新建路径、
 *   variant（caption 嵌 AppTopBar / standalone 独立条）；
 * - 全局上下文（右键菜单等）为业务封装层组合能力，不扩基座 props。
 *
 * 决策：docs/plans/progress/shell-global-tab-bar.md
 * 数据属性：data-global-session-tab-bar / data-topbar-session-id
 */

import React, { useCallback, useEffect, useMemo } from 'react';
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
import { getSessionById } from '../../store/storeAccess';
import {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  resolveStripWorkspaceKey,
  createDefaultDock,
  type TabSurface,
} from '../../store/storeAccess';
import { isPendingDraft } from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { emitUiEvent } from '../../api/uiEvents';
import { Button, TabStrip, Tooltip } from '../ui';
import styles from './GlobalSessionTabBar.module.css';

/**
 * openTabs 条带相关字段相等：rightDock / 其它壳层字段变化不触发 strip re-render。
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
      const mapped = list.map((t) => {
        const sess = getSessionById(t.sessionId);
        return {
          tabId: t.tabId,
          sessionId: t.sessionId,
          title: resolveTabTitle(t.sessionId, t.title),
          pinned: Boolean(sess?.isPinned || ('pinned' in t && Boolean(t.pinned))),
        };
      });
      const pinnedTabs = mapped.filter((t) => t.pinned);
      const normalTabs = mapped.filter((t) => !t.pinned);
      return [...pinnedTabs, ...normalTabs];
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
      window.dispatchEvent(new CustomEvent('app:new-session'));
    }, []);

    const titleOf = (sessionId: string) =>
      sessionTabs.find((t) => t.sessionId === sessionId)?.title || '';

    return (
      <TabStrip
        appearance={{
          className: `${styles.bar} ${variant === 'caption' ? styles.barCaption : styles.barStandalone}`,
          wrapRole: 'navigation',
          wrapAriaLabel: '会话标签',
          scrollClassName: styles.scroll,
          tabClassName: styles.tab,
          tabActiveClassName: styles.isActive,
          ariaLabel: '会话',
          data: {
            'data-testid': 'global-session-tab-bar',
            'data-global-session-tab-bar': 'true',
            'data-variant': variant,
            'data-tab-count': sessionTabs.length,
          },
        }}
        activeId={
          isPendingDraft(activeSessionId || '') ? null : activeSessionId || null
        }
        tabs={sessionTabs.map((t) => ({
          id: t.sessionId,
          label: t.title,
          closable: !t.pinned,
          className: t.pinned ? styles.isPinned : undefined,
          data: {
            'data-testid': 'global-session-tab',
            'data-session-id': t.sessionId,
            'data-tab-id': t.tabId,
            'data-topbar-session-id': t.sessionId,
            'data-pinned': t.pinned ? 'true' : 'false',
          },
        }))}
        onActiveChange={selectSession}
        onClose={(sessionId, e) => onCloseSession(sessionId, e)}
        slots={{
          onTabPointerDown: startSessionDrag
            ? (sessionId, e) =>
                startSessionDrag(sessionId, titleOf(sessionId), e)
            : undefined,
          renderTab: (tab) => {
            const meta = sessionTabs.find((t) => t.sessionId === tab.id);
            const isPinned = !!meta?.pinned;
            if (isPinned) {
              return (
                <button
                  type="button"
                  className={`${styles.tabMain} ${styles.tabMainPinned}`}
                  tabIndex={-1}
                  onClick={() => selectSession(tab.id)}
                  aria-label={`固定会话 ${tab.label}`}
                >
                  <Pin
                    size={12}
                    strokeWidth={2}
                    aria-hidden
                    className={styles.pinIcon}
                  />
                </button>
              );
            }
            return (
              <>
                <button
                  type="button"
                  className={styles.tabMain}
                  tabIndex={-1}
                  onClick={() => selectSession(tab.id)}
                >
                  <span className={styles.tabLabel}>{tab.label}</span>
                </button>
                <Tooltip content="关闭标签">
                  <button
                    type="button"
                    className={styles.tabClose}
                    tabIndex={-1}
                    aria-label={`关闭会话标签 ${tab.label}`}
                    onClick={(e) => onCloseSession(tab.id, e)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
                </Tooltip>
              </>
            );
          },
          trailing: (
            <div className={styles.addWrap}>
              <Tooltip content="新建对话">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.tabAdd}
                  data-testid="global-strip-new-session"
                  aria-label="新建对话"
                  onClick={onNewSession}
                  icon={
                    <MessageSquarePlus
                      size={ICON_SIZE}
                      strokeWidth={TAB_ICON_STROKE}
                      aria-hidden
                    />
                  }
                />
              </Tooltip>
            </div>
          ),
        }}
      />
    );
  });

GlobalSessionTabBar.displayName = 'GlobalSessionTabBar';
