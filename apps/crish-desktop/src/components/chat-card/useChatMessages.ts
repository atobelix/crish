import { useCallback, useMemo } from 'react';
import { useChatEmptyKind } from './useChatEmptyKind';
import {
  useScopedSessionField,
  EMPTY_ARRAY,
  type SessionStoreStateShape,
} from './useScopedSessionField';
import type { SessionMessage, SessionAgent } from '../../store/types';

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

  const {
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  } = useChatEmptyKind({
    activeSessionId,
    messages,
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
