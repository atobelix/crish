/**
 * sessionMeta — 会话元数据契约（SessionMeta）与提取：物理剥离高频 messages 与 agents 数组
 */

import type { SessionState } from './types';

export interface SessionMetaExtensions {
  unreadCount?: number;
  createdAt?: string;
  updatedAt?: string;
  activeAgentId?: string | null;
}

/** 权威纯净会话元数据切片 (SessionMeta)，物理剥离高频 messages 与 agents 数组 */
export interface SessionMeta
  extends Omit<SessionState, 'messages' | 'agents'>, SessionMetaExtensions {
  readonly id: string;
}

/** 从会话实体提取纯净、不可变冻结的 SessionMeta（物理剥离 messages 与 agents） */
export function extractSessionMeta(
  sess: (SessionState & SessionMetaExtensions) | SessionMeta
): SessionMeta {
  const {
    messages: _m,
    agents: _a,
    ...rest
  } = sess as SessionMeta & { messages?: unknown; agents?: unknown };
  return Object.freeze({
    ...rest,
    id: sess.id,
    title: sess.title,
    folder: sess.folder,
    isPinned: Boolean(sess.isPinned),
    isArchived: Boolean(sess.isArchived),
    timestamp: sess.timestamp,
  });
}
