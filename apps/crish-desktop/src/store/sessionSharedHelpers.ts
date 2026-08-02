import {
  isDefaultSessionTitle,
  isEmptyShellSession,
  maybeAutoTitleFromMessages,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  truncateSessionTitle,
} from '../api/sessionTitle';
import { recordMessageUpsert } from '../api/controlMetrics';
import { PENDING_DRAFT_SESSION_ID } from './draftSession';
import type {
  MessageToolCall,
  SessionAgent,
  SessionAgentPatch,
  SessionMessage,
  SessionState,
} from './types';
import {
  getSessionForWrite,
  reindexSessionsById,
  type SessionsIndexed,
} from './sessionIndex';
import type { SessionStoreSlice } from './sessionActions';
import { useTerminalStore } from './terminalStore';

/** 手动 rename / 分叉标题码点上限（略宽于侧栏自动标题 28） */
export const MANUAL_SESSION_TITLE_MAX_LEN = 48;

export function getMessageById(
  messages: SessionMessage[] | undefined,
  messageId: string
): SessionMessage | undefined {
  return messages?.find((m) => m.id === messageId);
}

/**
 * 是否应在 activate 时从引擎懒加载正文。
 *
 * 设计（非丢消息 bug）：
 * - 本地落盘 / SQLite hydrate 会带全量 messages（eager）
 * - daemon list-sessions 插入的远程壳只有 title，messages=[]（lazy）
 * - sessions[] 与 sessionsById 同引用；空 messages 两边同时可见
 * - setActiveSessionId 在 !hydratedFromEngine && messages 为空时拉 session-events
 *
 * 因此 MCP / 调试看到「有 title、messages.length===0」对未 activate 的远程壳是预期态。
 */
export function needsEngineMessageHydrate(
  sess:
    | Pick<SessionState, 'hydratedFromEngine' | 'messages'>
    | null
    | undefined
): boolean {
  if (!sess) return false;
  if (sess.hydratedFromEngine) return false;
  return !sess.messages || sess.messages.length === 0;
}

/**
 * 写路径取 session + message：经 getSessionForWrite，避免 immer 只 fork
 * sessionsById 导致 sessions[].messages 与 map 分叉。
 * 仅用于 mutate；纯读请 getSessionById + getMessageById。
 */
export function getSessionMessage(
  state: SessionsIndexed,
  sessionId: string,
  messageId: string
): { session: SessionState; message: SessionMessage } | undefined {
  const session = getSessionForWrite(state, sessionId);
  if (!session?.messages) return undefined;
  const message = getMessageById(session.messages, messageId);
  if (!message) return undefined;
  return { session, message };
}

export function getSessionAgent(
  session: SessionState,
  agentId: string
): SessionAgent | undefined {
  return session.agents?.find((a) => a.id === agentId);
}

export function toolCallPatchHasChanges(
  tc: MessageToolCall,
  updates: Partial<MessageToolCall>
): boolean {
  if (updates.id !== undefined && tc.id !== updates.id) return true;
  if (updates.name !== undefined && tc.name !== updates.name) return true;
  if (updates.arguments !== undefined && tc.arguments !== updates.arguments) return true;
  if (updates.status !== undefined && tc.status !== updates.status) return true;
  if (updates.output !== undefined && tc.output !== updates.output) return true;
  if (updates.diffs !== undefined && tc.diffs !== updates.diffs) return true;
  if (updates.explanation !== undefined && tc.explanation !== updates.explanation) return true;
  if (updates.approvalMeta !== undefined && tc.approvalMeta !== updates.approvalMeta) return true;
  if (updates.approvalDecision !== undefined && tc.approvalDecision !== updates.approvalDecision) return true;
  if (updates.startedAt !== undefined && tc.startedAt !== updates.startedAt) return true;
  if (updates.completedAt !== undefined && tc.completedAt !== updates.completedAt) return true;
  if (updates.turnId !== undefined && tc.turnId !== updates.turnId) return true;
  return false;
}

export function sanitizeToolCallUpdates(
  tc: MessageToolCall,
  updates: Partial<MessageToolCall>
): Partial<MessageToolCall> {
  if (
    (tc.status === 'success' || tc.status === 'error') &&
    updates.status === 'running'
  ) {
    const { status: _droppedStatus, ...rest } = updates;
    return rest;
  }
  return updates;
}

