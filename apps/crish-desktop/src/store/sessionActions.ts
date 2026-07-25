/**
 * 会话 / 消息 / agent 相关 action 实现。
 * 仍挂在同一 useLayoutStore（Phase 1）；对外请用 sessionStore.ts 的 useSessionStore 门面。
 *
 * 治理防线索引（本文件落地）：
 *   #1  类型逃逸：禁止 as any / as unknown as；用白名单类型 + 逐字段赋值
 *   #6  数据水合：timestamp 始终 ISO 串，来源由 timestampSource discriminator 标记
 *   #7  死代码：移除未使用参数（如旧 respondToApproval 的 wsId）
 *   #13 事务性：截断 + truncatedToolChainIds 累加 + pinnedMessageIds 清理同事务
 *   #15 immutability：所有 mutate 在 immer recipe 内；纯函数返回新值
 *   #32 store/view 职责：action 不写人类可读文案，由 view 层根据状态字段渲染
 *   #33 DRY：toolCall patch / 消息截断逻辑主会话与子 agent 共用纯函数
 *   #34 派生标记一致：截断时同步清理 pinnedMessageIds 中已删消息 id
 *   #35 枚举语义单一：approvalDecision 与 status 解耦
 *   #37 魔数治理：所有阈值命名常量集中
 *   #39 热路径：maybeAutoTitleSession 保留 O(n) 但仅在首条用户消息触发
 */

import {
  MAX_MESSAGES_PER_SESSION,
  MAX_MESSAGES_PER_AGENT,
  MAX_FOLDERS,
} from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  isDefaultSessionTitle,
  isEmptyShellSession,
  maybeAutoTitleFromMessages,
  prepareSessionsForUi,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  shellPruneKeepIds,
  truncateSessionTitle,
} from '../api/sessionTitle';
import { nowIsoTimestamp } from '../api/sessionTime';
import type {
  MessageToolCall,
  MessageToolCallApprovalDecision,
  SessionAgent,
  SessionAgentPatch,
  SessionGoalMode,
  SessionMessage,
  SessionMessageStatus,
  SessionState,
} from './types';
import {
  deleteSessionFromIndexed,
  getSessionById,
  getSessionIndex,
  reindexSessionsById,
  type SessionsIndexed,
} from './sessionIndex';
import { validateStatusTransition } from '../utils/StatusTransitionGuard';
import {
  clearMessageSnapshots,
  saveMessageSnapshot,
} from './messageSnapshotsBridge';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';
import { PENDING_DRAFT_SESSION_ID, isPendingDraft } from './draftSession';

/** 手动 rename / 分叉标题码点上限（略宽于侧栏自动标题 28） */
const MANUAL_SESSION_TITLE_MAX_LEN = 48;

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
   * 若 active 为草稿则 mint 真会话并返回 id；
   * 否则返回当前真实 active 或 ''。
   */
  commitDraftIfNeeded: (opts?: { title?: string; folder?: string }) => string;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  /**
   * 按 {@link SessionAgentPatch} 白名单 patch agent 字段。
   * 治理防线 #1：禁止任意 key 写入，编译期杜绝越权字段。
   */
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
   * mint | attach explicitId | activate:false 系统占位。
   * **禁止** reuse empty shell（见 session-pending-draft-adr）。
   * @param opts.activate 默认 true。定时任务占位会话传 false，避免抢走当前对话焦点。
   */
  createSession: (opts?: {
    title?: string;
    folder?: string;
    id?: string;
    activate?: boolean;
  }) => string;
  /**
   * 删除会话（数组 + 索引）。活动中则切到邻近非归档会话；顺带清终端缓冲与幽灵空壳。
   * @returns 是否删除了条目
   */
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
   * 用户响应审批请求。
   *
   * 治理防线 #7（死代码）：移除未使用的 wsId 参数（旧签名残留）。
   * 治理防线 #32（store/view 职责）：store 不写「已批准，正在执行…」等人类可读文案，
   *   仅更新 approvalDecision 字段；view 层根据 decision 渲染本地化文案。
   * 治理防线 #35（枚举语义单一）：decision 与 status 解耦——
   *   'rejected' 不再被强转为 status='error'，避免与「工具执行失败」混淆。
   *   status 仍保留为 'pending_approval'，由调用方（daemonChatBridge）根据 decision
   *   决定后续流转（重试 / 终止），最终由 tool-end 事件回写真实 status。
   */
  respondToApproval: (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    decision: MessageToolCallApprovalDecision
  ) => void;
  setSessions: (sessions: SessionState[]) => void;
  /**
   * 补丁会话级字段。goalMode 传 null 表示清除目标模式。
   */
  patchSession: (
    sessionId: string,
    patch: {
      goalMode?: SessionGoalMode | null;
    }
  ) => void;
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
    opts?: { force?: boolean }
  ) => void;
  patchAgentTool: (
    sessionId: string,
    agentId: string,
    toolCallId: string,
    patch: Partial<MessageToolCall>
  ) => void;
  /** 固定消息（会话级 id 列表） */
  pinMessage: (sessionId: string, messageId: string) => void;
  /** 取消固定消息 */
  unpinMessage: (sessionId: string, messageId: string) => void;
}

/**
 * immer set / get：用泛型 T extends SessionStoreSlice，
 * 使 layoutStore 的 set/get（T = 完整 LayoutStore draft）无需 `as any` 即可传入。
 */
export type SessionImmerSet<T extends SessionStoreSlice = SessionStoreSlice> = (
  recipe: (state: T) => void
) => void;
export type SessionStoreGet<T extends SessionStoreSlice = SessionStoreSlice> =
  () => T;

