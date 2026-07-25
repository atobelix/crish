import {
  isDefaultSessionTitle,
  isEmptyShellSession,
  maybeAutoTitleFromMessages,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  truncateSessionTitle,
} from '../api/sessionTitle';
import type {
  MessageToolCall,
  SessionAgent,
  SessionAgentPatch,
  SessionMessage,
  SessionState,
} from './types';
import {
  getSessionById,
  reindexSessionsById,
  type SessionsIndexed,
} from './sessionIndex';
import type { SessionStoreSlice } from './sessionActions';

/** 手动 rename / 分叉标题码点上限（略宽于侧栏自动标题 28） */
export const MANUAL_SESSION_TITLE_MAX_LEN = 48;

export function getMessageById(
  messages: SessionMessage[] | undefined,
  messageId: string
): SessionMessage | undefined {
  return messages?.find((m) => m.id === messageId);
}

export function getSessionMessage(
  state: SessionsIndexed,
  sessionId: string,
  messageId: string
): { session: SessionState; message: SessionMessage } | undefined {
  const session = getSessionById(state, sessionId);
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

export function mergeSessionMessageFields(
  existing: SessionMessage,
  incoming: SessionMessage
): void {
  existing.id = incoming.id;
  existing.sender = incoming.sender;
  existing.timestamp = incoming.timestamp;
  if (incoming.text !== undefined) existing.text = incoming.text;
  if (incoming.thinking !== undefined) existing.thinking = incoming.thinking;
  if (incoming.toolCalls !== undefined) existing.toolCalls = incoming.toolCalls;
  if (incoming.status !== undefined) existing.status = incoming.status;
  if (incoming.precomputedHtml !== undefined) existing.precomputedHtml = incoming.precomputedHtml;
  if (incoming.toolCallResults !== undefined) existing.toolCallResults = incoming.toolCallResults;
  if (incoming.blocks !== undefined) existing.blocks = incoming.blocks;
  if (incoming.streamTextOffset !== undefined) existing.streamTextOffset = incoming.streamTextOffset;
  if (incoming.thinkingTime !== undefined) existing.thinkingTime = incoming.thinkingTime;
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

  return (
    scanNeighbors(solid) ||
    scanAll(solid) ||
    scanNeighbors((s) => !s.isArchived) ||
    scanAll((s) => !s.isArchived) ||
    scanAll(() => true) ||
    ''
  );
}

export function dropTerminalForSession(
  state: SessionStoreSlice,
  sessionId: string
): void {
  if (!sessionId) return;
  if (state.terminalBySession && sessionId in state.terminalBySession) {
    delete state.terminalBySession[sessionId];
  }
  if (state.activeSessionId === sessionId) {
    state.terminalLines = [];
  }
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
  if (state.terminalBySession) {
    for (const tid of Object.keys(state.terminalBySession)) {
      if (!state.sessionsById[tid]) {
        delete state.terminalBySession[tid];
      }
    }
  }
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