export function applyMessageToolCallPatch(
  target: MessageToolCall,
  updates: Partial<MessageToolCall>
): void {
  if (updates.id !== undefined) target.id = updates.id;
  if (updates.name !== undefined) target.name = updates.name;
  if (updates.arguments !== undefined) target.arguments = updates.arguments;
  if (updates.status !== undefined) target.status = updates.status;
  if (updates.output !== undefined) target.output = updates.output;
  if (updates.diffs !== undefined) target.diffs = updates.diffs;
  if (updates.explanation !== undefined) target.explanation = updates.explanation;
  if (updates.approvalMeta !== undefined) target.approvalMeta = updates.approvalMeta;
  if (updates.approvalDecision !== undefined) target.approvalDecision = updates.approvalDecision;
  if (updates.startedAt !== undefined) target.startedAt = updates.startedAt;
  if (updates.completedAt !== undefined) target.completedAt = updates.completedAt;
  if (updates.turnId !== undefined) target.turnId = updates.turnId;
}

export function applySessionAgentPatch(
  target: SessionAgent,
  patch: SessionAgentPatch
): void {
  if (patch.status !== undefined) target.status = patch.status;
  if (patch.summary !== undefined) target.summary = patch.summary;
  if (patch.endedAt !== undefined) target.endedAt = patch.endedAt;
  if (patch.description !== undefined) target.description = patch.description;
  if (patch.depth !== undefined) target.depth = patch.depth;
  if (patch.subagentPath !== undefined) target.subagentPath = patch.subagentPath;
  if (patch.subagentRunId !== undefined) target.subagentRunId = patch.subagentRunId;
}

export function cloneMessages(messages: SessionMessage[]): SessionMessage[] {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(messages);
    }
  } catch {
    /* fallback when Immer proxy or non-cloneable objects are present */
  }
  return JSON.parse(JSON.stringify(messages)) as SessionMessage[];
}

/** 消息 status 进展等级：终态（completed/error）高于流式 partial */
const MESSAGE_STATUS_RANK: Record<
  NonNullable<SessionMessage['status']>,
  number
> = {
  queued: 1,
  processing: 2,
  completed: 3,
  error: 3,
};

/** 是否为终态 status（completed / error） */
export function isTerminalSessionMessageStatus(
  status: SessionMessage['status'] | undefined
): boolean {
  return status === 'completed' || status === 'error';
}

/**
 * 合并 status：prefer completed/error over processing/queued。
 * 同级时：error 不被 completed 降级；其余取 incoming。
 */
export function preferSessionMessageStatus(
  existing: SessionMessage['status'] | undefined,
  incoming: SessionMessage['status'] | undefined
): SessionMessage['status'] | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  const re = MESSAGE_STATUS_RANK[existing] ?? 0;
  const ri = MESSAGE_STATUS_RANK[incoming] ?? 0;
  if (ri > re) return incoming;
  if (ri < re) return existing;
  // 同级：error 保持（不因 completed 回放抹掉失败）
  if (existing === 'error' && incoming === 'completed') return existing;
  return incoming;
}

/**
 * 合并文本：空串不抹已有；终态正文不被 partial 流缩短/覆盖。
 * 同为 partial 时取更长（乱序 chunk 容忍）。
 */
export function preferSessionMessageText(
  existingText: string | undefined,
  existingStatus: SessionMessage['status'] | undefined,
  incomingText: string | undefined,
  incomingStatus: SessionMessage['status'] | undefined
): string | undefined {
  if (incomingText === undefined) return existingText;
  const ex = existingText ?? '';
  const inc = incomingText;
  // 显式空串仅在 existing 尚无正文时落地
  if (inc === '' && ex !== '') return existingText;

  const exTerm = isTerminalSessionMessageStatus(existingStatus);
  const inTerm = isTerminalSessionMessageStatus(incomingStatus);

  // 已 completed/error：partial 不得回写更短/中间态正文
  if (exTerm && !inTerm) {
    return ex !== '' ? existingText : inc || existingText;
  }
  // partial → 终态：优先终态非空正文
  if (!exTerm && inTerm) {
    return inc !== '' ? inc : existingText;
  }
  // 同级：较长者胜（对抗乱序 stream final 重复）
  if (inc.length >= ex.length) return inc;
  return existingText;
}

/**
 * 将 incoming 合并进 existing（同 id 原地更新）。
 * - 空 toolCalls/blocks 不覆盖已有非空内容，避免回显/重放抹掉本地工具块
 * - status / text 偏好终态 completed over partial stream（C0 residual）
 */
