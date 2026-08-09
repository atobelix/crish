/**
 * UnitSessionTabStrip — 每个 chat 域 Conversation Unit 顶部的会话标签行。
 *
 * T-C 批次 5.2 · T12 后为「TabStrip 基座 + 业务封装层」：
 * - 呈现（role=tablist/tab、roving tabindex、键盘漫游、溢出 fade、关闭钮）由
 *   ui/TabStrip 基座承担（对齐 S4.5 a11y 契约）；
 * - 本层保留业务：窄订阅（openTabs/tree 投影）、标签解析（标题/置顶）、
 *   选择/关闭/新建会话路径、拖拽入口、多 unit 内联工具；
 * - readStripOverflow 由基座导出，此处 re-export 保持 GlobalSessionTabBar
 *   既有 import 路径稳定。
 *
 * 仅多 chat 分屏时挂载（单 unit 用 AppTopBar GlobalSessionTabBar）。
 * 行为：点击 → activateTab / openOrFocusSession；关闭 → closeTabBySessionId；
 * + → openNewDraftTab；拖拽（D5 / useTopBarDrag）经 onTabPointerDown 插槽。
 */

import React, { useCallback, useMemo } from 'react';
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
import { TabStrip, Tooltip } from '../ui';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import styles from './UnitSessionTabStrip.module.css';

/** 基座溢出 helper 别名导出：GlobalSessionTabBar 沿用既有 import 路径 */
export { readStripOverflow } from '../ui/TabStrip/TabStrip';

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

    // 多 unit：标签 + 工具同一行（与右坞 header 同高），消灭第三行 chrome
    const showInlineTools = chatLeafCount > 1;

    // 多 unit 时本 strip 以 leaf 绑定 session 为「当前」；单 unit 跟 shell 活动 tab；
    // 草稿空界面不高亮任何真实 tab
    const activeId =
      chatLeafCount > 1 && leafSessionId
        ? leafSessionId
        : isPendingDraft(activeSessionId || '')
          ? null
          : activeSessionId || null;

    const titleOf = (sessionId: string) =>
      sessionTabs.find((t) => t.sessionId === sessionId)?.title || '';

    return (
      <TabStrip
        className={styles.strip}
        scrollClassName={styles.scroll}
        tabClassName={styles.tab}
        tabActiveClassName={styles.isActive}
        ariaLabel="会话"
        activeId={activeId}
        tabs={sessionTabs.map((t) => ({
          id: t.sessionId,
          label: t.title,
          data: {
            'data-testid': 'unit-session-tab',
            'data-session-id': t.sessionId,
            'data-tab-id': t.tabId,
            'data-topbar-session-id': t.sessionId,
          },
        }))}
        onActiveChange={selectSession}
        onClose={(sessionId, e) => onCloseSession(sessionId, e)}
        onTabPointerDown={
          startSessionDrag
            ? (sessionId, e) =>
                startSessionDrag(sessionId, titleOf(sessionId), e)
            : undefined
        }
        renderTab={(tab) => {
          const meta = sessionTabs.find((t) => t.sessionId === tab.id);
          return (
            <>
              <button
                type="button"
                className={styles.tabMain}
                tabIndex={-1}
                onClick={() => selectSession(tab.id)}
                title={tab.label}
              >
                {meta?.pinned ? (
                  <Pin
                    size={12}
                    strokeWidth={2}
                    aria-hidden
                    className={styles.pinIcon}
                  />
                ) : null}
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
        }}
        trailing={
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
        }
        data={{
          'data-unit-session-tab-strip': 'true',
          'data-tab-strip-leaf-id': leafId,
          'data-session-id': leafSessionId || undefined,
          'data-chat-leaf-count': chatLeafCount,
          'data-tab-count': sessionTabs.length,
          'data-inline-tools': showInlineTools ? 'true' : undefined,
        }}
        wrapTrailing={
          showInlineTools ? (
            <div className={styles.stripActions} data-unit-strip-actions="true">
              <UnitChromeActions activeSessionId={leafSessionId} />
            </div>
          ) : null
        }
      />
    );
  }
);

UnitSessionTabStrip.displayName = 'UnitSessionTabStrip';
