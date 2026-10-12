/**
 * sessionSelectors — 细粒度状态切片与高效选择器 (Wave 3 W3-2)
 *
 * 核心目标：
 * 1. 彻底解决组件直接从全局 store 解构全量 `sessionsById` 导致的级联重渲染扩散问题；
 * 2. 构建单轨细粒度按需订阅通道：
 *    - `useSessionMeta(sessionId)`：仅订阅单个会话的元数据（标题、时间戳、归组、固定态等），与高频流式消息彻底物理隔离；
 *    - `useSessionMessages(sessionId)`：仅订阅单个会话的消息数组引用；
 *    - `useSessionMessageCount(sessionId)`：仅订阅单个会话的消息计数；
 *    - `useActiveSessionId()`：仅订阅当前活跃会话 ID；
 * 3. 结合 Zustand 的 selector 机制与缓存比较算法，实现流式 Token 推送期间侧边栏等低频组件 0 重渲染。
 */

import { useCallback } from 'react';
import { useShallow } from './useShallowSelector';
import { useSessionStore, type SessionStoreState } from './sessionStore';
import type {
  SessionState,
  SessionMessage,
  SessionGoalMode,
  SessionImportMeta,
} from './types';

/**
 * 会话轻量元数据切片 (SessionMeta)
 * 物理上与高频 messages 和 agents 数组解耦，专供侧边栏、标题栏与面板元信息组件订阅。
 */
export interface SessionMeta {
  readonly id: string;
  title: string;
  titleSource?: 'auto-trivial' | 'auto' | 'user';
  folder?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  branchParentId?: string;
  timestamp?: string;
  timestampSource?: 'local' | 'remote';
  pinnedMessageIds?: string[];
  pinnedMessageColors?: Record<string, string>;
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
  messagesHydrated?: boolean;
  messageCount?: number;
  hydrateTruncated?: boolean;
  goalMode?: SessionGoalMode;
  truncatedToolChainIds?: string[];
  importMeta?: SessionImportMeta;
  unreadCount?: number;
  createdAt?: string;
  updatedAt?: string;
  activeAgentId?: string | null;
  [key: string]: unknown;
}

/** 不可变全局空消息数组常量，彻底杜绝 fallback [] 导致的引用漂移与无效重绘 */
export const EMPTY_MESSAGES: readonly SessionMessage[] = Object.freeze([]);

/** 浅比较数组元素引用一致性 */
function shallowArrayEqual<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 浅比较 Record 属性一致性 */
function shallowRecordEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * 判断 SessionMeta 与当前 SessionState 的元数据字段是否保持绝对一致。
 * 忽略高频变化的 messages 与 agents 数组。
 */
