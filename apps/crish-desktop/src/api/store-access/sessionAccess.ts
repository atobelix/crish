/**
 * 会话与消息操作门面 (Session & Message Access Facade)
 */
import type {
  MessageToolCall,
  SessionAgent,
  SessionGoalMode,
  SessionMessage,
  SessionState,
} from '../../store/types';
import { PENDING_DRAFT_SESSION_ID } from '../../store/draftSession';
import {
  getActiveSessionId as getActiveSessionIdFromFacade,
  getSessionById,
  getSessionStoreState,
} from '../../store/sessionStore';
import { resolveSessionState, resolveWorkspaceState } from './storeAccessCore';

export function isNonEmptySessionId(
  sessionId: string | null | undefined
): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0;
}

export function normalizeSessionId(
  sessionId: string | null | undefined
): string | undefined {
  if (typeof sessionId !== 'string') return undefined;
  const id = sessionId.trim();
  return id.length > 0 ? id : undefined;
}

export function selectSessionById(
  sessions: readonly SessionState[],
  sessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (sessionsById) {
    const hit = sessionsById[id];
    if (hit) return hit;
  }
  return sessions.find((s) => s.id === id);
}

export function selectActiveSession(
  sessions: readonly SessionState[],
  activeSessionId: string | null | undefined,
  sessionsById?: Readonly<Record<string, SessionState>>
): SessionState | undefined {
  return selectSessionById(sessions, activeSessionId, sessionsById);
}

export function selectSessionAgent(
  session: SessionState | null | undefined,
  agentId: string | null | undefined
): SessionAgent | undefined {
  if (!session?.agents?.length) return undefined;
  const id = normalizeSessionId(agentId);
  if (!id) return undefined;
  return session.agents.find((a) => a.id === id);
}

export function resolveSession(
  sessionId: string | null | undefined
): SessionState | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  return getSessionById(id);
}

export function resolveActiveSession(): SessionState | undefined {
  const id = getActiveSessionIdFromFacade();
  return resolveSession(id);
}

export function hasSession(sessionId: string | null | undefined): boolean {
  return resolveSession(sessionId) !== undefined;
}

export function withSession<T>(
  sessionId: string | null | undefined,
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveSession(sessionId);
  if (!session) return undefined;
  return fn(session);
}

export function withActiveSession<T>(
  fn: (session: SessionState) => T
): T | undefined {
  const session = resolveActiveSession();
  if (!session) return undefined;
  return fn(session);
}

function requireExistingSessionId(
  sessionId: string | null | undefined
): string | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  if (!getSessionById(id)) return undefined;
  return id;
}

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
  resolveWorkspaceState().setChatMainSurface('chat');
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
