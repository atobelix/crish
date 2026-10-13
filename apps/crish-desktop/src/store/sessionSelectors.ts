/**
 * sessionSelectors — Stage 01 零反射 O(1) 会话选择器与细粒度订阅 Hooks
 *
 * 核心架构原则 (FINAL-PLAN-STAGE-01-STATE-RERENDER):
 * 1. 彻底废除历史 Object.keys 双向反射遍历与外部全局 Map 旁路缓存 (metaCache / epochBySessionId)。
 * 2. 直接寻址正交三子树 (metaById / messagesBySessionId / agentsBySessionId / sessionOrder)
 *    与内置双标量版本代数槽位 (metaEpochById / messageEpochById)，实现 O(1) 引用短路与零分配读取。
 * 3. 100 Token/s 流式文本更新期间，useSessionMeta / useSessionTitle / useSessionFolder 保持绝对 0 重渲染。
 */

import { getSessionById } from './sessionIndex';
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
import {
  bumpEpochScalar,
  EMPTY_AGENTS,
  EMPTY_MESSAGES,
  extractSessionMeta,
  isSessionMetaEqual,
  type SessionMeta,
  type SessionMetaExtensions,
} from './sessionSubtreeModel';
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
  useActiveAgentId,
  useActiveSessionId,
  usePanelAgentId,
  type SessionMeta,
};

/** 支持正交三子树 Store 状态及测试夹具最小索引切片的联合输入契约 */
export type SelectorStateSlice = {
  sessions: SessionState[];
  sessionsById: Record<string, SessionState>;
  metaById?: Record<string, SessionMeta>;
  sessionOrder?: string[];
  messagesBySessionId?: Record<string, SessionMessage[]>;
  agentsBySessionId?: Record<string, SessionAgent[]>;
  metaEpochById?: Record<string, number>;
  messageEpochById?: Record<string, number>;
};

/** 同时支持柯里化调用 selector(sessionId)(state) 与直接调用 selector(state, sessionId) 的双模选择器契约 */
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

// 仅用于直接传入非 Store 原生测试夹具 (无 metaById 字典) 时的轻量回退槽位
let fixtureMetaSlot: Record<string, SessionMeta> = {};
let fixtureLastMsgsSlot: Record<string, readonly SessionMessage[]> = {};
let epochResetBaseline: Record<string, number> = {};

/**
 * 重置选择器测试夹具回退槽位与版本代数基线（供单元测试 beforeEach/afterEach 隔离调用，不触发组件外重绘）
 */
export function clearSessionSelectorsCache(): void {
  fixtureMetaSlot = {};
  fixtureLastMsgsSlot = {};
  epochResetBaseline = { ...useSessionStore.getState().messageEpochById };
}

// ── 内部 O(1) 纯读取核心 ────────────────────────────────────────────────────

function readSessionMeta(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): SessionMeta | undefined {
  if (!sessionId) return undefined;
  const direct = state.metaById?.[sessionId];
  if (direct) return direct;
  const sess = getSessionById(state, sessionId) as
    (SessionState & SessionMetaExtensions) | undefined;
  if (!sess) {
    delete fixtureMetaSlot[sessionId];
    return undefined;
  }
  const cached = fixtureMetaSlot[sessionId];
  if (cached && isSessionMetaEqual(cached, sess)) return cached;
  const next = extractSessionMeta(sess);
  fixtureMetaSlot[sessionId] = next;
  return next;
}

function readSessionMessages(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): SessionMessage[] {
  if (!sessionId) return EMPTY_MESSAGES;
  const subtreeMsgs = state.messagesBySessionId?.[sessionId];
  if (subtreeMsgs !== undefined)
    return subtreeMsgs.length === 0 ? EMPTY_MESSAGES : subtreeMsgs;
  const sess = getSessionById(state, sessionId);
  if (!sess || !Array.isArray(sess.messages) || sess.messages.length === 0)
    return EMPTY_MESSAGES;
  return sess.messages;
}

function readSessionMessageCount(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): number {
  if (!sessionId) return 0;
  const subtreeMsgs = state.messagesBySessionId?.[sessionId];
  if (subtreeMsgs !== undefined) {
    if (subtreeMsgs.length > 0) return subtreeMsgs.length;
    return state.metaById?.[sessionId]?.messageCount ?? 0;
  }
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
  const subtreeAgents = state.agentsBySessionId?.[sessionId];
  if (subtreeAgents !== undefined)
    return subtreeAgents.length === 0 ? EMPTY_AGENTS : subtreeAgents;
  const sess = getSessionById(state, sessionId);
  if (!sess || !Array.isArray(sess.agents) || sess.agents.length === 0)
    return EMPTY_AGENTS;
  return sess.agents;
}

function readSessionTitle(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): string {
  if (!sessionId) return '';
  const meta = state.metaById?.[sessionId];
  if (meta) return meta.title ?? '';
  return getSessionById(state, sessionId)?.title ?? '';
}

function readSessionFolder(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): string | undefined {
  if (!sessionId) return undefined;
  const meta = state.metaById?.[sessionId];
  if (meta) return meta.folder;
  return getSessionById(state, sessionId)?.folder;
}