export function isSessionMetaEqual(
  prev: SessionMeta,
  sess: SessionState
): boolean {
  if (prev.id !== sess.id) return false;
  if (prev.title !== sess.title) return false;
  if (prev.titleSource !== sess.titleSource) return false;
  if (prev.folder !== sess.folder) return false;
  if (prev.isPinned !== sess.isPinned) return false;
  if (prev.isArchived !== sess.isArchived) return false;
  if (prev.branchParentId !== sess.branchParentId) return false;
  if (prev.timestamp !== sess.timestamp) return false;
  if (prev.timestampSource !== sess.timestampSource) return false;
  if (prev.engineCursor !== sess.engineCursor) return false;
  if (prev.engineLastRunId !== sess.engineLastRunId) return false;
  if (prev.hydratedFromEngine !== sess.hydratedFromEngine) return false;
  if (prev.messagesHydrated !== sess.messagesHydrated) return false;
  if (prev.messageCount !== sess.messageCount) return false;
  if (prev.hydrateTruncated !== sess.hydrateTruncated) return false;
  if (prev.goalMode !== sess.goalMode) return false;
  if (prev.unreadCount !== (sess as any).unreadCount) return false;
  if (prev.createdAt !== (sess as any).createdAt) return false;
  if (prev.updatedAt !== (sess as any).updatedAt) return false;
  if (prev.activeAgentId !== (sess as any).activeAgentId) return false;

  if (!shallowArrayEqual(prev.pinnedMessageIds, sess.pinnedMessageIds)) {
    return false;
  }
  if (
    !shallowArrayEqual(prev.truncatedToolChainIds, sess.truncatedToolChainIds)
  ) {
    return false;
  }
  if (!shallowRecordEqual(prev.pinnedMessageColors, sess.pinnedMessageColors)) {
    return false;
  }
  if (!shallowRecordEqual(prev.importMeta, sess.importMeta)) {
    return false;
  }

  // 遍历 sess 上可能存在的扩展属性（排除 messages 和 agents）
  const sessRecord = sess as unknown as Record<string, unknown>;
  const sessKeys = Object.keys(sess);
  for (const key of sessKeys) {
    if (key === 'messages' || key === 'agents') continue;
    if (!(key in prev)) return false;
    const prevVal = (prev as Record<string, unknown>)[key];
    const sessVal = sessRecord[key];
    if (prevVal !== sessVal) {
      if (Array.isArray(prevVal) && Array.isArray(sessVal)) {
        if (!shallowArrayEqual(prevVal, sessVal)) return false;
      } else if (
        prevVal &&
        sessVal &&
        typeof prevVal === 'object' &&
        typeof sessVal === 'object'
      ) {
        if (
          !shallowRecordEqual(
            prevVal as Record<string, unknown>,
            sessVal as Record<string, unknown>
          )
        ) {
          return false;
        }
      } else {
        return false;
      }
    }
  }

  const prevKeys = Object.keys(prev);
  for (const key of prevKeys) {
    if (key === 'messages' || key === 'agents') continue;
    if (
      !(key in sess) &&
      (prev as Record<string, unknown>)[key] !== undefined
    ) {
      return false;
    }
  }

  return true;
}

/**
 * 从 SessionState 中剥离 messages 与 agents，提取纯元数据对象
 */
export function extractSessionMeta(sess: SessionState): SessionMeta {
  const {
    messages: _m,
    agents: _a,
    ...meta
  } = sess as unknown as Record<string, unknown>;
  return Object.freeze({ ...meta }) as unknown as SessionMeta;
}

// ── 细粒度选择器缓存表 ────────────────────────────────────────────────────────

const metaCache = new Map<string, SessionMeta>();

/** 清除元数据选择器缓存（供测试重置与状态彻底重建时调用） */
export function clearSessionSelectorsCache(): void {
  metaCache.clear();
}

// ── 纯选择器函数 (Pure Selectors) ─────────────────────────────────────────────

/**
 * 单会话元数据选择器
 * 基于 sessionId 从 sessionsById 检索，命中缓存且未发生元数据变更时返回相同引用
 */
export const selectSessionMeta =
  (sessionId: string) =>
  (s: SessionStoreState): SessionMeta | undefined => {
    if (!sessionId) return undefined;
    const sess = s.sessionsById?.[sessionId];
    if (!sess) {
      if (metaCache.has(sessionId)) {
        metaCache.delete(sessionId);
      }
      return undefined;
    }

    const cached = metaCache.get(sessionId);
    if (cached && isSessionMetaEqual(cached, sess)) {
      return cached;
    }

    const nextMeta = extractSessionMeta(sess);
    metaCache.set(sessionId, nextMeta);
    return nextMeta;
  };

export const makeSelectSessionMeta = selectSessionMeta;

/**
 * 单会话消息数组选择器
 * 仅返回当前会话的消息数组引用，会话不存在时返回不可变常量 EMPTY_MESSAGES
 */
export const selectSessionMessages =
  (sessionId: string) =>
  (s: SessionStoreState): SessionMessage[] =>
    (s.sessionsById?.[sessionId]?.messages as SessionMessage[]) ??
    (EMPTY_MESSAGES as SessionMessage[]);

