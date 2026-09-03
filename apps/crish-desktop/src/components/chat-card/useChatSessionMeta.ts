import { useCallback, useRef, useEffect } from 'react';
import { useLayoutStore, useSessionField, selectActiveSessionId } from '../../store/storeAccess';
import { isDemoMode } from '../../api/appMode';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';
import { useScopedSessionField, type SessionStoreStateShape } from './useScopedSessionField';
import type { SessionState } from '../../store/types';

import { useLayoutTreeStore, collectLeaves } from '../../store/layout-tree';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { useDraftFolder } from '../../store/draft-routing';
import { useSessionStore } from '../../store/sessionStore';

export interface UseChatSessionMetaOptions {
  sessionIdProp?: string | null;
}

export interface UseChatSessionMetaResult {
  activeSessionId: string | null;
  resolveSessionId: (s: SessionStoreStateShape) => string;
  activeSessionTitle: string | undefined;
  workspaceKey: string;
  goalMode: SessionState['goalMode'];
  goalModeActive: boolean;
  firstRunOpen: boolean;
}

export function useChatSessionMeta({
  sessionIdProp,
}: UseChatSessionMetaOptions): UseChatSessionMetaResult {
  const activeSessionId = useSessionField(
    useCallback(
      (s) => sessionIdProp ?? selectActiveSessionId(s),
      [sessionIdProp]
    )
  );

  const resolveSessionId = useCallback(
    (s: SessionStoreStateShape) => sessionIdProp ?? s.activeSessionId ?? '',
    [sessionIdProp]
  );

  const activeSessionTitle = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.title, [])
  );

  const sessionFolder = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.folder, [])
  );

  const tabWorkspaceKey = useLayoutTreeStore(
    useCallback((s) => {
      if (!sessionIdProp) return null;
      const leaves = collectLeaves(s.tree.root);
      for (const leaf of leaves) {
        const tab = leaf.tabs.find((t) => t.sessionId === sessionIdProp || t.tabId === sessionIdProp);
        if (tab) return tab.workspaceKey;
      }
      return null;
    }, [sessionIdProp])
  );

  const targetSid = sessionIdProp ?? activeSessionId;
  const draftFolder = useDraftFolder(targetSid);
  const storeDraftFolder = useSessionStore((s) => s.draftFolder);

  const workspaceKey =
    sessionFolder ||
    tabWorkspaceKey ||
    draftFolder ||
    storeDraftFolder ||
    (sessionIdProp ? GENERAL_FOLDER : '');

  const goalMode = useScopedSessionField(
    resolveSessionId,
    useCallback((session) => session?.goalMode, [])
  );

  // 会话切换检测（ref，非渲染态）：切换时回到 chat 主面
  const prevActiveSessionRef = useRef(activeSessionId);
  const setMainSurface = useLayoutStore((s) => s.setChatMainSurface);
  useEffect(() => {
    if (prevActiveSessionRef.current !== activeSessionId) {
      prevActiveSessionRef.current = activeSessionId;
      setMainSurface('chat');
    }
  }, [activeSessionId, setMainSurface]);

  const goalModeActive = Boolean(goalMode?.active);
  const firstRunOpen = !isDemoMode() && isFirstRunOverlayOpen();

  return {
    activeSessionId,
    resolveSessionId,
    activeSessionTitle,
    workspaceKey,
    goalMode,
    goalModeActive,
    firstRunOpen,
  };
}
