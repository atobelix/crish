/**
 * 会话读取入口。唯一源是 sessionsById + sessionOrder。
 * 标量与数组选择器直接取会话字段：未改到的字符串和数组引用保持稳定，
 * 流式改正文时标题、文件夹、置顶和 agents 不跟着重绘。
 */

import { getSessionById, selectSessionList } from './sessionIndex';
import {
  selectActiveAgentId,
  selectActiveSessionId,
  selectFolderOrder,
  selectPanelAgentId,
  selectSessionHydrated,
  useActiveAgentId,
  useActiveSessionId,
  usePanelAgentId,
  useSessionStore,
  type SessionStoreState,
} from './sessionStore';
import { EMPTY_AGENTS, EMPTY_MESSAGES } from './persistenceConstants';
import { extractSessionMeta, type SessionMeta } from './sessionMeta';
import { isSessionMetaEqual } from './sessionMetaEqual';
import type { SessionAgent, SessionMessage, SessionState } from './types';

export {
  EMPTY_AGENTS,
  EMPTY_MESSAGES,
  extractSessionMeta,
  isSessionMetaEqual,
  selectActiveAgentId,
  selectActiveSessionId,
  selectFolderOrder,
  selectPanelAgentId,
  selectSessionHydrated,
  selectSessionList,
  useActiveAgentId,
  useActiveSessionId,
  usePanelAgentId,
  type SessionMeta,
};

export type SelectorStateSlice = {
  sessionsById: Record<string, SessionState>;
  sessionOrder: string[];
};

/** 同时支持 selector(sessionId)(state) 与 selector(state, sessionId) */
export interface DualSessionSelector<R> {
  (sessionId: string | null | undefined): (state: SelectorStateSlice) => R;
  (state: SelectorStateSlice, sessionId: string | null | undefined): R;
}

function createDualSelector<R>(
  fn: (state: SelectorStateSlice, sessionId: string | null | undefined) => R
): DualSessionSelector<R> {
  function selector(
    arg1: SelectorStateSlice | string | null | undefined,
    arg2?: string | null | undefined
  ): R | ((state: SelectorStateSlice) => R) {
    if (typeof arg1 === 'object' && arg1 !== null) {
      return fn(arg1, arg2);
    }
    return (state: SelectorStateSlice) => fn(state, arg1);
  }
  return selector as DualSessionSelector<R>;
}

function readSessionMessages(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): SessionMessage[] {
  if (!sessionId) return EMPTY_MESSAGES;
  const messages = getSessionById(state, sessionId)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return EMPTY_MESSAGES;
  return messages;
}

function readSessionMessageCount(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): number {
  if (!sessionId) return 0;
  const sess = getSessionById(state, sessionId);
  if (!sess) return 0;
  return Array.isArray(sess.messages) && sess.messages.length > 0
    ? sess.messages.length
    : (sess.messageCount ?? 0);
}

function readSessionAgents(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): SessionAgent[] {
  if (!sessionId) return EMPTY_AGENTS;
  const agents = getSessionById(state, sessionId)?.agents;
  if (!Array.isArray(agents) || agents.length === 0) return EMPTY_AGENTS;
  return agents;
}

function readSessionTitle(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): string {
  if (!sessionId) return '';
  return getSessionById(state, sessionId)?.title ?? '';
}

function readSessionFolder(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): string | undefined {
  if (!sessionId) return undefined;
  return getSessionById(state, sessionId)?.folder;
}

function readSessionIsPinned(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): boolean {
  if (!sessionId) return false;
  return Boolean(getSessionById(state, sessionId)?.isPinned);
}

export const selectSessionMessages = createDualSelector(readSessionMessages);
export const selectSessionMessageCount = createDualSelector(
  readSessionMessageCount
);
export const selectSessionAgents = createDualSelector(readSessionAgents);
export const selectSessionTitle = createDualSelector(readSessionTitle);
export const selectSessionFolder = createDualSelector(readSessionFolder);
export const selectSessionIsPinned = createDualSelector(readSessionIsPinned);

export function selectSession(
  id: string
): (state: Pick<SelectorStateSlice, 'sessionsById'>) => SessionState | undefined {
  return (state) => getSessionById(state, id);
}

export const makeSelectSessionMessages = (
  sessionId: string | null | undefined
) => selectSessionMessages(sessionId);
export const makeSelectSessionMessageCount = (
  sessionId: string | null | undefined
) => selectSessionMessageCount(sessionId);
export const makeSelectSessionAgents = (
  sessionId: string | null | undefined
) => selectSessionAgents(sessionId);

export const selectSessionOrder = (
  state: Pick<SessionStoreState, 'sessionOrder'>
): string[] => state.sessionOrder;

export const selectHydrationComplete = (
  state: Pick<SessionStoreState, 'hydrationComplete'>
): boolean => state.hydrationComplete;

export function useSessionMessages(
  sessionId: string | null | undefined
): SessionMessage[] {
  return useSessionStore((state) => readSessionMessages(state, sessionId));
}

export function useSessionMessageCount(
  sessionId: string | null | undefined
): number {
  return useSessionStore((state) => readSessionMessageCount(state, sessionId));
}

export function useSessionAgents(
  sessionId: string | null | undefined
): SessionAgent[] {
  return useSessionStore((state) => readSessionAgents(state, sessionId));
}

export function useSessionTitle(sessionId: string | null | undefined): string {
  return useSessionStore((state) => readSessionTitle(state, sessionId));
}

export function useSessionFolder(
  sessionId: string | null | undefined
): string | undefined {
  return useSessionStore((state) => readSessionFolder(state, sessionId));
}

export function useSessionIsPinned(
  sessionId: string | null | undefined
): boolean {
  return useSessionStore((state) => readSessionIsPinned(state, sessionId));
}

export function useSessionOrder(): string[] {
  return useSessionStore(selectSessionOrder);
}