export const makeSelectSessionMessages = selectSessionMessages;

/**
 * 单会话消息数量选择器
 * 优先取 messages 数组长度，未水合时回退至 messageCount
 */
export const selectSessionMessageCount =
  (sessionId: string) =>
  (s: SessionStoreState): number => {
    const sess = s.sessionsById?.[sessionId];
    if (!sess) return 0;
    if (Array.isArray(sess.messages)) return sess.messages.length;
    return sess.messageCount ?? 0;
  };

export const makeSelectSessionMessageCount = selectSessionMessageCount;

/**
 * 单会话标题标量选择器
 * 仅返回目标会话的 title 字符串，会话不存在时返回空字符串
 */
export const selectSessionTitle =
  (sessionId: string) =>
  (s: SessionStoreState): string => {
    if (!sessionId) return '';
    return s.sessionsById?.[sessionId]?.title ?? '';
  };

/**
 * 单会话所属文件夹标量选择器
 * 仅返回目标会话的 folder 字符串，会话不存在时返回 undefined
 */
export const selectSessionFolder =
  (sessionId: string) =>
  (s: SessionStoreState): string | undefined => {
    if (!sessionId) return undefined;
    return s.sessionsById?.[sessionId]?.folder;
  };

/**
 * 单会话置顶状态标量选择器
 * 仅返回目标会话的 isPinned 布尔值，会话不存在时返回 false
 */
export const selectSessionIsPinned =
  (sessionId: string) =>
  (s: SessionStoreState): boolean => {
    if (!sessionId) return false;
    return Boolean(s.sessionsById?.[sessionId]?.isPinned);
  };

/**
 * 当前活跃会话 ID 选择器
 */
export const selectActiveSessionId = (s: SessionStoreState): string =>
  s.activeSessionId ?? '';

// ── React Hooks 订阅接口 (Fine-Grained Zustand Hooks) ─────────────────────────

/**
 * 订阅单个会话的元数据切片
 * 消息流式推流（仅变更 text/thinking 等消息内容）绝不触发本 Hook 的订阅者重渲染。
 */
export function useSessionMeta(sessionId: string): SessionMeta | undefined {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionMeta(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(useShallow(selector));
}

/**
 * 订阅单个会话的消息数组引用
 * 仅当本会话消息发生变动时触发更新，其他会话消息变动不引发重渲染。
 */
export function useSessionMessages(sessionId: string): SessionMessage[] {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionMessages(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(selector);
}

/**
 * 订阅单个会话的消息数量
 * 消息流式输出期间长度不变，绝不触发重绘；仅在新增或撤回消息时响应。
 */
export function useSessionMessageCount(sessionId: string): number {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionMessageCount(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(selector);
}

/**
 * 订阅单个会话的标题标量
 * 消息流式输出与非标题元数据变动不触发重绘；仅在 title 变化时更新。
 */
export function useSessionTitle(sessionId: string): string {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionTitle(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(selector);
}

/**
 * 订阅单个会话的所属文件夹标量
 * 消息流式输出与非文件夹元数据变动不触发重绘；仅在 folder 变化时更新。
 */
export function useSessionFolder(sessionId: string): string | undefined {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionFolder(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(selector);
}

/**
 * 订阅单个会话的置顶状态标量
 * 消息流式输出与非置顶元数据变动不触发重绘；仅在 isPinned 变化时更新。
 */
export function useSessionIsPinned(sessionId: string): boolean {
  const selector = useCallback(
    (state: SessionStoreState) => selectSessionIsPinned(sessionId)(state),
    [sessionId]
  );
  return useSessionStore(selector);
}

/**
 * 订阅当前活跃会话 ID
 */
export function useActiveSessionId(): string {
  return useSessionStore(selectActiveSessionId);
}
