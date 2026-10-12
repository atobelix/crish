/**
 * useLeafUiEvent & onScopedUiEvent — 定址化子窗口作用域 UI 事件订阅器。
 *
 * 核心保证（By-Construction Event Routing）：
 * 1. 自动通过 `shouldConsumeScopedEvent` 网关过滤跨子窗口事件：
 *    - 带 `sessionId` / `leafId` 载荷的事件（如 `retract-backfill`, `retry-failed-turn`, `thinking-title-changed`）
 *      仅路由给匹配的子窗口实例；
 *    - 无特定载荷的快捷键/菜单事件（如 `stop-generation`, `toggle-msg-filter`, `open-project-picker`,
 *      `focus-composer`, `export-session-md`, `open-conversation-rewind`）仅路由给当前激活（焦点）子窗口；
 * 2. 业务组件无需手写散装 `if (sessionId !== activeSessionId) return` 补丁。
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../store/sessionStore';
import {
  onUiEvent,
  type UiEventDetail,
  type UiEventHandler,
  type UiEventName,
} from '../api/uiEvents';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
  useScopedSessionId,
  type ScopedEventTargetContext,
} from '../contexts/LeafScopeContext';

/**
 * 命令式作用域 UI 事件订阅（适用于单个 useEffect 内批量注册多个事件的场景）。
 * `getTarget` 在每次事件到达时动态读取最新子窗口上下文，避免闭包陈旧。
 */
export function onScopedUiEvent<K extends UiEventName>(
  name: K,
  handler: UiEventHandler<K>,
  getTarget: () => ScopedEventTargetContext
): () => void {
  return onUiEvent(name, (detail: UiEventDetail<K>) => {
    let target = getTarget();
    // Guard-1: 若未包裹 Provider 且未指定 target.sessionId / leafId，
    // 先尝试回退读取 store 的 activeSessionId；
    // 若 store 中 activeSessionId 也为空（纯脱离 store 的裸单元测试），则默认放行
    if (!target.sessionId && !target.leafId) {
      const globalSid = useSessionStore.getState()?.activeSessionId;
      if (globalSid) {
        target = { ...target, sessionId: globalSid };
      } else {
        // 纯脱离 Provider 和 store 的裸测试环境直接放行
        handler(detail);
        return;
      }
    }
    if (!shouldConsumeScopedEvent(detail, target)) {
      return;
    }
    handler(detail);
  });
}

/**
 * 声明式 Hook：在组件或 Hook 顶层订阅子窗口作用域 UI 事件。
 * 自动从 `LeafScopeContext` 读取当前子窗口的 `sessionId`、`leafId` 与 `isActive`，
 * 并允许通过 `overrides` 传入显式的 `sessionId`（例如未包裹 Provider 时的组件 prop）。
 */
export function useLeafUiEvent<K extends UiEventName>(
  name: K,
  handler: UiEventHandler<K>,
  overrides?: Partial<ScopedEventTargetContext>
): void {
  const scope = useLeafScope();
  const scopedSessionId = useScopedSessionId(overrides?.sessionId);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const targetRef = useRef<ScopedEventTargetContext>({
    sessionId:
      overrides?.sessionId !== undefined
        ? overrides.sessionId
        : scopedSessionId,
    leafId: overrides?.leafId !== undefined ? overrides.leafId : scope.leafId,
    isActive:
      overrides?.isActive !== undefined
        ? overrides.isActive
        : scope.inLeafScope
          ? scope.isActive
          : undefined,
  });

  targetRef.current = {
    sessionId:
      overrides?.sessionId !== undefined
        ? overrides.sessionId
        : scopedSessionId,
    leafId: overrides?.leafId !== undefined ? overrides.leafId : scope.leafId,
    isActive:
      overrides?.isActive !== undefined
        ? overrides.isActive
        : scope.inLeafScope
          ? scope.isActive
          : undefined,
  };

  useEffect(() => {
    return onScopedUiEvent(
      name,
      (detail) => handlerRef.current(detail),
      () => targetRef.current
    );
  }, [name]);
}