function getMessageById(
  messages: SessionMessage[] | undefined,
  messageId: string
): SessionMessage | undefined {
  return messages?.find((m) => m.id === messageId);
}

function getSessionMessage(
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

function getSessionAgent(
  session: SessionState,
  agentId: string
): SessionAgent | undefined {
  return session.agents?.find((a) => a.id === agentId);
}

// ── 治理防线 #1 / #33：纯函数替代 Object.assign / as unknown as ─────────────
//
// 以下 6 个纯函数集中处理 toolCall / agent / message 的字段更新，
// 主会话与子 agent 路径共用，避免分散实现导致行为漂移。
// 全部逐字段显式赋值，无任何类型断言绕过编译期校验。

/**
 * 工具调用增量相对当前字段是否有实质变化（浅比较；diffs 比引用）。
 *
 * 仅判断 updates 中显式提供的字段（undefined 不算「变化意图」）。
 */
function toolCallPatchHasChanges(
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

/**
 * 清洗 toolCall 更新：终态后忽略 status 回退为 'running'。
 *
 * 治理防线 #33：updateMessageToolCall / patchAgentTool 共用此函数，
 * 消除旧实现中 `delete rest.status` 不改变 rest 类型的语义漂移。
 *
 * 类型推导：用解构 `const { status: _status, ...rest } = updates` 让 rest
 * 自动成为 `Omit<Partial<MessageToolCall>, 'status'>`，编译期保证 status 已被剔除。
 *
 * @returns sanitize 后的 updates（可能不包含 status 字段）
 */
function sanitizeToolCallUpdates(
  tc: MessageToolCall,
  updates: Partial<MessageToolCall>,
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

/**
 * 按 updates 逐字段显式 patch 一个 toolCall。
 *
 * 治理防线 #1（类型逃逸）：完全消除 `Object.assign(tc, updates)` 与
 * `as unknown as Record<keyof MessageToolCall, unknown>` 双重断言。
 * 仅赋值 updates 中显式提供的字段（undefined 跳过，保留旧值）。
 *
 * @param target   被 mutate 的 toolCall（immer draft 内）
 * @param updates  已经过 sanitizeToolCallUpdates 处理的 updates
 */
function applyMessageToolCallPatch(
  target: MessageToolCall,
  updates: Partial<MessageToolCall>,
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

/**
 * 按 SessionAgentPatch 白名单逐字段显式 patch 一个 agent。
 *
 * 治理防线 #1（类型逃逸）：完全消除 `Object.assign(ag, patch)` 与
 * `as unknown as Record<string, unknown>` 双重断言。
 * SessionAgentPatch 类型本身已编译期约束可 patch 字段集合。
 *
 * @param target  被 mutate 的 agent（immer draft 内）
 * @param patch   白名单 patch（仅含可写字段）
 */
function applySessionAgentPatch(
  target: SessionAgent,
  patch: SessionAgentPatch,
): void {
  if (patch.status !== undefined) target.status = patch.status;
  if (patch.summary !== undefined) target.summary = patch.summary;
  if (patch.endedAt !== undefined) target.endedAt = patch.endedAt;
  if (patch.description !== undefined) target.description = patch.description;
  if (patch.depth !== undefined) target.depth = patch.depth;
  if (patch.subagentPath !== undefined) target.subagentPath = patch.subagentPath;
  // subagentRunId：daemon onRunMeta 异步回填；详见 SessionAgentPatch 字段注释
  if (patch.subagentRunId !== undefined) target.subagentRunId = patch.subagentRunId;
}

/**
 * 浅克隆消息数组（用于分叉会话时深拷贝 messages）。
 *
 * 治理防线 #15（immutability 反模式）：替换旧实现中
 * `JSON.parse(JSON.stringify(...))` 序列化方案——
 *   - 性能：大消息体序列化开销大；
 *   - 类型安全：丢失 Date / Map / Set 等非 JSON 原生类型；
 *   - immer 兼容：在 recipe 内做 JSON 序列化违反结构性共享约定
 *
 * 使用 structuredClone：现代浏览器（Chrome 98+ / FF 94+）与 Node 17+ 原生支持，
 * 保留任意可结构化克隆的类型；如环境不支持则回落到 JSON 序列化。
 *
 * @param messages 待克隆的消息数组
 * @returns 新数组（与原数组无引用共享）
 */
function cloneMessages(messages: SessionMessage[]): SessionMessage[] {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(messages);
    }
  } catch {
    /* fallback when Immer proxy or non-cloneable objects are present */
  }
  return JSON.parse(JSON.stringify(messages)) as SessionMessage[];
}

/**
 * 合并消息字段（子 agent upsert / append 路径共用）。
 *
 * 治理防线 #33（DRY）：替代旧实现 `Object.assign(existing, message)`——
 *   - Object.assign 会覆盖 existing 中所有 message 显式提供的字段，
 *     包括 undefined（若 message 含 undefined 字段，会清掉 existing 中的旧值）
 *   - 显式逐字段判断 `!== undefined`，仅当 message 提供有效值时覆盖
 *
 * @param existing  被 mutate 的现有消息（immer draft 内）
 * @param incoming  新到的消息（提供覆盖字段）
 */
function mergeSessionMessageFields(
  existing: SessionMessage,
  incoming: SessionMessage,
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

/**
 * 截断消息数组以容纳新消息，并同步收集被截断的 toolCall id。
 *
 * 治理防线 #13（事务性）& #34（派生标记一致）& #33（DRY）：
 *   - 主会话与子 agent 共用此函数，消除旧实现中两份不一致的截断逻辑
 *   - 截断以「调用 + 结果」配对为单位：first 若有 toolCalls，连 second 一起删
 *     （second 必然是该 toolCall 的结果消息或下一条用户消息，都应一并清理）
 *   - 被删 toolCalls 的 id 累加到 truncatedToolChainIds（不重复）
 *   - 同步清理 pinnedMessageIds 中被删消息的 id（避免孤儿 pinned 引用）
 *
 * 直接 mutate 入参的 messages / truncatedToolChainIdsAcc / pinnedMessageIds。
 * 调用方需在 immer recipe 内调用。
 *
 * @param messages                   被 mutate 的消息数组
 * @param maxMessages                消息数上限（达到即截断）
 * @param truncatedToolChainIdsAccRef  持有 truncatedToolChainIds 的容器；
 *   函数内若收集到 id 但容器值为 undefined，会 lazy-init 为新数组；
 *   因 immer draft 中属性写入会自动 propagate，调用方传入 `sess` 容器即可让
 *   新数组被持久化回 `sess.truncatedToolChainIds`。
 * @param pinnedMessageIds           可选 pinned 列表（同步清理孤儿引用）
 */
function truncateMessagesForAppend(
  messages: SessionMessage[],
  maxMessages: number,
  truncatedToolChainIdsAccRef: { truncatedToolChainIds?: string[] },
  pinnedMessageIds?: string[],
): void {
  if (messages.length < maxMessages) return;
  const first = messages[0];
  if (!first) return;

  // 收集 first 上终态 toolCall 的 id（这些 id 对应的「调用」即将被删除）
  const collectedIds: string[] = [];
  if (first.toolCalls?.length) {
    for (const tc of first.toolCalls) {
      if (tc.status === 'success' || tc.status === 'error') {
        collectedIds.push(tc.id);
      }
    }
  }
  // 累加到会话级 truncatedToolChainIds（lazy-init + 去重）
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

  // 收集即将被删除的消息 id（用于清理 pinnedMessageIds）
  const removedMessageIds = new Set<string>();
  removedMessageIds.add(first.id);
  // first 有 toolCalls → second 必为配对结果或下一条用户消息，一并删除
  if (first.toolCalls?.length && messages.length > 1) {
    const second = messages[1];
    if (second) removedMessageIds.add(second.id);
    messages.splice(0, 2);
  } else {
    messages.shift();
  }

  // 同步清理 pinnedMessageIds 中已删消息的 id（避免孤儿引用）
  if (pinnedMessageIds?.length) {
    for (let i = pinnedMessageIds.length - 1; i >= 0; i--) {
      const pid = pinnedMessageIds[i];
      if (pid && removedMessageIds.has(pid)) {
        pinnedMessageIds.splice(i, 1);
      }
    }
  }
}

/**
 * 清洗并按码点截断用户/程序写入的标题（CJK / emoji UTF-8 安全）。
 * 空输入 → null（调用方决定回落默认或保留旧值）。
 */
function normalizeWritableSessionTitle(
  raw: string | null | undefined,
  maxLen: number = MANUAL_SESSION_TITLE_MAX_LEN
): string | null {
  const cleaned = sanitizeSessionTitleText(raw);
  if (!cleaned) return null;
  return truncateSessionTitle(cleaned, maxLen);
}

/** 仅当现标题仍是默认占位时写入清洗后的新标题 */
function applyTitleIfDefault(
  sess: SessionState,
  rawTitle: string | null | undefined
): void {
  if (rawTitle == null) return;
  if (!isDefaultSessionTitle(sess.title)) return;
  const next = normalizeWritableSessionTitle(rawTitle);
  if (next) sess.title = next;
}

/**
 * 删除/归档后的活动回落：
 * 1) 邻近非归档且非空壳
 * 2) 任意非归档非空壳
 * 3) 邻近非归档（含空壳，避免无焦点）
 * 4) 任意其它会话（含归档）
 */
function pickFallbackActiveSessionId(
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

  // 优先有内容的邻近会话，避免把 active 落到即将被 prune 的幽灵壳
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

/** 清掉会话终端缓冲；若当前视图挂在该会话则同步清空 terminalLines */
function dropTerminalForSession(
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

/**
 * GC 空壳（非 reuse）：剪掉 keepIds 外的幽灵空壳，引用变化时 reindex。
 * 顺带 GC 已消失会话的 terminal 缓冲。禁止当作「复用空壳」入口。
 */
function pruneEmptyShellsInPlace(
  state: SessionStoreSlice,
  keepIds: Iterable<string>
): void {
  const pruned = pruneEmptyShellSessions(state.sessions, { keepIds });
  if (pruned !== state.sessions) {
    state.sessions = pruned;
    reindexSessionsById(state);
  }
  // 与 setSessions 同源：列表已无的会话勿泄漏 terminalBySession
  if (state.terminalBySession) {
    for (const tid of Object.keys(state.terminalBySession)) {
      if (!state.sessionsById[tid]) {
        delete state.terminalBySession[tid];
      }
    }
  }
}

/** 若标题仍默认且消息可推导，写中文安全短标题（可选碰撞后缀） */
function maybeAutoTitleSession(
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

/**
 * 创建会话域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 * @typeParam T 完整 store 状态（须包含 SessionStoreSlice 字段）
 */
export function createSessionActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>,
  get: SessionStoreGet<T>
): SessionActions {
  const actions: SessionActions = {
    setComposerDraft: (sessionId, draft) =>
      set((state) => {
        if (!sessionId) return;
        if (!state.composerDrafts) state.composerDrafts = {};
        if (state.composerDrafts[sessionId] === draft) return;
        if (!draft) {
          delete state.composerDrafts[sessionId];
        } else {
          state.composerDrafts[sessionId] = draft;
        }
      }),

    addMessage: (_wsId, sessionId, message) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!sess.messages) sess.messages = [];

        // 注意：正式审批由 daemonChatBridge 处理；此处不再伪造「自动授权成功」输出
        const newMsg = {
          ...message,
          blocks: message.blocks || [],
        };
        if (newMsg.blocks.length === 0) {
          if (newMsg.text) {
            newMsg.blocks.push({ type: 'text' as const, content: newMsg.text });
          }
          if (newMsg.toolCalls) {
            newMsg.toolCalls.forEach((tc) => {
              newMsg.blocks.push({ type: 'tool_call' as const, id: tc.id });
            });
          }
        }

        // 截断旧消息以容纳新消息（配对删 + truncatedToolChainIds 累加 + pinned 清理同事务）
        // 治理防线 #13 / #34：派生标记与主数据原子变更
        truncateMessagesForAppend(
          sess.messages,
          MAX_MESSAGES_PER_SESSION,
          sess,
          sess.pinnedMessageIds,
        );
        sess.messages.push(newMsg);
        // 活动触达写 ISO，侧栏相对时间可老化；勿写「刚刚」字面量
        // 治理防线 #6：timestamp 始终 ISO；本机活动 → timestampSource='local'
        const ts =
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp)
            ? new Date(message.timestamp).toISOString()
            : nowIsoTimestamp();
        sess.timestamp = ts;
        // 本机活动触达：来源标记为 local（覆盖可能的 'remote' 标记）
        if (sess.timestampSource !== 'local') {
          sess.timestampSource = 'local';
        }
        // 首条用户消息：默认标题 → 中文安全短标题（用户手改不覆盖）
        if (message.sender === 'user') {
          maybeAutoTitleSession(state, sess);
        }
      }),

    withdrawMessage: (_wsId, sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (sess?.messages) {
          const idx = sess.messages.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const prevMessages = sess.messages.slice();
            const prevPinned = sess.pinnedMessageIds
              ? sess.pinnedMessageIds.slice()
              : undefined;
            sess.messages = sess.messages.slice(0, idx);
            // 截断后清理已不存在的固定 id
            if (sess.pinnedMessageIds?.length) {
              const keep = new Set(sess.messages.map((m) => m.id));
              sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) =>
                keep.has(id)
              );
              if (sess.pinnedMessageIds.length === 0)
                delete sess.pinnedMessageIds;
            }
            // afterMessages 传入操作后列表，保证同步最小 reverse delta（immer set 内 getState 仍是旧快照）
            saveMessageSnapshot(
              sessionId,
              {
                sessionId,
                operation: 'withdraw',
                messages: prevMessages,
                ...(prevPinned !== undefined ? { pinnedMessageIds: prevPinned } : {}),
                diffFilePaths: [],
                timestamp: Date.now(),
                description: '撤回消息',
              },
              { afterMessages: sess.messages }
            );
          }
        }
      }),

    respondToApproval: (sessionId, messageId, toolCallId, decision) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        const tc = hit.message.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        // 治理防线 #32（store/view 职责）：store 只更新 approvalDecision；
        // view 层根据 decision 渲染本地化文案（「已批准，正在执行…」/「权限被拒绝」）。
        // 治理防线 #35（枚举语义单一）：不将 'rejected' 强转为 status='error'，
        //   避免与「工具执行失败」混淆；status 仍保留 'pending_approval'，
        //   由调用方（daemonChatBridge）根据 decision 决定后续流转。
        // 仅当 decision 与已记录值不同时才写 draft，避免无变化触发 immer 通知
        if (tc.approvalDecision !== decision) {
          tc.approvalDecision = decision;
        }
      }),

    setSessions: (sessions) =>
      set((state) => {
        // 与 hydrate/diskMirror 同源：fillDefault + GC 空壳（非 reuse）
        // keep 仅真实 active；pending draft / null → 剪掉全部默认空壳
        // 定时真实标题不剪；不 invent 远程空壳
        state.sessions = prepareSessionsForUi(
          sessions,
          state.activeSessionId || null
        );
        reindexSessionsById(state);
        // 合并远程会话后补齐侧栏分组顺序
        for (const s of state.sessions) {
          if (
            s.folder &&
            !state.folderOrder.includes(s.folder) &&
            state.folderOrder.length < MAX_FOLDERS
          ) {
            state.folderOrder.push(s.folder);
          }
        }
        // 活动会话若已被移除则清空（回到空态）并清 agent / 终端视图
        if (
          state.activeSessionId &&
          !state.sessionsById[state.activeSessionId]
        ) {
          state.activeSessionId = '';
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
        }
        // 已从列表消失的会话：清 terminal 缓冲，避免泄漏
        if (state.terminalBySession) {
          for (const tid of Object.keys(state.terminalBySession)) {
            if (!state.sessionsById[tid]) {
              delete state.terminalBySession[tid];
            }
          }
        }
      }),

    updateMessageText: (sessionId, messageId, text, precomputedHtml) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        const htmlChanged =
          precomputedHtml !== undefined &&
          msg.precomputedHtml !== precomputedHtml;
        if (htmlChanged) {
          msg.precomputedHtml = precomputedHtml;
        }
        // 与旧 text 和 html 全等：不碰 draft，避免流式重复帧触发 immer 通知
        if (msg.text === text && !htmlChanged) return;
        const prev = msg.text || '';
        msg.text = text;
        if (!msg.blocks) msg.blocks = [];
        let offset =
          typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
        // 全文缩短/重写：重置偏移，避免 segment 变成整篇导致正文重复
        if (
          text.length < offset ||
          (prev &&
            text.length < prev.length &&
            !prev.startsWith(text) &&
            !text.startsWith(prev.slice(0, Math.min(prev.length, text.length))))
        ) {
          offset = 0;
          msg.streamTextOffset = 0;
          // 清掉仅 text 块后按新全文重建末段；保留 tool 块
          msg.blocks = msg.blocks.filter((b) => b.type === 'tool_call');
        }
        const segment = text.length >= offset ? text.slice(offset) : text;
        const lastBlock = msg.blocks[msg.blocks.length - 1];
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content = segment;
        } else if (segment.length > 0) {
          msg.blocks.push({ type: 'text' as const, content: segment });
        }
      }),

    updateMessageThinking: (sessionId, messageId, thinking) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        // 与旧 thinking 全等：不修改 draft
        if (hit.message.thinking === thinking) return;
        // 支持累计全文或引擎推送的完整思考
        hit.message.thinking = thinking;
      }),

    addMessageToolCall: (sessionId, messageId, toolCall) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) msg.toolCalls = [];
        if (!msg.blocks) msg.blocks = [];

        const mergeInto = (target: MessageToolCall) => {
          if (
            (target.status === 'success' || target.status === 'error') &&
            toolCall.status === 'running'
          ) {
            if (!target.arguments && toolCall.arguments)
              target.arguments = toolCall.arguments;
            if (!target.explanation && toolCall.explanation)
              target.explanation = toolCall.explanation;
            return;
          }
          const prevStatus = target.status;
          const prevOut = target.output;
          const prevArgs = target.arguments;
          Object.assign(target, toolCall);
          if (!toolCall.arguments && prevArgs) target.arguments = prevArgs;
          if (!toolCall.output && prevOut) target.output = prevOut;
          if (
            (prevStatus === 'success' || prevStatus === 'error') &&
            toolCall.status === 'running'
          ) {
            target.status = prevStatus;
          }
        };

        // 仅按 id 合并；同签名不同 id 视为两次真实调用
        const existing = msg.toolCalls.find((t) => t.id === toolCall.id);
        if (existing) {
          mergeInto(existing);
          return;
        }

        msg.streamTextOffset = (msg.text || '').length;
        const lastB = msg.blocks[msg.blocks.length - 1];
        if (lastB && lastB.type === 'text' && !(lastB.content || '').trim()) {
          msg.blocks.pop();
        }
        msg.toolCalls.push(toolCall);
        if (
          !msg.blocks.some(
            (b) => b.type === 'tool_call' && b.id === toolCall.id
          )
        ) {
          msg.blocks.push({ type: 'tool_call' as const, id: toolCall.id });
        }
      }),

    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        // 无 toolCalls 时直接返回，避免空数组占位写 draft
        if (!msg.toolCalls) return;
        const tc = msg.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        // 终态后忽略回退为 running 的 status，只吸收其余字段
        // 治理防线 #33：用 sanitizeToolCallUpdates 替代旧 delete rest.status
        // 治理防线 #1：用 applyMessageToolCallPatch 替代 Object.assign（消除类型逃逸）
        const effective = sanitizeToolCallUpdates(tc, updates);
        // 字段无实质变化：不写 draft
        if (!toolCallPatchHasChanges(tc, effective)) return;
        applyMessageToolCallPatch(tc, effective);
        // 不对齐 id 时不猜「最近 running」，避免写错行
      }),

    setSessionMessageStatus: (
      sessionId,
      messageId,
      status,
      thinkingTime,
      opts
    ) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        // status / thinkingTime 均无变化时不改 draft
        if (
          hit.message.status === status &&
          (thinkingTime === undefined ||
            hit.message.thinkingTime === thinkingTime)
        ) {
          return;
        }
        // 状态转换合法性校验
        try {
          validateStatusTransition(
            hit.message.status || '',
            status,
            opts?.force
          );
        } catch (e) {
          console.warn(
            '[StatusTransition] 消息状态非法转换:',
            (e as Error).message
          );
          return;
        }
        hit.message.status = status;
        if (thinkingTime !== undefined) {
          hit.message.thinkingTime = thinkingTime;
        }
      }),

    pinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!getMessageById(sess.messages, messageId)) return;
        if (!sess.pinnedMessageIds) sess.pinnedMessageIds = [];
        if (
          !sess.pinnedMessageIds.includes(messageId) &&
          sess.pinnedMessageIds.length < MAX_MESSAGES_PER_SESSION
        ) {
          sess.pinnedMessageIds.push(messageId);
        }
      }),

    unpinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess?.pinnedMessageIds?.length) return;
        sess.pinnedMessageIds = sess.pinnedMessageIds.filter(
          (id) => id !== messageId
        );
        if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
      }),

    patchAgentTool: (sessionId, agentId, toolCallId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag?.messages) return;
        for (const msg of ag.messages) {
          if (!msg.toolCalls) continue;
          const tc = msg.toolCalls.find((t) => t.id === toolCallId);
          if (!tc) continue;
          // 治理防线 #33 / #1：用 sanitizeToolCallUpdates + applyMessageToolCallPatch
          // 替代旧 delete rest.status + Object.assign（统一逻辑、消除类型逃逸）
          const effective = sanitizeToolCallUpdates(tc, patch);
          if (!toolCallPatchHasChanges(tc, effective)) return;
          applyMessageToolCallPatch(tc, effective);
          return;
        }
      }),

    /**
     * 主对话列永不挂 agent。
     * 非 null 时改写到 panelAgentId，避免历史路径同时点亮双表面。
     * 打开侧栏请优先 openAgentInSidePanel。
     */
    setActiveAgentId: (id) =>
      set((state) => {
        // 主列永不挂 agent：非 null 改写到 panel；null 仅清主列字段
        // （侧栏焦点请用 setPanelAgentId / openAgentInSidePanel / clearAgentPanelFocus）
        if (id) {
          state.activeAgentId = null;
          state.panelAgentId = id;
        } else {
          state.activeAgentId = null;
        }
      }),

    setPanelAgentId: (id) =>
      set((state) => {
        state.panelAgentId = id;
      }),

    upsertSessionAgent: (sessionId, agent) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if (!sess.agents) sess.agents = [];
        const i = sess.agents.findIndex((a) => a.id === agent.id);
        if (i >= 0) {
          // noUncheckedIndexedAccess：下标访问返回 T | undefined，需显式守卫
          const existingAgent = sess.agents[i];
          if (!existingAgent) {
            // findIndex 命中但下标取不到：理论上不可达（immer draft 一致性）；
            // 防御性直接 unshift，避免在 undefined 上展开
            sess.agents.unshift(agent);
          } else {
            sess.agents[i] = {
              ...existingAgent,
              ...agent,
              messages: agent.messages?.length
                ? agent.messages
                : existingAgent.messages,
            };
          }
        } else {
          sess.agents.unshift(agent);
          if (sess.agents.length > 40) sess.agents.length = 40;
        }
      }),

    patchSessionAgent: (sessionId, agentId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        // 治理防线 #1（类型逃逸）：用 SessionAgentPatch 白名单 + applySessionAgentPatch
        // 替代 Object.assign(ag, patch)——禁止任意 key 写入
        applySessionAgentPatch(ag, patch);
      }),

    patchSession: (sessionId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if ('goalMode' in patch) {
          if (patch.goalMode === null || patch.goalMode === undefined) {
            delete sess.goalMode;
          } else {
            sess.goalMode = patch.goalMode;
          }
        }
      }),

    appendSessionAgentMessage: (sessionId, agentId, message) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        if (!ag.messages) ag.messages = [];
        const existing = getMessageById(ag.messages, message.id);
        if (existing) {
          // 治理防线 #33（DRY）：用 mergeSessionMessageFields 替代 Object.assign
          // 仅当 message 显式提供有效字段时覆盖（undefined 不破坏 existing 旧值）
          mergeSessionMessageFields(existing, message);
        } else {
          // 治理防线 #13 / #34：截断 + truncatedToolChainIds 累加同事务
          // 子 agent pinned 概念不存在，pinnedMessageIds 参数省略
          // truncatedToolChainIds 累加到父会话级（与主会话路径一致）
          truncateMessagesForAppend(
            ag.messages,
            MAX_MESSAGES_PER_AGENT,
            sess,
            undefined,
          );
          ag.messages.push(message);
        }
      }),

    setActiveSessionId: (id) => {
      const nextId = typeof id === 'string' ? id : '';
      set((state) => {
        // 活动安全：非空非草稿 id 必须已在列表中；草稿哨兵豁免
        if (
          nextId &&
          !isPendingDraft(nextId) &&
          !getSessionById(state, nextId)
        ) {
          return;
        }
        // 切换只改焦点与终端视图；绝不 prune 空「新会话」
        // （否则用户连建多个对话一切换就丢，体感像「掉对话」）
        const same = state.activeSessionId === nextId;
        state.activeSessionId = nextId;
        // 切到真实会话（或清空）时释放草稿 folder 绑定
        if (!isPendingDraft(nextId)) {
          state.draftFolder = '';
        }
        if (!same) {
          state.activeAgentId = null; // 主列永不挂 agent
          state.panelAgentId = null; // 切会话清侧栏 agent 焦点，避免串会话
          state.terminalLines = nextId
            ? state.terminalBySession[nextId] || []
            : [];
        }
      });
      // 正式版：仅真实会话同步工作区 cwd / 引擎水合（草稿无 list 条目）
      if (!isDemoMode() && nextId && !isPendingDraft(nextId)) {
        const sess = getSessionById(get(), nextId);
        if (sess) {
          void import('../api/projectStore').then(
            ({ activateWorkspaceForSessionFolder }) => {
              activateWorkspaceForSessionFolder(sess.folder);
            }
          );
          // 空会话壳：尽力从引擎水合正文（H2）；失败保持空态
          if (
            !sess.hydratedFromEngine &&
            (!sess.messages || sess.messages.length === 0)
          ) {
            void import('../api/sessionEventHydrate').then(
              ({ hydrateSessionMessagesFromDaemon }) => {
                void hydrateSessionMessagesFromDaemon(nextId).then((res) => {
                  if (!res.ok) return;
                  set((state) => {
                    const s = getSessionById(state, nextId);
                    if (!s) return;
                    // 水合期间用户可能已发消息，勿覆盖非空
                    if (s.messages && s.messages.length > 0) {
                      s.hydratedFromEngine = true;
                      maybeAutoTitleSession(state, s);
                      return;
                    }
                    if (res.messages.length > 0) {
                      s.messages = res.messages;
                      // 治理防线 #6（数据水合）：timestamp 始终 ISO 串，
                      // 来源由 timestampSource='remote' discriminator 标记
                      // 旧实现 `s.timestamp = '远程'` 字面量污染下游相对时间计算 → NaN
                      s.timestamp = nowIsoTimestamp();
                      s.timestampSource = 'remote';
                      maybeAutoTitleSession(state, s);
                    }
                    s.engineCursor = res.nextAfterSequence;
                    if (res.lastRunId) s.engineLastRunId = res.lastRunId;
                    s.hydratedFromEngine = true;
                  });
                });
              }
            );
          }
        }
      }
    },

    enterDraftMode: (folder) => {
      set((state) => {
        state.activeSessionId = PENDING_DRAFT_SESSION_ID;
        state.draftFolder =
          (typeof folder === 'string' && folder.trim()) ||
          getActiveProjectId() ||
          GENERAL_FOLDER ||
          '';
        state.activeAgentId = null;
        state.panelAgentId = null;
        state.terminalLines = [];
      });
    },

    setDraftFolder: (folder) => {
      set((state) => {
        state.draftFolder = typeof folder === 'string' ? folder : '';
      });
    },

    clearDraft: () => {
      set((state) => {
        if (isPendingDraft(state.activeSessionId)) {
          state.activeSessionId = '';
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
        }
        state.draftFolder = '';
      });
    },

    commitDraftIfNeeded: (opts) => {
      const st = get();
      if (!isPendingDraft(st.activeSessionId)) {
        return st.activeSessionId && getSessionById(st, st.activeSessionId)
          ? st.activeSessionId
          : '';
      }
      const folder =
        opts?.folder ||
        st.draftFolder ||
        getActiveProjectId() ||
        GENERAL_FOLDER;
      // reuse 已删：直接 mint；createSession 激活时会清 draftFolder
      return actions.createSession({
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        folder,
        activate: true,
      });
    },

    renameSession: (sessionId, title) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        // 中文 / emoji 按码点截断；控制符与 slash 噪声剥掉；空输入保留旧标题
        const next = normalizeWritableSessionTitle(title);
        if (!next) return;
        if (sess.title === next) return;
        sess.title = next;
      }),

    createSession: (opts) => {
      const explicitId =
        opts?.id && typeof opts.id === 'string' ? opts.id.trim() : '';
      // 默认激活；定时任务占位传 activate:false，避免抢走当前对话
      const activate = opts?.activate !== false;
      // 写入标题：sanitize + 码点截断；空 → 清晰「新会话」占位（非幽灵标签）
      const requestedTitle = normalizeWritableSessionTitle(opts?.title);
      const initialTitle = requestedTitle || EMPTY_SESSION_TITLE;

      // mint | attach explicitId | activate:false — 禁止 reuse empty shell
      const id = explicitId || `sess-${Date.now()}`;
      set((state) => {
        // 已存在：可选激活（定时 workflow 复用引擎 sessionId 时常 activate:false）
        const existing = getSessionById(state, id);
        if (existing) {
          const prevActive = state.activeSessionId;
          if (activate) {
            state.activeSessionId = id;
            state.activeAgentId = null;
            state.panelAgentId = null;
            state.terminalLines = state.terminalBySession[id] || [];
            state.draftFolder = '';
          }
          applyTitleIfDefault(existing, requestedTitle);
          // GC 其它空壳（非 reuse）；activate 时只 keep 本 id
          pruneEmptyShellsInPlace(
            state,
            shellPruneKeepIds(id, prevActive, { activating: activate })
          );
          return;
        }
        const projectId = getActiveProjectId();
        const activeSess = state.activeSessionId
          ? getSessionById(state, state.activeSessionId)
          : null;
        const currentFolder = activeSess?.folder;
        // 草稿 commit 路径会传 opts.folder；demo 无显式 folder 时回落「常规会话」
        // 显式 opts.folder 必须优先（commit 绑定 draftFolder 契约）
        const defaultFolder = isDemoMode()
          ? opts?.folder || '常规会话'
          : opts?.folder ||
            currentFolder ||
            state.draftFolder ||
            projectId ||
            GENERAL_FOLDER;
        const sess: SessionState = {
          id,
          title: initialTitle,
          folder: defaultFolder,
          isPinned: false,
          isArchived: false,
          // 存 ISO，侧栏用相对时间计算；勿写死「刚刚」字面量
          timestamp: nowIsoTimestamp(),
          messages: [],
        };
        // mint 新会话：不 prune 既有空壳（否则连建多会话一切换就丢）
        state.sessions.unshift(sess);
        reindexSessionsById(state);
        if (
          !state.folderOrder.includes(sess.folder) &&
          state.folderOrder.length < MAX_FOLDERS
        ) {
          state.folderOrder.unshift(sess.folder);
        }
        if (activate) {
          state.activeSessionId = id;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = [];
          state.draftFolder = '';
        }
      });
      return id;
    },

    deleteSession: (sessionId) => {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id) return false;
      let removed = false;
      set((state) => {
        // 守卫：不存在 / 仅陈旧索引 → deleteSessionFromIndexed 仍可清索引
        const idx = getSessionIndex(state, id);
        const wasActive = state.activeSessionId === id;
        const fallback = wasActive
          ? pickFallbackActiveSessionId(state, id, idx >= 0 ? idx : 0)
          : '';
        removed = deleteSessionFromIndexed(state, id);
        if (!removed) return;
        dropTerminalForSession(state, id);
        if (wasActive) {
          state.activeSessionId = fallback;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = fallback
            ? state.terminalBySession[fallback] || []
            : [];
        }
        // 删后 GC 其它幽灵空壳（非 reuse）；保留新活动
        pruneEmptyShellsInPlace(
          state,
          shellPruneKeepIds(state.activeSessionId || null, null, {
            activating: true,
          })
        );
      });
      if (removed) {
        sessionRuntimeRegistry.remove(id);
        clearMessageSnapshots(id);
      }
      return removed;
    },

    pinSession: (sessionId) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (sess) sess.isPinned = true;
      }),

    unpinSession: (sessionId) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (sess) sess.isPinned = false;
      }),

    archiveSession: (sessionId) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (!sess || sess.isArchived) return;
        sess.isArchived = true;
        // 活动安全：归档当前会话时切到邻近非归档，避免主列停在已归档
        if (state.activeSessionId === sessionId) {
          const idx = getSessionIndex(state, sessionId);
          const fallback = pickFallbackActiveSessionId(
            state,
            sessionId,
            idx >= 0 ? idx : 0
          );
          state.activeSessionId = fallback;
          state.activeAgentId = null;
          state.panelAgentId = null;
          state.terminalLines = fallback
            ? state.terminalBySession[fallback] || []
            : [];
          // GC 空壳（非 reuse）；keep 新活动 fallback
          pruneEmptyShellsInPlace(
            state,
            shellPruneKeepIds(fallback || null, null, { activating: true })
          );
        }
      }),

    unarchiveSession: (sessionId) =>
      set((state) => {
        if (!sessionId) return;
        const sess = getSessionById(state, sessionId);
        if (!sess || !sess.isArchived) return;
        sess.isArchived = false;
      }),

    branchSession: (sessionId, newTitle) =>
      set((state) => {
        if (!sessionId) return;
        const original = getSessionById(state, sessionId);
        if (!original) return;

        const title =
          normalizeWritableSessionTitle(newTitle) ||
          normalizeWritableSessionTitle(original.title) ||
          EMPTY_SESSION_TITLE;

        // 治理防线 #15（immutability 反模式）：用 cloneMessages 替代
        // JSON.parse(JSON.stringify(...))——保留非 JSON 类型、性能更优、immer 兼容
        const newSess: SessionState = {
          id: `sess-branch-${Date.now()}`,
          title,
          folder: original.folder,
          isPinned: false,
          isArchived: false,
          branchParentId: sessionId,
          // 治理防线 #6：timestamp 始终 ISO 串；分叉是本机操作 → timestampSource='local'
          timestamp: nowIsoTimestamp(),
          timestampSource: 'local',
          messages: original.messages ? cloneMessages(original.messages) : [],
          // 治理防线 #34（派生标记一致）：pinnedMessageIds 引用的消息 id 在新会话中
          // 仍然存在（messages 已深拷贝），所以 pinned 引用同步复制无孤儿风险
          ...(original.pinnedMessageIds?.length
            ? { pinnedMessageIds: [...original.pinnedMessageIds] }
            : {}),
        };
        // 分叉会话紧插在原会话之后
        const idx = getSessionIndex(state, sessionId);
        if (idx < 0) {
          state.sessions.unshift(newSess);
        } else {
          state.sessions.splice(idx + 1, 0, newSess);
        }
        state.sessionsById[newSess.id] = newSess;
        state.activeSessionId = newSess.id; // 自动聚焦新分叉
        state.activeAgentId = null;
        state.panelAgentId = null;
        state.terminalLines = [];
        // 与 setActive 同源：激活后 GC 其它幽灵空壳（含空父壳；非 reuse）
        pruneEmptyShellsInPlace(
          state,
          shellPruneKeepIds(newSess.id, null, { activating: true })
        );
      }),

    moveSessionRealtime: (sessionId, targetSessionId, targetFolder, isPinned) =>
      set((state) => {
        const sessIdx = getSessionIndex(state, sessionId);
        if (sessIdx === -1) return;

        const removed = state.sessions.splice(sessIdx, 1);
        const sess = removed[0];
        if (!sess) return;
        sess.isPinned = isPinned;
        sess.folder = targetFolder;

        if (targetSessionId) {
          const tIdx = getSessionIndex(state, targetSessionId);
          if (tIdx !== -1) {
            state.sessions.splice(tIdx, 0, sess);
          } else {
            state.sessions.push(sess);
          }
        } else {
          state.sessions.push(sess);
        }
        // 重排后引用仍是 sess，补索引（删除后 push 可能丢 id）
        state.sessionsById[sess.id] = sess;
      }),

    moveFolderRealtime: (folderName, targetFolderName) =>
      set((state) => {
        const idx = state.folderOrder.indexOf(folderName);
        if (idx === -1) return;
        state.folderOrder.splice(idx, 1);
        if (targetFolderName) {
          const tIdx = state.folderOrder.indexOf(targetFolderName);
          if (tIdx !== -1) {
            state.folderOrder.splice(tIdx, 0, folderName);
          } else {
            state.folderOrder.push(folderName);
          }
        } else {
          state.folderOrder.push(folderName);
        }
      }),

    pinFolderSessions: (folderName) =>
      set((state) => {
        state.sessions.forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = true;
          }
        });
      }),

    unpinFolderSessions: (folderName) =>
      set((state) => {
        state.sessions.forEach((s) => {
          if (s.folder === folderName) {
            s.isPinned = false;
          }
        });
      }),
  };
  return actions;
}
