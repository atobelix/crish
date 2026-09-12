/**
 * 会话与消息操作门面 (Session & Message Access Facade)
 *
 * 纯查询/校验函数已拆分到 ./sessionAccessQuery（纯结构性重构）；
 * 本文件 re-export 以保持外部 import 路径稳定，并保留依赖 getSessionStoreState() 的写入门面。
 */
import type {
  MessageToolCall,
  SessionAgent,
  SessionGoalMode,
  SessionMessage,
} from '../../store/types';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';
import { getSessionStoreState } from '../../store/sessionStore';
import { getLayoutState, resolveSessionState } from './storeAccessCore';
// 本文件门面内部用到的纯查询/校验函数从拆分文件引入；
// 其余纯查询函数仅 re-export（外部消费方 import 路径不变）。
import {
  normalizeSessionId,
  requireExistingSessionId,
} from './sessionAccessQuery';

export {
  isNonEmptySessionId,
  normalizeSessionId,
  selectSessionById,
  selectActiveSession,
  selectSessionAgent,
  resolveSession,
  resolveActiveSession,
  hasSession,
  withSession,
  withActiveSession,
  requireExistingSessionId,
} from './sessionAccessQuery';

/**
 * @deprecated Name lies — **does not create a session**. Redirects to pending draft only.
 *
 * Prefer product entry:
 * - `getCompositionRoot().shell.openNewDraftTab(folder?)` (tab + enterDraft)
 * - `getCompositionRoot().session.enterDraft(folder?)` / `enterDraftMode(folder?)`
 *
 * Implementation: `enterDraftMode` + chat surface. **No empty-shell mint.**
 * Returns draft sentinel id (`PENDING_DRAFT_SESSION_ID`) for legacy callers.
 * Real session id only via `commitDraftIfNeeded` on first send.
 *
 * @see docs/architecture/session-pending-draft-adr.md
 */
export function createSessionAndOpenChat(folder?: string): string {
  // Compat shim → draft path only (do not mint sessions[])
  resolveSessionState().enterDraftMode(folder);
  getLayoutState().setChatMainSurface('chat');
  return PENDING_DRAFT_SESSION_ID;
}

/**
 * 创建 / 附加真会话（写入 sessions[]）。
 *
 * **允许**：commitDraftIfNeeded、系统/定时占位（建议带真实 title + activate:false）、
 * 测试、显式 id attach。
 *
 * **禁止**：用户「新对话」入口直接调用本函数 mint 默认标题空壳
 * （应 `getCompositionRoot().shell.openNewDraftTab` / `session.enterDraft` / `enterDraftMode`）。
 *
 * 语义：mint 新 id | attach explicitId | activate:false 后台占位；**不 reuse 空壳**。
 */
export function createSession(opts?: {
  title?: string;
  folder?: string;
  id?: string;
  activate?: boolean;
}): string {
  return getSessionStoreState().createSession(opts);
}

export function enterDraftMode(folder?: string): void {
  getSessionStoreState().enterDraftMode(folder);
}

export function setDraftFolder(folder: string): void {
  getSessionStoreState().setDraftFolder(folder);
}

export function commitDraftIfNeeded(opts?: {
  title?: string;
  folder?: string;
}): string {
  return getSessionStoreState().commitDraftIfNeeded(opts);
}

export function setActiveSessionId(id: string): void {
  const sid = normalizeSessionId(id);
  if (!sid) return;
  getSessionStoreState().setActiveSessionId(sid);
}

export function setActiveAgentId(id: string | null): void {
  getSessionStoreState().setActiveAgentId(id);
}

export function setPanelAgentId(id: string | null): void {
  getSessionStoreState().setPanelAgentId(id);
}

export function patchSession(
  sessionId: string,
  patch: { goalMode?: SessionGoalMode | null }
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSession(sid, patch);
}

/** 清空会话消息（不删会话） */
export function clearSessionMessages(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().clearSessionMessages(sid);
}

export function branchSession(sessionId: string, newTitle: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().branchSession(sid, newTitle);
}

export function archiveSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().archiveSession(sid);
}

export function unarchiveSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().unarchiveSession(sid);
}

export function pinSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().pinSession(sid);
}

export function unpinSession(sessionId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().unpinSession(sid);
}

export function renameSession(sessionId: string, title: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().renameSession(sid, title);
}

export function addMessage(
  wsId: string,
  sessionId: string,
  message: SessionMessage
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().addMessage(wsId, sid, message);
}

export function updateMessageText(
  sessionId: string,
  messageId: string,
  text: string,
  precomputedHtml?: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageText(
    sid,
    messageId,
    text,
    precomputedHtml
  );
}

export function updateMessageThinking(
  sessionId: string,
  messageId: string,
  thinking: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageThinking(sid, messageId, thinking);
}

export function addMessageToolCall(
  sessionId: string,
  messageId: string,
  toolCall: MessageToolCall
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().addMessageToolCall(sid, messageId, toolCall);
}

export function updateMessageToolCall(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  updates: Partial<MessageToolCall>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageToolCall(
    sid,
    messageId,
    toolCallId,
    updates
  );
}

export function patchAgentTool(
  sessionId: string,
  agentId: string,
  toolCallId: string,
  patch: Partial<MessageToolCall>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchAgentTool(sid, agentId, toolCallId, patch);
}

export function withdrawMessage(
  wsId: string,
  sessionId: string,
  messageId: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().withdrawMessage(wsId, sid, messageId);
}

export function setSessionMessageStatus(
  sessionId: string,
  messageId: string,
  status: any,
  thinkingTime?: number,
  opts?: {
    force?: boolean;
    errorDetail?: { message: string; kind: string; technical?: string };
  }
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().setSessionMessageStatus(
    sid,
    messageId,
    status,
    thinkingTime,
    opts
  );
}

export function updateMessageTimeline(
  sessionId: string,
  messageId: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().updateMessageTimeline(sid, messageId);
}

export function applyToolCallPatches(
  sessionId: string,
  messageId: string,
  patches: Array<{
    id: string;
    status: any;
    output?: string;
    durationMs?: number;
  }>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().applyToolCallPatches(sid, messageId, patches);
}

export function setEngineLastRunId(sessionId: string, runId: string): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().setEngineLastRunId(sid, runId);
}

export function upsertSessionAgent(
  sessionId: string,
  agent: SessionAgent
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().upsertSessionAgent(sid, agent);
}

export function patchSessionAgent(
  sessionId: string,
  agentId: string,
  patch: any
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSessionAgent(sid, agentId, patch);
}

export function appendSessionAgentMessage(
  sessionId: string,
  agentId: string,
  message: SessionMessage
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().appendSessionAgentMessage(sid, agentId, message);
}

export function patchSessionAgentMessage(
  sessionId: string,
  agentId: string,
  messageId: string,
  patch: (message: SessionMessage) => void
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSessionAgentMessage(
    sid,
    agentId,
    messageId,
    patch
  );
}

export function finalizeAgentMessages(
  sessionId: string,
  agentId: string
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().finalizeAgentMessages(sid, agentId);
}

export function applySubagentEventToAgent(
  sessionId: string,
  agentId: string,
  event: Record<string, unknown>
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().applySubagentEventToAgent(sid, agentId, event);
}

export function patchSessionAgentToolStatus(
  sessionId: string,
  agentId: string,
  opts: { status: string; summary?: string }
): void {
  const sid = requireExistingSessionId(sessionId);
  if (!sid) return;
  getSessionStoreState().patchSessionAgentToolStatus(sid, agentId, opts);
}
