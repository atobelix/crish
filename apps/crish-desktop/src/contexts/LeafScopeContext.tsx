/**
 * LeafScopeContext — 二叉树分屏子窗口（Leaf）强制作用域上下文。
 *
 * 架构职责（By-Construction Isolation）：
 * 1. 为子窗口内部的所有卡片（ChatCard / PreviewCard / FilesCard / OverviewCard / DiffCard /
 *    TerminalCard / AgentCard / FileViewerCard）及深层子组件（ChatComposer / ComposerFusedTrigger /
 *    ModelBadgePickerMenu / FileAnnotationPopover 等）提供唯一真实的本窗口上下文（SSOT）；
 * 2. 彻底取代单窗口时代散落各处的 `useSessionStore(s => s.activeSessionId)` 隐式全局读取；
 * 3. 提供限定在本子窗口 DOM 子树内的 `queryWithinLeaf`，根除全局 `document.querySelector` 命中首窗格的问题。
 */

import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useSessionStore } from '../store/sessionStore';

export interface LeafScopeValue {
  /** 是否处于 TreeLeafPanel 提供的作用域内 */
  readonly inLeafScope: boolean;
  /** 当前分屏叶子唯一 ID */
  readonly leafId: string | null;
  /** 当前分屏绑定的会话 ID（含草稿 ID `__pending_draft__:${leafId}`） */
  readonly sessionId: string | null;
  /** 当前分屏是否为激活（焦点）分屏；单窗或测试未包裹 Provider 时恒为 true */
  readonly isActive: boolean;
  /** 当前分屏根 DOM 容器引用 */
  readonly leafRootRef: React.RefObject<HTMLElement | null>;
  /** 在当前分屏的右侧工具抽屉中打开指定面板 */
  readonly openTool: ((panelId: string) => void) | null;
  /** 严格在当前分屏 DOM 子树内查询元素；若无根容器则回退 document.querySelector */
  readonly queryWithinLeaf: <T extends Element = HTMLElement>(
    selector: string
  ) => T | null;
}

const DEFAULT_ROOT_REF: React.RefObject<HTMLElement | null> = { current: null };

const DEFAULT_LEAF_SCOPE: LeafScopeValue = {
  inLeafScope: false,
  leafId: null,
  sessionId: null,
  isActive: true,
  leafRootRef: DEFAULT_ROOT_REF,
  openTool: null,
  queryWithinLeaf: <T extends Element = HTMLElement>(
    selector: string
  ): T | null => {
    if (typeof document === 'undefined') return null;
    return document.querySelector<T>(selector);
  },
};

const LeafScopeContext = createContext<LeafScopeValue>(DEFAULT_LEAF_SCOPE);

export interface LeafScopeProviderProps {
  leafId: string;
  sessionId: string | null | undefined;
  isActive: boolean;
  leafRootRef: React.RefObject<HTMLElement | null>;
  openTool?: ((panelId: string) => void) | null;
  children: React.ReactNode;
}

export const LeafScopeProvider: React.FC<LeafScopeProviderProps> = ({
  leafId,
  sessionId,
  isActive,
  leafRootRef,
  openTool = null,
  children,
}) => {
  const queryWithinLeaf = useCallback(
    <T extends Element = HTMLElement>(selector: string): T | null => {
      const root = leafRootRef.current;
      if (root) {
        return root.querySelector<T>(selector);
      }
      if (typeof document !== 'undefined' && leafId) {
        const byLeafAttr = document.querySelector<HTMLElement>(
          `[data-leaf-id="${CSS.escape(leafId)}"]`
        );
        if (byLeafAttr) {
          return byLeafAttr.querySelector<T>(selector);
        }
      }
      return null;
    },
    [leafId, leafRootRef]
  );

  const value = useMemo<LeafScopeValue>(
    () => ({
      inLeafScope: true,
      leafId,
      sessionId: sessionId ?? null,
      isActive,
      leafRootRef,
      openTool,
      queryWithinLeaf,
    }),
    [leafId, sessionId, isActive, leafRootRef, openTool, queryWithinLeaf]
  );

  return (
    <LeafScopeContext.Provider value={value}>
      {children}
    </LeafScopeContext.Provider>
  );
};

/**
 * 读取当前子窗口的完整作用域上下文。
 */
export function useLeafScope(): LeafScopeValue {
  return useContext(LeafScopeContext);
}

/**
 * 获取当前组件所属子窗口的真实 sessionId（SSOT）：
 * 优先级：显式传入的 explicitSessionId > LeafScopeContext.sessionId > 全局 store.activeSessionId
 */
export function useScopedSessionId(explicitSessionId?: string | null): string {
  const scope = useContext(LeafScopeContext);
  const globalActiveSessionId = useSessionStore((s) => s.activeSessionId);

  if (
    explicitSessionId !== undefined &&
    explicitSessionId !== null &&
    explicitSessionId !== ''
  ) {
    return explicitSessionId;
  }
  if (scope.inLeafScope && scope.sessionId) {
    return scope.sessionId;
  }
  return globalActiveSessionId;
}

export interface ScopedEventTargetContext {
  /** 当前子窗口绑定的会话 ID */
  sessionId?: string | null;
  /** 当前子窗口的叶子 ID */
  leafId?: string | null;
  /** 当前子窗口是否为焦点叶子（可选；未传时通过全局 activeSessionId 比对推导） */
  isActive?: boolean;
}

/**
 * 纯函数网关：判定一个 UI 事件（或 CustomEvent detail）是否应当由当前子窗口消费。
 *
 * 规则：
 * 1. 若事件载荷显式携带了非空 `sessionId`，则必须严格匹配 `target.sessionId === detail.sessionId`；
 * 2. 若事件载荷显式携带了非空 `leafId`，则必须严格匹配 `target.leafId === detail.leafId`；
 * 3. 若事件未携带目标标识（如全局快捷键广播），则仅允许当前激活的子窗口（`isActive === true`）消费；
 *    若未提供 `isActive`，则比对 `target.sessionId === globalActiveSessionId`（单窗或空状态测试下默认放行）。
 */
export function shouldConsumeScopedEvent(
  detail: unknown,
  target: ScopedEventTargetContext
): boolean {
  const payload =
    detail && typeof detail === 'object'
      ? (detail as { sessionId?: unknown; leafId?: unknown })
      : null;

  const eventLeafId =
    payload &&
    typeof payload.leafId === 'string' &&
    payload.leafId.trim() !== ''
      ? payload.leafId.trim()
      : null;
  if (eventLeafId) {
    if (target.leafId) {
      return eventLeafId === target.leafId;
    }
  }

  const eventSessionId =
    payload &&
    typeof payload.sessionId === 'string' &&
    payload.sessionId.trim() !== ''
      ? payload.sessionId.trim()
      : null;
  if (eventSessionId) {
    if (!target.sessionId) {
      // Reviewer Guard-1: 当未指定 target.sessionId 时（如存量无 Provider 单测），
      // 回退比对 useSessionStore.getState()?.activeSessionId；若 store 也为空则放行 true
      const globalActiveSid = useSessionStore.getState()?.activeSessionId;
      if (globalActiveSid) {
        return eventSessionId === globalActiveSid;
      }
      return true;
    }
    return eventSessionId === target.sessionId;
  }

  // 无显式目标 ID 的广播事件：仅当前激活的子窗口消费
  if (typeof target.isActive === 'boolean') {
    return target.isActive;
  }

  const globalActiveSid = useSessionStore.getState()?.activeSessionId;
  if (target.sessionId && globalActiveSid) {
    return target.sessionId === globalActiveSid;
  }

  return true;
}