export function mergeSessionMessageFields(
  existing: SessionMessage,
  incoming: SessionMessage
): void {
  existing.id = incoming.id;
  existing.sender = incoming.sender;
  if (typeof incoming.timestamp === 'number' && Number.isFinite(incoming.timestamp)) {
    // 终态时间戳优先；partial 不回拨已有终态 ts
    const exTerm = isTerminalSessionMessageStatus(existing.status);
    const inTerm = isTerminalSessionMessageStatus(incoming.status);
    if (!(exTerm && !inTerm)) {
      existing.timestamp = incoming.timestamp;
    }
  }

  const nextStatus = preferSessionMessageStatus(existing.status, incoming.status);
  const nextText = preferSessionMessageText(
    existing.text,
    existing.status,
    incoming.text,
    incoming.status
  );
  if (nextText !== undefined) {
    existing.text = nextText;
  }

  if (incoming.thinking !== undefined) {
    const exThink = existing.thinking ?? '';
    const inThink = incoming.thinking;
    const exTerm = isTerminalSessionMessageStatus(existing.status);
    const inTerm = isTerminalSessionMessageStatus(incoming.status);
    if (exTerm && !inTerm && exThink !== '') {
      // 终态思考不被 partial 覆盖
    } else if (inThink === '' && exThink !== '') {
      // 空串不抹
    } else if (
      !exTerm &&
      !inTerm &&
      inThink.length < exThink.length
    ) {
      // partial 乱序：保留更长
    } else {
      existing.thinking = incoming.thinking;
    }
  }

  if (incoming.toolCalls !== undefined) {
    if (incoming.toolCalls.length > 0 || !existing.toolCalls?.length) {
      existing.toolCalls = incoming.toolCalls;
    }
  }

  if (nextStatus !== undefined) {
    existing.status = nextStatus;
  }

  if (incoming.precomputedHtml !== undefined) {
    // 终态预渲染 HTML 不被 partial 空/短覆盖
    const exTerm = isTerminalSessionMessageStatus(
      preferSessionMessageStatus(existing.status, incoming.status)
    );
    const inTerm = isTerminalSessionMessageStatus(incoming.status);
    if (
      !(
        exTerm &&
        !inTerm &&
        existing.precomputedHtml &&
        !incoming.precomputedHtml
      )
    ) {
      existing.precomputedHtml = incoming.precomputedHtml;
    }
  }
  if (incoming.toolCallResults !== undefined) {
    if (incoming.toolCallResults.length > 0 || !existing.toolCallResults?.length) {
      existing.toolCallResults = incoming.toolCallResults;
    }
  }
  if (incoming.blocks !== undefined) {
    if (incoming.blocks.length > 0 || !existing.blocks?.length) {
      existing.blocks = incoming.blocks;
    }
  }
  if (incoming.streamTextOffset !== undefined) {
    const exOff =
      typeof existing.streamTextOffset === 'number'
        ? existing.streamTextOffset
        : undefined;
    const inOff = incoming.streamTextOffset;
    const exTerm = isTerminalSessionMessageStatus(existing.status);
    const inTerm = isTerminalSessionMessageStatus(incoming.status);
    if (exTerm && !inTerm && exOff !== undefined && inOff < exOff) {
      // partial 不回退终态 offset
    } else {
      existing.streamTextOffset = inOff;
    }
  }
  if (incoming.thinkingTime !== undefined) {
    const exTerm = isTerminalSessionMessageStatus(existing.status);
    const inTerm = isTerminalSessionMessageStatus(incoming.status);
    if (!(exTerm && !inTerm && existing.thinkingTime != null)) {
      existing.thinkingTime = incoming.thinkingTime;
    }
  }
}

/**
 * 消息列表按 id upsert：同 id → 原地 merge；否则 append。
 * 供 addMessage / agent 消息等 immer 路径共用，防双 append。
 * @returns 'updated' | 'appended'
 */
export function upsertMessageById(
  messages: SessionMessage[],
  message: SessionMessage
): 'updated' | 'appended' {
  // D2：message.upsert 轻量计数（append 与 merge 均计 1）
  recordMessageUpsert();
  const existing = getMessageById(messages, message.id);
  if (existing) {
    mergeSessionMessageFields(existing, message);
    return 'updated';
  }
  messages.push(message);
  return 'appended';
}

