import { useEffect, useReducer, useRef } from 'react';
/**
 * Session domain store façade (phased multi-store migration — Option A).
 *
 * ## Current (Phase 0/1)
 * Single zustand instance lives in `layoutStore.ts` (`useLayoutStore`).
 * This module is a **typed alias / selector layer** for session fields only:
 * - `useSessionStore` === `useLayoutStore` (same reference, getState, setState)
 * - Prefer named selectors / `useSessionField` so call sites only touch session domain
 * - `getSessionById(id)` — O(1) lookup on the live store
 *
 * New session-domain code should import from here (or `../store` barrel), not layoutStore.
 *
 * ## Future (Phase 2+)
 * Move `sessions` / `sessionsById` / `folderOrder` / `activeSessionId` /
 * `activeAgentId` / `panelAgentId` + SessionActions into a real separate `create()`.
 * Rewrite this file only; keep hook names and selectors stable. Avoid dual-write until cutover.
 *
 * Do not break: `export { useLayoutStore } from './layoutStore'` compatibility.
 *
 * 对齐约定（与 workspaceStore / settingsUiStore 一致）：
 * - 便捷 hooks 经 useSessionStore 订阅
 * - 命令式：getSessionStoreState / getSessionById / getActiveSession / getSessionAgent
 */

import { useLayoutStore } from './layoutStore';
import { sidebarSessionsEqual } from './sessionListEqual';
import type { SessionState } from './types';
import type { SessionActions } from './sessionActions';
import type { SessionsIndexed } from './sessionIndex';
import {
  getSessionById as getSessionByIdFromIndex,
  getSessionIndex as getSessionIndexFromIndex,
} from './sessionIndex';

// useLayoutStore 仅用于别名绑定；订阅/命令式路径统一走 useSessionStore。

/** Session-domain state slice (aligned with SessionStoreSlice / LayoutStore). */
export type SessionFacadeState = SessionsIndexed & {
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
};

/** Session domain: state + actions. */
export type SessionFacade = SessionFacadeState & SessionActions;

/**
 * Same underlying store as `useLayoutStore` (Phase 1 alias).
 * Pass selectors that only read session-domain fields so a future physical split
 * only needs this module to change.
 */
export const useSessionStore = useLayoutStore;

// ── Named selectors (use with useSessionStore(selectX) or useLayoutStore(selectX)) ──

export const selectSessions = (s: Pick<SessionFacadeState, 'sessions'>) => s.sessions;

export const selectSessionsById = (s: Pick<SessionFacadeState, 'sessionsById'>) =>
  s.sessionsById;

export const selectActiveSessionId = (s: Pick<SessionFacadeState, 'activeSessionId'>) =>
  s.activeSessionId;

export const selectFolderOrder = (s: Pick<SessionFacadeState, 'folderOrder'>) =>
  s.folderOrder;

export const selectActiveAgentId = (s: Pick<SessionFacadeState, 'activeAgentId'>) =>
  s.activeAgentId;

export const selectPanelAgentId = (s: Pick<SessionFacadeState, 'panelAgentId'>) =>
  s.panelAgentId;

/** O(1) active session via sessionsById (falls back inside getSessionById). */
export const selectActiveSession = (
  s: Pick<SessionFacadeState, 'sessions' | 'sessionsById' | 'activeSessionId'>,
): SessionState | undefined => getSessionByIdFromIndex(s, s.activeSessionId);

// ── React helpers ───────────────────────────────────────────────────────────

/**
 * Subscribe to a session-domain slice. Prefer over bare `useLayoutStore` when the
 * component does not need workspace / UI / telemetry fields.
 *
 * @example
 *   const id = useSessionField((s) => s.activeSessionId);
 *   const session = useSessionField(selectActiveSession);
 */
export function useSessionField<T>(selector: (state: SessionFacade) => T): T {
  return useSessionStore(
    selector as (state: ReturnType<typeof useSessionStore.getState>) => T,
  );
}

/**
 * 侧栏专用 sessions 订阅：无搜索时用壳字段 equality 挡掉流式正文抖动。
 * 不用 zustand/traditional（避免 use-sync-external-store 路径解析白屏）。
 * 订阅走 useSessionStore（与 useLayoutStore 同实例），保持三门面一致。
 */
export function useSidebarSessions(searching: boolean): SessionState[] {
  const equal = (a: SessionState[], b: SessionState[]) =>
    sidebarSessionsEqual(a, b, searching);
  const snapshotRef = useRef<SessionState[]>(useSessionStore.getState().sessions);
  // 保证首屏与当前 store 对齐
  if (searching || !equal(snapshotRef.current, useSessionStore.getState().sessions)) {
    snapshotRef.current = useSessionStore.getState().sessions;
  }
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  useEffect(() => {
    return useSessionStore.subscribe((state) => {
      const next = state.sessions;
      const eq = sidebarSessionsEqual(snapshotRef.current, next, searchingRef.current);
      if (!eq) {
        snapshotRef.current = next;
        bump();
      }
    });
  }, []);

  return snapshotRef.current;
}


export function useSessions(): SessionState[] {
  return useSessionStore((s) => s.sessions);
}

export function useActiveSessionId(): string {
  return useSessionStore((s) => s.activeSessionId);
}

export function useActiveSession(): SessionState | undefined {
  return useSessionField(selectActiveSession);
}

export function useActiveAgentId(): string | null {
  return useSessionStore((s) => s.activeAgentId);
}

export function usePanelAgentId(): string | null {
  return useSessionStore((s) => s.panelAgentId);
}

// ── Imperative helpers (non-React hot path) ─────────────────────────────────

export function getSessionStoreState(): SessionFacade {
  return useSessionStore.getState() as unknown as SessionFacade;
}

/** O(1) session lookup against the live store (no React subscription). */
export function getSessionById(sessionId: string): SessionState | undefined {
  return getSessionByIdFromIndex(getSessionStoreState(), sessionId);
}

/** 当前活动会话（O(1)；与 storeAccess.getActiveSession 同源） */
export function getActiveSession(): SessionState | undefined {
  const s = getSessionStoreState();
  return getSessionByIdFromIndex(s, s.activeSessionId);
}

/** 当前活动会话 id（命令式；与 storeAccess.getActiveSessionId 同源） */
export function getActiveSessionId(): string {
  return getSessionStoreState().activeSessionId;
}

export function getSessionIndex(sessionId: string): number {
  return getSessionIndexFromIndex(getSessionStoreState(), sessionId);
}

/**
 * Pure state helper for immer recipes / tests that already hold a state object.
 * For live-store lookups use the no-state `getSessionById(id)` above.
 */
export {
  getSessionById as getSessionByIdFromState,
  buildSessionsById,
  reindexSessionsById,
  checkSessionsIndex,
  isSessionsIndexConsistent,
  assertSessionsIndexConsistent,
  // 侧栏投影：与 sessionIndex 同源，组件应经 facade 或 sessionIndex 取用
  filterSidebarSessions,
  partitionSidebarSessions,
  groupUnpinnedByProject,
  isPlaceholderEmptySession,
  findReusableEmptySession,
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

/** 按 id 取会话内 agent（O(1) 会话 + O(n) agents） */
export function getSessionAgent(
  sessionId: string,
  agentId: string,
): import('./types').SessionAgent | undefined {
  const sess = getSessionById(sessionId);
  return sess?.agents?.find((a) => a.id === agentId);
}
