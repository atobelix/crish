import { useCallback, useEffect, useMemo } from 'react';
import { useChatEmptyKind } from './useChatEmptyKind';
import {
  useScopedSessionField,
  EMPTY_ARRAY,
  type SessionStoreStateShape,
} from './useScopedSessionField';
import type { SessionMessage, SessionAgent } from '../../store/types';
import { triggerSessionMessageHydrateIfNeeded } from '../../store/sessionCrudActions';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { dedupeStateCarrierMessages } from '../chat-message/contextStateUtils';
import { sortMessagesByOrder } from '../../store/sessionSharedHelpers';

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

  useEffect(() => {
    if (!activeSessionId) return;
    triggerSessionMessageHydrateIfNeeded(activeSessionId);
  }, [activeSessionId]);

  const displayMessages = useMemo(() => {
    const q = localMsgFilter.trim();
    const base = q ? messages.filter((m) => messageMatchesSearch(m, q)) : messages;
    // 显示层唯一防御排序入口：复用写入序比较器（sortMessagesByOrder → compareMessageOrder）
    // 防历史脏数据乱序；processing 流式消息若 timestamp 最新自然在末尾，不 special-case
    return sortMessagesByOrder(dedupeStateCarrierMessages(base));
  }, [messages, localMsgFilter]);

  const {
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  } = useChatEmptyKind({
    activeSessionId,
    messageCount: messages.length,
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
