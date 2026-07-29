/**
 * 会话 / 消息 / agent 相关 action 工厂与 Store 切片契约。
 *
 * **唯一入口**：本文件 + 下方同级 `session*Actions.ts`。
 * `session-actions/` 目录树已于 W4-2 删除；禁止再引入平行 barrel/死路径。
 *
 * 内部逻辑拆分：
 * - sessionCrudActions.ts (CRUD/草稿/状态)
 * - sessionOrderingActions.ts (排序/分支/归档/固定/拖拽)
 * - sessionMessageActions.ts (消息/工具调用/状态)
 * - sessionAgentActions.ts (Agent/子代理更新)
 * - sessionSharedHelpers.ts (共享纯函数与辅助逻辑)
 */

import type { SessionsIndexed } from './sessionIndex';
import type {
  MessageToolCall,
  MessageToolCallApprovalDecision,
  SessionAgent,
  SessionAgentPatch,
  SessionGoalMode,
  SessionImportMeta,
  SessionMessage,
  SessionMessageStatus,
  SessionState,
} from './types';
import { createSessionCrudActions } from './sessionCrudActions';
import { createSessionOrderingActions } from './sessionOrderingActions';
import { createSessionMessageActions } from './sessionMessageActions';
import { createSessionAgentActions } from './sessionAgentActions';

/**
 * 会话域 action 需要读写的 store 切片（避免与 layoutStore 循环 import）。
 * 字段名/形状须与 LayoutStore 对齐；LayoutStore 必须 extends 本切片。
 */
export interface SessionStoreSlice extends SessionsIndexed {
  folderOrder: string[];
  activeSessionId: string;
  /** 草稿态绑定的 folder；commit 时写入真会话。非草稿时为 '' */
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  terminalLines: string[];
  terminalBySession: Record<string, string[]>;
  composerDrafts: Record<string, string>;
}

/** 会话 / 消息 / agent 域 action 签名（与 LayoutStore 同名方法一致） */
export interface SessionActions {
  setComposerDraft: (sessionId: string, draft: string) => void;
  setActiveSessionId: (id: string) => void;
  setActiveAgentId: (id: string | null) => void;
  setPanelAgentId: (id: string | null) => void;
  /** 进入草稿态：active = 哨兵，sessions 不增条目 */
  enterDraftMode: (folder?: string) => void;
  /** 更新草稿绑定 folder（项目切换时） */
  setDraftFolder: (folder: string) => void;
  /** 退出草稿：清空 draftFolder；若 active 为草稿则清空 active */
  clearDraft: () => void;
  /**
   * 草稿 / 脏 active → mint 真会话并返回 id；
   * 已有真实 active → 原样返回该 id。
   * 契约：始终返回可用 session id（不再依赖调用方 createSession 兜底）。
   */
  commitDraftIfNeeded: (opts?: { title?: string; folder?: string }) => string;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  patchSessionAgent: (
    sessionId: string,
    agentId: string,
    patch: SessionAgentPatch
  ) => void;
  appendSessionAgentMessage: (
    sessionId: string,
    agentId: string,
    message: SessionMessage
  ) => void;
  renameSession: (sessionId: string, title: string) => void;
  /**
   * 创建/附加真会话。系统·测试·commit 用；**禁止**用户「新建」直调 mint 空壳
   * （用户入口 → enterDraftMode / openNewDraftTab）。
   */
  createSession: (opts?: {
    title?: string;
    folder?: string;
    id?: string;
    activate?: boolean;
    /** 外部导入溯源（软去重 key） */
    importMeta?: SessionImportMeta;
  }) => string;
  deleteSession: (sessionId: string) => boolean;
  pinSession: (sessionId: string) => void;
  unpinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  branchSession: (sessionId: string, newTitle: string) => void;
  moveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  moveFolderRealtime: (
    folderName: string,
    targetFolderName: string | null
  ) => void;
  pinFolderSessions: (folderName: string) => void;
  unpinFolderSessions: (folderName: string) => void;
  addMessage: (
    wsId: string,
    sessionId: string,
    message: SessionMessage
  ) => void;
  withdrawMessage: (wsId: string, sessionId: string, messageId: string) => void;
  respondToApproval: (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    decision: MessageToolCallApprovalDecision
  ) => void;
  setSessions: (sessions: SessionState[]) => void;
  patchSession: (
    sessionId: string,
    patch: {
      goalMode?: SessionGoalMode | null;
    }
  ) => void;
  /** 清空会话消息（不删会话） */
  clearSessionMessages: (sessionId: string) => void;
  updateMessageText: (
    sessionId: string,
    messageId: string,
    text: string,
    precomputedHtml?: string
  ) => void;
  updateMessageThinking: (
    sessionId: string,
    messageId: string,
    thinking: string
  ) => void;
  addMessageToolCall: (
    sessionId: string,
    messageId: string,
    toolCall: MessageToolCall
  ) => void;
  updateMessageToolCall: (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    updates: Partial<MessageToolCall>
  ) => void;
  setSessionMessageStatus: (
    sessionId: string,
    messageId: string,
    status: SessionMessageStatus,
    thinkingTime?: number,
    opts?: {
      force?: boolean;
      errorDetail?: { message: string; kind: string; technical?: string };
    }
  ) => void;
  patchAgentTool: (
    sessionId: string,
    agentId: string,
    toolCallId: string,
    patch: Partial<MessageToolCall>
  ) => void;
  pinMessage: (sessionId: string, messageId: string) => void;
  unpinMessage: (sessionId: string, messageId: string) => void;
}

/**
 * immer set / get：用泛型 T extends SessionStoreSlice，
 * 使 layoutStore 的 set/get（T = 完整 LayoutStore draft）无需 as any 即可传入。
 */
export type SessionImmerSet<T extends SessionStoreSlice = SessionStoreSlice> = (
  recipe: (state: T) => void
) => void;
export type SessionStoreGet<T extends SessionStoreSlice = SessionStoreSlice> =
  () => T;

/**
 * 创建会话域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 * @typeParam T 完整 store 状态（须包含 SessionStoreSlice 字段）
 */
export function createSessionActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>,
  get: SessionStoreGet<T>
): SessionActions {
  return {
    ...createSessionCrudActions(set, get),
    ...createSessionOrderingActions(set),
    ...createSessionMessageActions(set),
    ...createSessionAgentActions(set),
  };
}
