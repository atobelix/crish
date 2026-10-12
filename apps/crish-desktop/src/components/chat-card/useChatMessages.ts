import { useCallback, useEffect, useMemo } from 'react';
import { useChatEmptyKind } from './useChatEmptyKind';
import {
  useScopedSessionField,
  EMPTY_ARRAY,
  type SessionStoreStateShape,
} from './useScopedSessionField';
import type { SessionMessage, SessionAgent } from '../../store/types';
import { triggerSessionMessageHydrateIfNeeded } from '../../store/storeAccess';
import { projectDisplayMessages } from './projectDisplayMessages';

export interface UseChatMessagesOptions {
  resolveSessionId: (s: SessionStoreStateShape) => string;
  activeSessionId: string | null;
  localMsgFilter: string;
  mainSurface: string;
}

export interface UseChatMessagesResult {
  messages: SessionMessage[];
  agents: SessionAgent[];
  displayMessages: SessionMessage[];
  messagesLoading: boolean;
  emptyKind: ReturnType<typeof useChatEmptyKind>['emptyKind'];
  onEmptySurface: boolean;
  chatRegionAria: string;
  isProcessing: boolean;
}

export function useChatMessages({
  resolveSessionId,
  activeSessionId,
  localMsgFilter,
  mainSurface,
}: UseChatMessagesOptions): UseChatMessagesResult {
  const messages = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.messages || EMPTY_ARRAY, [])
  );
  const agents = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.agents || EMPTY_ARRAY, [])
  );
  const hydratedFromEngine = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.hydratedFromEngine, [])
  );
  const engineCursor = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.engineCursor, [])
  );
  const engineLastRunId = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.engineLastRunId, [])
  );

  const hasSessionShell = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => Boolean(session), [])
  );
  const messagesHydrated = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.messagesHydrated === true, [])
  );

  useEffect(() => {
    if (!activeSessionId) return;
    if (hasSessionShell && !messagesHydrated) {
      triggerSessionMessageHydrateIfNeeded(activeSessionId);
    }
  }, [activeSessionId, hasSessionShell, messagesHydrated]);

  // S-6 展示投影唯一入口（排序 → 搜索 → 可渲染过滤 → 载体折叠）
  const projection = useMemo(
    () => projectDisplayMessages(messages, localMsgFilter),
    [messages, localMsgFilter]
  );
  const displayMessages = projection.display;

  const { messagesLoading, emptyKind, onEmptySurface, chatRegionAria } =
    useChatEmptyKind({
      activeSessionId,
      // G5：投影后、搜索前的条数——全部不可渲染时落到 session-empty（欢迎面），不白屏
      messageCount: projection.visibleCount,
      displayCount: displayMessages.length,
      localMsgFilter,
      mainSurface,
      hydratedFromEngine,
      engineCursor,
      engineLastRunId,
    });

  const isProcessing = useMemo(
    () => messages.some((m) => m.status === 'processing'),
    [messages]
  );

  return {
    messages,
    agents,
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
    isProcessing,
  };
}
