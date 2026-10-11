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
import type { ProjectEntry } from '../api/projectStore';
import type {
  MessageContextInjection,
  MessageToolCall,
  MessageToolCallApprovalDecision,
  MessageToolCallStatus,
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
import {
  createSessionFolderActions,
  type RebindSessionFoldersOptions,
} from './sessionFolderActions';

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
  composerDrafts: Record<string, string>;
}

/**
 * 消息级缓存指标载荷（结构类型，避免 store → chat-bridge handlers 反向依赖；
 * 与 messageHandlers 的 MessageCacheMetrics 形状对齐）。
 */
type MessageCacheMetricsLike = {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  hitRate?: number;
  writeRate?: number;
  inputTotal?: number;
};

/** 会话 / 消息 / agent 域 action 签名（与 LayoutStore 同名方法一致） */
export interface SessionActions {
  setComposerDraft: (sessionId: string, draft: string) => void;
  setActiveSessionId: (id: string) => void;
  setActiveAgentId: (id: string | null) => void;
  setPanelAgentId: (id: string | null) => void;
  /** 进入草稿态：active = 哨兵（可 per-tab），sessions 不增条目 */
  enterDraftMode: (
    folder?: string,
    opts?: { draftSessionId?: string }
  ) => void;
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
   * 写入模型生成的标题，来源标为 auto。
   * titleSource 已是 user 时不改标题、也不改来源。
   */
  applyGeneratedSessionTitle: (sessionId: string, title: string) => void;
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
  /**
   * 向目标会话写入一条可见上下文注入卡片（Prompt 注入管线）。
   * 挂载策略：写入目标会话最新可挂载（settled assistant）消息的 injections 与
   * context_injection 块；无活跃可挂载消息时创建 sender='assistant' 载体消息。
   * 空 targetSessionId 拒绝（console.warn）。
   */
  addContextInjection: (
    targetSessionId: string,
    injection: MessageContextInjection
  ) => void;
  /**
   * R1 撤回消费（统一输入流收敛战役）：timeline-truncate 投影重放——
   * 保留边界 user 节点，丢弃其后的投影节点（`> boundarySeq` 部分）。
   * 撤回的呈现标记由展示投影层（V1）决定，本 action 只做投影截断。
   */
  applyTimelineTruncate: (
    sessionId: string,
    boundarySeq: number,
    targetMessageId: string
  ) => void;
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
  /** 软驱逐已水合消息（D5）：恢复懒壳，不写库、不触发空 body save */
  evictSessionMessages: (sessionIds: readonly string[]) => void;
  updateMessageText: (
    sessionId: string,
    messageId: string,
    text: string,
    precomputedHtml?: string
  ) => void;
  updateMessageThinking: (
    sessionId: string,
    messageId: string,
    thinking: string,
    turnIndex?: number
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
  pinMessage: (sessionId: string, messageId: string, color?: string) => void;
  unpinMessage: (sessionId: string, messageId: string) => void;
  /**
   * 项目 → sessions.folder 镜像 rebind（D5 收敛点，唯一写路径）。
   * 增量：opts.changedSessionIds 提供时仅处理变更集合。
   */
  rebindSessionFolders: (
    projects: ReadonlyArray<ProjectEntry>,
    opts?: RebindSessionFoldersOptions
  ) => void;

  // ── 事件写入收敛（T-E 步骤 3：事件 handler → action，禁止 raw setState）──

  /** 引擎 runId 回填（onRunMeta 路径） */
  setEngineLastRunId: (sessionId: string, runId: string) => void;
  /**
   * agent 消息单条 patch（流式 thinking/chunk/tool 路径；patch 为 immer draft 内
   * 回调，与既有 buildPatchAsst 语义逐行等价）。
   */
  patchSessionAgentMessage: (
    sessionId: string,
    agentId: string,
    messageId: string,
    patch: (message: SessionMessage) => void
  ) => void;
  /** subagent-event → agent 时间线整体投影（applySubagentEventToMessages 纯函数复用） */
  applySubagentEventToAgent: (
    sessionId: string,
    agentId: string,
    event: Record<string, unknown>
  ) => void;
  /**
   * agent 终态 patch + 时间线 processing→completed 收口 + 父工具卡终态
   * （U3/S3 双调用方共用；status 为 wire 归一终态 completed/failed/stopped）。
   */
  patchSessionAgentToolStatus: (
    sessionId: string,
    agentId: string,
    opts: { status: string; summary?: string }
  ) => void;
  /** 全部 processing→completed、running/pending 工具卡→error「已停止」（finalizeInFlight 语义） */
  finalizeAgentMessages: (sessionId: string, agentId: string) => void;
  /** timeline 归一（normalizeAssistantTimeline；sender 非 assistant 早退） */
  updateMessageTimeline: (sessionId: string, messageId: string) => void;
  /** stop 批量工具终态（buildTerminalToolPatches 结果；批内单次 immer） */
  applyToolCallPatches: (
    sessionId: string,
    messageId: string,
    patches: Array<{
      id: string;
      status: MessageToolCallStatus;
      output?: string;
      durationMs?: number;
    }>
  ) => void;
  /**
   * 消息级缓存指标挂载（必须经 sessions[] canonical 写；messageId 兜底为
   * 末条 processing assistant；metrics null 不写）。
   */
  setMessageCacheMetrics: (
    sessionId: string,
    messageId: string,
    metrics: MessageCacheMetricsLike
  ) => void;
  /**
   * 本地工具卡置标（审批乐观更新；scope 命中时只扫 scope 内，缺省全表扫描
   * 与原语义等价；终态工具卡不回退 running）。
   */
  markToolCallLocalStatus: (
    toolCallId: string,
    status: 'running' | 'error',
    output: string,
    scope?: {
      sessionId?: string;
      agentId?: string;
      runId?: string;
    }
  ) => void;
  /** 批量审批决定写入（respondToApproval 单条语义的批量封装） */
  batchRespondToApproval: (
    decisions: Array<{
      sessionId: string;
      messageId: string;
      toolCallId: string;
      decision: MessageToolCallApprovalDecision;
    }>
  ) => void;
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
    ...createSessionFolderActions(set),
  };
}