export function truncateMessagesForAppend(
  messages: SessionMessage[],
  maxMessages: number,
  truncatedToolChainIdsAccRef: { truncatedToolChainIds?: string[] },
  pinnedMessageIds?: string[]
): void {
  if (messages.length < maxMessages) return;
  const first = messages[0];
  if (!first) return;

  const collectedIds: string[] = [];
  if (first.toolCalls?.length) {
    for (const tc of first.toolCalls) {
      if (tc.status === 'success' || tc.status === 'error') {
        collectedIds.push(tc.id);
      }
    }
  }
  if (collectedIds.length) {
    let acc = truncatedToolChainIdsAccRef.truncatedToolChainIds;
    if (!acc) {
      acc = [];
      truncatedToolChainIdsAccRef.truncatedToolChainIds = acc;
    }
    for (const id of collectedIds) {
      if (!acc.includes(id)) {
        acc.push(id);
      }
    }
  }

  const removedMessageIds = new Set<string>();
  removedMessageIds.add(first.id);
  if (first.toolCalls?.length && messages.length > 1) {
    const second = messages[1];
    if (second) removedMessageIds.add(second.id);
    messages.splice(0, 2);
  } else {
    messages.shift();
  }

  if (pinnedMessageIds?.length) {
    for (let i = pinnedMessageIds.length - 1; i >= 0; i--) {
      const pid = pinnedMessageIds[i];
      if (pid && removedMessageIds.has(pid)) {
        pinnedMessageIds.splice(i, 1);
      }
    }
  }
}

export function normalizeWritableSessionTitle(
  raw: string | null | undefined,
  maxLen: number = MANUAL_SESSION_TITLE_MAX_LEN
): string | null {
  const cleaned = sanitizeSessionTitleText(raw);
  if (!cleaned) return null;
  return truncateSessionTitle(cleaned, maxLen);
}

export function applyTitleIfDefault(
  sess: SessionState,
  rawTitle: string | null | undefined
): void {
  if (rawTitle == null) return;
  if (!isDefaultSessionTitle(sess.title)) return;
  const next = normalizeWritableSessionTitle(rawTitle);
  if (next) sess.title = next;
}

export function pickFallbackActiveSessionId(
  state: SessionsIndexed,
  removedId: string,
  removedIndex: number
): string {
  const sessions = state.sessions;
  const isCandidate = (s: SessionState | undefined): s is SessionState =>
    Boolean(s && s.id && s.id !== removedId);

  const scanNeighbors = (pred: (s: SessionState) => boolean): string | null => {
    for (let i = removedIndex + 1; i < sessions.length; i++) {
      const s = sessions[i];
      if (isCandidate(s) && pred(s)) return s.id;
    }
    for (let i = removedIndex - 1; i >= 0; i--) {
      const s = sessions[i];
      if (isCandidate(s) && pred(s)) return s.id;
    }
    return null;
  };

  const scanAll = (pred: (s: SessionState) => boolean): string | null => {
    for (const s of sessions) {
      if (isCandidate(s) && pred(s)) return s.id;
    }
    return null;
  };

  const solid = (s: SessionState) => !s.isArchived && !isEmptyShellSession(s);

  // 不变量：删除活动会话后绝不允许 activeSessionId 落到空字符串
  // （否则会触发"暂无会话"空屏）。无任何后备时返回草稿哨兵，
  // 让 UI 进入"我们该在 X 中处理什么？"欢迎面。
  return (
    scanNeighbors(solid) ||
    scanAll(solid) ||
    scanNeighbors((s) => !s.isArchived) ||
    scanAll((s) => !s.isArchived) ||
    scanAll(() => true) ||
    PENDING_DRAFT_SESSION_ID
  );
}

export function dropTerminalForSession(
  state: SessionStoreSlice,
  sessionId: string
): void {
  void state;
  useTerminalStore.getState().removeTerminalSession(sessionId);
}

export function pruneEmptyShellsInPlace(
  state: SessionStoreSlice,
  keepIds: Iterable<string>
): void {
  const pruned = pruneEmptyShellSessions(state.sessions, { keepIds });
  if (pruned !== state.sessions) {
    state.sessions = pruned;
    reindexSessionsById(state);
  }
  useTerminalStore
    .getState()
    .pruneTerminalSessions(Object.keys(state.sessionsById));
}

export function maybeAutoTitleSession(
  state: SessionsIndexed,
  sess: SessionState
): void {
  const existingTitles = state.sessions
    .filter((s) => s.id !== sess.id)
    .map((s) => s.title);
  const auto = maybeAutoTitleFromMessages(sess.title, sess.messages, {
    existingTitles,
    excludeTitle: sess.title,
  });
  if (auto) sess.title = auto;
}
