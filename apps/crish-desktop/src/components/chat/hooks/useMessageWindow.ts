import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionMessage } from '../../store/layoutStore';
import {
  DEFAULT_RECENT_MESSAGE_COUNT, collectMustIncludeIndices, expandOlderStepCount,
  expandedOlderToShowAll, messageWindowContainsId, nextExpandedOlder,
  resolveExpandedForKeepAlive, shouldOfferShowAllOlder, windowMessages,
} from '../../api/messageWindow';
import { messageMatchesSearch, subscribeSearchQuery, getSearchQuerySnapshot } from '../../api/sessionSearch';

const EMPTY_MUST_INDICES: number[] = [];

function scrollToMsgEl(id: string) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function useMessageWindow(messages: SessionMessage[], showAllMessages: boolean, activeSessionId: string) {
  const [expandedOlder, setExpandedOlder] = useState(0);
  const searchHighlightQuery = useSyncExternalStore(subscribeSearchQuery, getSearchQuerySnapshot, getSearchQuerySnapshot);

  const searchMatch = useMemo(() => {
    if (!searchHighlightQuery) return undefined;
    const q = searchHighlightQuery;
    return (m: SessionMessage) => messageMatchesSearch(m, q);
  }, [searchHighlightQuery]);

  const mustIncludeIndices = useMemo(() => {
    if (showAllMessages || messages.length === 0) return EMPTY_MUST_INDICES;
    return collectMustIncludeIndices(messages, { includePendingApprovals: true, match: searchMatch, matchOnlyFirst: true });
  }, [messages, showAllMessages, searchMatch]);

  useEffect(() => {
    if (showAllMessages) return;
    setExpandedOlder((prev) => {
      const { expandedOlder: next } = resolveExpandedForKeepAlive(messages, {
        includePendingApprovals: true, match: searchMatch, matchOnlyFirst: true,
        currentExpanded: prev, recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
      });
      return next === prev ? prev : next;
    });
  }, [messages, mustIncludeIndices, showAllMessages, searchMatch]);

  const messageWindow = useMemo(
    () => windowMessages(messages, {
      recentCount: DEFAULT_RECENT_MESSAGE_COUNT, expandedOlder, showAll: showAllMessages,
      mustIncludeIndices: showAllMessages ? undefined : mustIncludeIndices,
    }),
    [messages, expandedOlder, showAllMessages, mustIncludeIndices]
  );

  const olderStep = expandOlderStepCount(messageWindow.hiddenCount);
  const offerShowAllOlder = shouldOfferShowAllOlder(messageWindow.hiddenCount);

  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) => messageMatchesSearch(m, searchHighlightQuery));
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    const t = window.setTimeout(() => {
      if (showAllMessages || messageWindowContainsId(messages, messageWindow, id)) { scrollToMsgEl(id); return; }
      window.requestAnimationFrame(() => scrollToMsgEl(id));
    }, 40);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchHighlightQuery, activeSessionId, showAllMessages, messageWindow.startIndex]);

  const expandOlderStep = useCallback(() => {
    setExpandedOlder((n) => nextExpandedOlder(Math.max(n, messageWindow.effectiveExpanded), messageWindow.hiddenCount));
  }, [messageWindow.hiddenCount, messageWindow.effectiveExpanded]);

  const expandOlderAll = useCallback(() => {
    setExpandedOlder(expandedOlderToShowAll(messages.length, DEFAULT_RECENT_MESSAGE_COUNT));
  }, [messages.length]);

  const resetExpanded = useCallback(() => setExpandedOlder(0), []);

  return {
    expandedOlder, messageWindow, olderStep, offerShowAllOlder, searchHighlightQuery,
    mustIncludeIndices, expandOlderStep, expandOlderAll, resetExpanded,
  };
}
