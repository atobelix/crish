import type { SessionsIndexed } from '../sessionIndex';
import type { SessionAgent, SessionGoalMode, SessionMessage, SessionMessageStatus, MessageToolCall, SessionState, StreamingMessageRenderState } from '../types';

export interface SessionStoreSlice extends SessionsIndexed {
  folderOrder: string[];
  activeSessionId: string;
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  terminalLines: string[];
  terminalBySession: Record<string, string[]>;
  composerDrafts: Record<string, string>;
  streamingRenderStates?: Record<string, StreamingMessageRenderState>;
  truncatedToolChainIds?: string[];
}

export interface SessionActions {
  setComposerDraft: (sessionId: string, draft: string) => void;
  setActiveSessionId: (id: string) => void;
  setActiveAgentId: (id: string | null) => void;
  setPanelAgentId: (id: string | null) => void;
  enterDraftMode: (folder?: string) => void;
  setDraftFolder: (folder: string) => void;
  clearDraft: () => void;
  commitDraftIfNeeded: (opts?: { title?: string; folder?: string }) => string;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  patchSessionAgent: (sessionId: string, agentId: string, patch: Partial<SessionAgent>) => void;
  appendSessionAgentMessage: (sessionId: string, agentId: string, message: SessionMessage) => void;
  renameSession: (sessionId: string, title: string) => void;
  createSession: (opts?: { title?: string; folder?: string; id?: string; activate?: boolean }) => string;
  deleteSession: (sessionId: string) => boolean;
  pinSession: (sessionId: string) => void;
  unpinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  branchSession: (sessionId: string, newTitle: string) => void;
  moveSessionRealtime: (sessionId: string, targetSessionId: string | null, targetFolder: string, isPinned: boolean) => void;
  moveFolderRealtime: (folderName: string, targetFolderName: string | null) => void;
  pinFolderSessions: (folderName: string) => void;
  unpinFolderSessions: (folderName: string) => void;
  addMessage: (wsId: string, sessionId: string, message: SessionMessage) => void;
  withdrawMessage: (wsId: string, sessionId: string, messageId: string) => void;
  respondToApproval: (wsId: string, sessionId: string, messageId: string, toolCallId: string, status: 'success' | 'error') => void;
  setSessions: (sessions: SessionState[]) => void;
  patchSession: (sessionId: string, patch: { goalMode?: SessionGoalMode | null }) => void;
  updateMessageText: (sessionId: string, messageId: string, text: string) => void;
  updateMessageThinking: (sessionId: string, messageId: string, thinking: string) => void;
  addMessageToolCall: (sessionId: string, messageId: string, toolCall: MessageToolCall) => void;
  updateMessageToolCall: (sessionId: string, messageId: string, toolCallId: string, updates: Partial<MessageToolCall>) => void;
  setSessionMessageStatus: (sessionId: string, messageId: string, status: SessionMessageStatus, thinkingTime?: number, opts?: { force?: boolean }) => void;
  patchAgentTool: (sessionId: string, agentId: string, toolCallId: string, patch: Partial<MessageToolCall>) => void;
  pinMessage: (sessionId: string, messageId: string) => void;
  unpinMessage: (sessionId: string, messageId: string) => void;
}

export type SessionImmerSet<T extends SessionStoreSlice = SessionStoreSlice> = (recipe: (state: T) => void) => void;
export type SessionStoreGet<T extends SessionStoreSlice = SessionStoreSlice> = () => T;