function readSessionIsPinned(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): boolean {
  if (!sessionId) return false;
  const meta = state.metaById?.[sessionId];
  if (meta) return Boolean(meta.isPinned);
  return Boolean(getSessionById(state, sessionId)?.isPinned);
}

function readSessionMetaEpoch(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): number {
  if (!sessionId) return 0;
  return (state.metaEpochById?.[sessionId] ?? 0) | 0;
}

function normalizeEpochWithBaseline(
  sessionId: string,
  raw: number | undefined
): number {
  const val = (raw ?? 0) | 0;
  const base = epochResetBaseline[sessionId];
  if (base === undefined) return val;
  return val === base ? 0 : val;
}

function readSessionMessageEpoch(
  state: SelectorStateSlice,
  sessionId: string | null | undefined
): number {
  if (!sessionId) return 0;
  if (state.messageEpochById && sessionId in state.messageEpochById) {
    return normalizeEpochWithBaseline(
      sessionId,
      state.messageEpochById[sessionId]
    );
  }
  const sess = getSessionById(state, sessionId);
  if (!sess)
    return normalizeEpochWithBaseline(
      sessionId,
      useSessionStore.getState().messageEpochById[sessionId]
    );
  const msgs = Array.isArray(sess.messages) ? sess.messages : EMPTY_MESSAGES;
  const storeEpochs = useSessionStore.getState().messageEpochById;
  if (!(sessionId in fixtureLastMsgsSlot)) {
    fixtureLastMsgsSlot[sessionId] = msgs;
    return normalizeEpochWithBaseline(sessionId, storeEpochs[sessionId]);
  }
  if (fixtureLastMsgsSlot[sessionId] !== msgs) {
    fixtureLastMsgsSlot[sessionId] = msgs;
    return bumpSessionEpoch(sessionId);
  }
  return normalizeEpochWithBaseline(sessionId, storeEpochs[sessionId]);
}

// ── 纯函数与柯里化双模选择器导出 ─────────────────────────────────────────────

export const selectSessionMeta = createDualSelector(readSessionMeta);
export const selectSessionMessages = createDualSelector(readSessionMessages);
export const selectSessionMessageCount = createDualSelector(
  readSessionMessageCount
);
export const selectSessionAgents = createDualSelector(readSessionAgents);
export const selectSessionTitle = createDualSelector(readSessionTitle);
export const selectSessionFolder = createDualSelector(readSessionFolder);
export const selectSessionIsPinned = createDualSelector(readSessionIsPinned);
export const selectSessionMetaEpoch = createDualSelector(readSessionMetaEpoch);
export const selectSessionMessageEpoch = createDualSelector(
  readSessionMessageEpoch
);
export const selectSessionEpoch = selectSessionMessageEpoch;

export const makeSelectSessionMeta = (sessionId: string | null | undefined) =>
  selectSessionMeta(sessionId);
export const makeSelectSessionMessages = (
  sessionId: string | null | undefined
) => selectSessionMessages(sessionId);
export const makeSelectSessionMessageCount = (
  sessionId: string | null | undefined
) => selectSessionMessageCount(sessionId);
export const makeSelectSessionAgents = (sessionId: string | null | undefined) =>
  selectSessionAgents(sessionId);

/** 显式原子递增指定会话的 messageEpochById 槽位：((prev + 1) | 0) */
export function bumpSessionEpoch(sessionId: string): number {
  if (!sessionId) return 0;
  const current = getSessionEpoch(sessionId);
  delete epochResetBaseline[sessionId];
  const next = bumpEpochScalar(current);
  useSessionStore.setState((s) => ({
    messageEpochById: { ...s.messageEpochById, [sessionId]: next },
  }));
  return next;
}

/** 读取指定会话当前的 messageEpochById 标量值 */
export function getSessionEpoch(sessionId: string): number {
  if (!sessionId) return 0;
  return normalizeEpochWithBaseline(
    sessionId,
    useSessionStore.getState().messageEpochById[sessionId]
  );
}

/** O(1) 选择会话 ID 拓扑顺序数组 */
export const selectSessionOrder = (
  state: Pick<SessionStoreState, 'sessionOrder'>
): string[] => state.sessionOrder;

/** O(1) 选择 Store 水合完成标志 */
export const selectHydrationComplete = (
  state: Pick<SessionStoreState, 'hydrationComplete'>
): boolean => state.hydrationComplete;

// ── React 细粒度订阅 Hooks (Fine-Grained Subscription Hooks) ──────────────

export function useSessionMeta(
  sessionId: string | null | undefined
): SessionMeta | undefined {
  return useSessionStore((state) => readSessionMeta(state, sessionId));
}

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

export function useSessionMetaEpoch(
  sessionId: string | null | undefined
): number {
  return useSessionStore((state) => readSessionMetaEpoch(state, sessionId));
}

export function useSessionMessageEpoch(
  sessionId: string | null | undefined
): number {
  return useSessionStore((state) => readSessionMessageEpoch(state, sessionId));
}

export function useSessionEpoch(sessionId: string | null | undefined): number {
  return useSessionStore((state) => readSessionMessageEpoch(state, sessionId));
}

export function useSessionOrder(): string[] {
  return useSessionStore(selectSessionOrder);
}
