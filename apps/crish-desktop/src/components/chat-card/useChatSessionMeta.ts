import { useCallback, useRef, useEffect } from 'react';
import {
  useLayoutStore,
  useLayoutTreeStore,
  collectLeaves,
  useDraftFolder,
  useSessionStore,
} from '../../store/storeAccess';
import { isDemoMode } from '../../api/appMode';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';
import {
  useScopedSessionField,
  type SessionStoreStateShape,
} from './useScopedSessionField';
import type { SessionState } from '../../store/types';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { isPendingDraft } from '../../store/draftSession';

import { GENERAL_FOLDER } from '../../api/projectStore';

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
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const activeSessionId = scopedSessionId;

  const resolveSessionId = useCallback(
    (s: SessionStoreStateShape) => scopedSessionId || s.activeSessionId || '',
    [scopedSessionId]
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
    useCallback(
      (s) => {
        const sid = scopedSessionId;
        if (!sid) return null;
        const leaves = collectLeaves(s.tree.root);
        for (const leaf of leaves) {
          const tab = leaf.tabs.find(
            (t) => t.sessionId === sid || t.tabId === sid
          );
          if (tab) return tab.workspaceKey;
        }
        return null;
      },
      [scopedSessionId]
    )
  );

  const draftFolder = useDraftFolder(scopedSessionId);
  const storeDraftFolder = useSessionStore((s) => s.draftFolder);

  const workspaceKey =
    sessionFolder ||
    tabWorkspaceKey ||
    draftFolder ||
    (isPendingDraft(scopedSessionId) ? GENERAL_FOLDER : storeDraftFolder) ||
    (scopedSessionId ? GENERAL_FOLDER : '');

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
