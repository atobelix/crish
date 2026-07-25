import { useEffect, useMemo, useState } from 'react';
import type { SessionMessage } from '../../store/layoutStore';
import { isDemoMode } from '../../api/appMode';
import { messageMatchesSearch } from '../../api/sessionSearch';
import {
  chatEmptyKindAriaLabel,
  resolveChatEmptyKind,
} from '../../api/chatEmptyState';
import { isPendingDraft } from '../../store/draftSession';

export interface UseChatEmptyKindOptions {
  activeSessionId: string | null;
  messages: SessionMessage[];
  localMsgFilter: string;
  mainSurface: string;
  hydratedFromEngine: boolean | undefined;
  engineCursor: number | undefined;
  engineLastRunId: string | undefined;
}

export function useChatEmptyKind({
  activeSessionId,
  messages,
  localMsgFilter,
  mainSurface,
  hydratedFromEngine,
  engineCursor,
  engineLastRunId,
}: UseChatEmptyKindOptions) {
  const [hydrateTimedOut, setHydrateTimedOut] = useState(false);

  useEffect(() => {
    setHydrateTimedOut(false);
  }, [activeSessionId]);

  const displayMessages = useMemo(() => {
    const q = localMsgFilter.trim();
    if (!q) return messages;
    return messages.filter((m) => messageMatchesSearch(m, q));
  }, [messages, localMsgFilter]);

  const messagesLoadingCandidate = useMemo(() => {
    if (isDemoMode()) return false;
    if (!activeSessionId) return false;
    if (messages.length > 0) return false;
    if (hydratedFromEngine === true) return false;
    const isLocalMintId = /^sess-(branch-)?\d+$/i.test(activeSessionId);
    if (
      isLocalMintId &&
      typeof engineCursor !== 'number' &&
      !engineLastRunId
    ) {
      return false;
    }
    return true;
  }, [
    activeSessionId,
    messages.length,
    hydratedFromEngine,
    engineCursor,
    engineLastRunId,
  ]);

  useEffect(() => {
    if (!messagesLoadingCandidate) {
      setHydrateTimedOut(false);
      return;
    }
    setHydrateTimedOut(false);
    const t = window.setTimeout(() => setHydrateTimedOut(true), 3000);
    return () => window.clearTimeout(t);
  }, [activeSessionId, messagesLoadingCandidate]);

  const messagesLoading = messagesLoadingCandidate && !hydrateTimedOut;

  const emptyKind = resolveChatEmptyKind({
    hasActiveSession:
      Boolean(activeSessionId) && !isPendingDraft(activeSessionId),
    messageCount: messages.length,
    displayCount: displayMessages.length,
    filterQuery: localMsgFilter,
    mainSurface,
    messagesLoading,
  });
  const onEmptySurface = emptyKind != null;

  const chatRegionAria =
    mainSurface === 'scheduled'
      ? '定时任务'
      : emptyKind
        ? chatEmptyKindAriaLabel(emptyKind)
        : messagesLoading
          ? '正在加载会话消息'
          : '对话主区';

  return {
    displayMessages,
    messagesLoading,
    emptyKind,
    onEmptySurface,
    chatRegionAria,
  };
}
