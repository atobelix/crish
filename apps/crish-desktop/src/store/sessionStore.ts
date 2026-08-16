/**
 * 会话域 facade — 与 useLayoutStore **同一 zustand 实例**（非独立 create）。
 * 权威状态与 actions 在 layoutStore + sessionActions；本文件只导出域 API。
 *
 * ## 消息持久投影定位（T4 A2 固化 · analysis/16 §①）
 *
 * `sessions[].messages` 是「事件流的持久投影缓存（终态落点）」：
 * 流式期间正文/工具中间态在 streamingStore 热缓冲（byKey），run 收口后
 * 由 commitStreamToSession 一次性落账本投影；本域不存流式中边帧。
 * 不新增第三个 store——热缓冲（streamingStore）与持久投影（本 facade）
 * 是设计内必需桥的两端，桥语义（queueMicrotask clearStream 时序闭环）保留。
 *
 * ## Ownership note (OPT-C1)
 *
 * Sessions **still live on layoutStore** (god-object). This is intentional residual —
 * do not dual-write a second sessions map. New code:
 * - Read/subscribe: `useSessionStore` / `useSessionField` / storeAccess
 * - Commands that open UI: `compositionRoot.session` / `.shell` (not raw setActive only)
 * - Tab strip open/focus/new-draft: **workspaceShellStore** owns TabSurface; shell may
 *   call `setActiveSessionId` as an internal side-effect — components must not pair both.
 *
 * @see ./storeOwnership.ts (`SESSION_OWNERSHIP`)
 * @see ./layoutStore.ts package header
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useShallow } from '../store/useShallowSelector';
import { useLayoutStore } from './layoutStore';
import { sidebarSessionsEqual } from './sessionListEqual';
import type { SessionState, SessionAgent } from './types';
import type { SessionActions } from './sessionActions';
import { getSessionById as getSessionByIdFromIndex } from './sessionIndex';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';

/** 与 layout 同引用：切片式 facade，禁止第二份 sessions 真相源 */
export const useSessionStore = useLayoutStore;

export type SessionFacadeState = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  composerDrafts: Record<string, string>;
};

export type SessionFacade = SessionFacadeState & SessionActions;

export const selectSessions = (s: Pick<SessionFacadeState, 'sessions'>) =>
  s.sessions;

export const selectSessionsById = (
  s: Pick<SessionFacadeState, 'sessionsById'>
) => s.sessionsById;

export const selectActiveSessionId = (
  s: Pick<SessionFacadeState, 'activeSessionId'>
) => s.activeSessionId;

export const selectFolderOrder = (s: Pick<SessionFacadeState, 'folderOrder'>) =>
  s.folderOrder;

export const selectActiveAgentId = (
  s: Pick<SessionFacadeState, 'activeAgentId'>
) => s.activeAgentId;

export const selectPanelAgentId = (
  s: Pick<SessionFacadeState, 'panelAgentId'>
) => s.panelAgentId;

export const selectActiveSession = (
  s: Pick<SessionFacadeState, 'sessions' | 'sessionsById' | 'activeSessionId'>
): SessionState | undefined => getSessionByIdFromIndex(s, s.activeSessionId);

export function useSessionField<T>(selector: (state: SessionFacade) => T): T {
  return useSessionStore(
    selector as (state: ReturnType<typeof useSessionStore.getState>) => T
  );
}

export function useSidebarSessions(searching: boolean): SessionState[] {
  // useSyncExternalStore 模板（AA-03 Q19）：订阅单一 store 快照 + 相等函数拦截，
  // 流式改 message 正文时 sessions 引用变化但侧栏壳字段不变 → 不重渲染。
  const snapshotRef = useRef<SessionState[]>(
    useSessionStore.getState().sessions
  );
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  const getSnapshot = useCallback((): SessionState[] => {
    const cur = useSessionStore.getState().sessions;
    if (
      searchingRef.current ||
      !sidebarSessionsEqual(snapshotRef.current, cur)
    ) {
      snapshotRef.current = cur;
    }
    return snapshotRef.current;
  }, []);

  return useSyncExternalStore(
    useCallback((cb: () => void) => useSessionStore.subscribe(cb), []),
    getSnapshot,
    getSnapshot
  );
}

export function useSessions(): SessionState[] {
  return useSessionStore(useShallow((s) => s.sessions));
}

export function useActiveSessionId(): string {
  return useSessionStore((s) => s.activeSessionId);
}

export function useActiveSession(): SessionState | undefined {
  return useSessionStore(useShallow(selectActiveSession));
}

export function useActiveAgentId(): string | null {
  return useSessionStore((s) => s.activeAgentId);
}

export function usePanelAgentId(): string | null {
  return useSessionStore((s) => s.panelAgentId);
}

/**
 * 域投影：LayoutStore 结构上包含 SessionFacade 全部字段与 actions。
 * 门禁要求 get*StoreState 使用 `as unknown as` 窄化到命名 Facade（禁止 any）。
 */
export function getSessionStoreState(): SessionFacade {
  return useSessionStore.getState() as unknown as SessionFacade;
}

export function getSessionById(sessionId: string): SessionState | undefined {
  return getSessionByIdFromIndex(getSessionStoreState(), sessionId);
}

export function getActiveSession(): SessionState | undefined {
  const s = getSessionStoreState();
  return getSessionByIdFromIndex(s, s.activeSessionId);
}

export function getActiveSessionId(): string {
  return getSessionStoreState().activeSessionId;
}

export function getSessionIndex(sessionId: string): number {
  const state = getSessionStoreState();
  return state.sessions.findIndex((s) => s.id === sessionId);
}

export function getSessionAgent(
  sessionId: string,
  agentId: string
): SessionAgent | undefined {
  const sess = getSessionById(sessionId);
  return sess?.agents?.find((a) => a.id === agentId);
}

export {
  getSessionById as getSessionByIdFromState,
  buildSessionsById,
  reindexSessionsById,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  isSessionEmpty,
} from './sessionIndex';

export type {
  SessionsIndexIssue,
  FilterSidebarSessionsOpts,
  PartitionSidebarSessionsOpts,
  PartitionedSidebarSessions,
} from './sessionIndex';

export {
  sessionShellEqual,
  sidebarSessionsEqual,
  sessionsShellEqual,
  sessionsSidebarEqual,
  sessionShellFingerprint,
} from './sessionListEqual';

export type { SessionActions } from './sessionActions';
export type { SessionState, SessionAgent, SessionMessage } from './types';
export { SessionCoordinator, deleteSessionCascade } from './SessionCoordinator';

sessionRuntimeRegistry.registerActiveIdResolver(
  () => useSessionStore.getState().activeSessionId
);
