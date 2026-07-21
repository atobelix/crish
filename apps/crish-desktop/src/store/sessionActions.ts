/**
 * 会话 / 消息 / agent 相关 action 实现。
 * 仍挂在同一 useLayoutStore（Phase 1）；对外请用 sessionStore.ts 的 useSessionStore 门面。
 */

import {
  MAX_MESSAGES_PER_SESSION,
  MAX_MESSAGES_PER_AGENT,
  MAX_FOLDERS,
} from '@crish/shared-utils/browser';
import { isDemoMode } from '../api/appMode';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
} from '../api/projectStore';
import {
  EMPTY_SESSION_TITLE,
  findReusableEmptyShell,
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
  SessionAgent,
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

/** 手动 rename / 分叉标题码点上限（略宽于侧栏自动标题 28） */
const MANUAL_SESSION_TITLE_MAX_LEN = 48;

/**
 * 会话域 action 需要读写的 store 切片（避免与 layoutStore 循环 import）。
 * 字段名/形状须与 LayoutStore 对齐；LayoutStore 必须 extends 本切片。
 */
export interface SessionStoreSlice extends SessionsIndexed {
  folderOrder: string[];
  activeSessionId: string;
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
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  patchSessionAgent: (
    sessionId: string,
    agentId: string,
    patch: Partial<SessionAgent>
  ) => void;
  appendSessionAgentMessage: (
    sessionId: string,
    agentId: string,
    message: SessionMessage
  ) => void;
  renameSession: (sessionId: string, title: string) => void;
  /**
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
  respondToApproval: (
    wsId: string,
    sessionId: string,
    messageId: string,
    toolCallId: string,
    status: 'success' | 'error'
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

/** 工具调用增量相对当前字段是否有实质变化（浅比较；diffs 比引用） */
function toolCallPatchHasChanges(
  tc: MessageToolCall,
  updates: Partial<MessageToolCall>
): boolean {
  for (const key of Object.keys(updates) as Array<keyof MessageToolCall>) {
    if (tc[key] !== updates[key]) return true;
  }
  return false;
}

function getSessionAgent(
  session: SessionState,
  agentId: string
): SessionAgent | undefined {
  return session.agents?.find((a) => a.id === agentId);
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

/** 剪空壳并在引用变化时 reindex；顺带 GC 已消失会话的 terminal 缓冲 */
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

/**
 * createSession 复用路径：find 与 set 之间壳可能被写消息 / 置顶 / 改标题 / 归档。
 * 须在 draft 内再验一次；不合格则零写入，由调用方 mint 新会话。
 */
function isStillReusableEmptyShell(
  sess: SessionState,
  folder: string
): boolean {
  if (sess.isArchived) return false;
  if (!isEmptyShellSession(sess)) return false;
  // 与 findReusableEmptyShell 同 folder 契约（含幽灵 proj-* 规范后比较）
  if (canonicalSessionFolder(sess.folder) !== canonicalSessionFolder(folder)) {
    return false;
  }
  return true;
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
  return {
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

        if (sess.messages.length >= MAX_MESSAGES_PER_SESSION)
          sess.messages.shift();
        sess.messages.push(newMsg);
        // 活动触达写 ISO，侧栏相对时间可老化；勿写「刚刚」字面量
        const ts =
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp)
            ? new Date(message.timestamp).toISOString()
            : nowIsoTimestamp();
        sess.timestamp = ts;
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
                pinnedMessageIds: prevPinned,
                diffFilePaths: [],
                timestamp: Date.now(),
                description: '撤回消息',
              },
              { afterMessages: sess.messages }
            );
          }
        }
      }),

    respondToApproval: (_wsId, sessionId, messageId, toolCallId, status) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        const tc = hit.message.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        if (status === 'success') {
          // mock 流会轮询 status===success；daemon 路径随后 tool-end 会覆盖
          tc.status = 'success';
          tc.output = '已批准，正在执行\u2026';
        } else {
          tc.status = 'error';
          tc.output = '权限被拒绝。';
        }
      }),

    setSessions: (sessions) =>
      set((state) => {
        // 与 hydrate/diskMirror 同源：fillDefault + shellPruneKeepIds(active)
        // keep 仅 active：daemon sync / 落盘恢复后不应保留多余幽灵；定时真实标题不剪
        // 不 invent 远程空壳：prepare 内 prune 会丢掉非 keep 的默认幽灵
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
        let effective: Partial<MessageToolCall> = updates;
        if (
          (tc.status === 'success' || tc.status === 'error') &&
          updates.status === 'running'
        ) {
          const rest = { ...updates };
          delete rest.status;
          effective = rest;
        }
        // 字段无实质变化：不 Object.assign
        if (!toolCallPatchHasChanges(tc, effective)) return;
        Object.assign(tc, effective);
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
          if (
            (tc.status === 'success' || tc.status === 'error') &&
            patch.status === 'running'
          ) {
            const rest = { ...patch };
            delete rest.status;
            Object.assign(tc, rest);
          } else {
            Object.assign(tc, patch);
          }
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
          sess.agents[i] = {
            ...sess.agents[i],
            ...agent,
            messages: agent.messages?.length
              ? agent.messages
              : sess.agents[i].messages,
          };
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
        Object.assign(ag, patch);
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
          Object.assign(existing, message);
        } else {
          if (ag.messages.length >= MAX_MESSAGES_PER_AGENT) ag.messages.shift();
          ag.messages.push(message);
        }
      }),

    setActiveSessionId: (id) => {
      const nextId = typeof id === 'string' ? id : '';
      set((state) => {
        // 活动安全：非空 id 必须已在列表中，禁止指到幽灵 id
        if (nextId && !getSessionById(state, nextId)) {
          return;
        }
        // 切换只改焦点与终端视图；绝不 prune 空「新会话」
        // （否则用户连建多个对话一切换就丢，体感像「掉对话」）
        const same = state.activeSessionId === nextId;
        state.activeSessionId = nextId;
        if (!same) {
          state.activeAgentId = null; // 主列永不挂 agent
          state.panelAgentId = null; // 切会话清侧栏 agent 焦点，避免串会话
          state.terminalLines = nextId
            ? state.terminalBySession[nextId] || []
            : [];
        }
      });
      // 正式版：切换会话时同步工作区 cwd（folder = projectId 或 对话）
      if (!isDemoMode() && nextId) {
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
                      s.timestamp = '远程';
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

      // 用户点「新建」(activate:true) 未指定 id：优先复用同 folder 空壳。
      // activate:false 后台建壳绝不复用——否则会误吞用户空白活动会话 / 侧栏幽灵。
      // 不 invent 远程壳：只复用本地已有 isEmptyShellSession 条目。
      if (!explicitId && activate) {
        const projectId = getActiveProjectId();
        const activeId = get().activeSessionId;
        const activeSess = activeId ? getSessionById(get(), activeId) : null;
        // 若当前活动会话本身就是未发送信息的空壳：优先直接迁移到目标 folder 并保持激活，不刷双空壳
        if (
          activeId &&
          activeSess &&
          isEmptyShellSession(activeSess) &&
          (!activeSess.messages || activeSess.messages.length === 0)
        ) {
          const targetFolder = isDemoMode()
            ? '常规会话'
            : opts?.folder || activeSess.folder || projectId || GENERAL_FOLDER;
          set((state) => {
            const existing = getSessionById(state, activeId);
            if (existing) {
              existing.folder = targetFolder;
              existing.timestamp = nowIsoTimestamp();
              applyTitleIfDefault(existing, requestedTitle);
              // 复用活动空壳时剪掉 peer 幽灵，避免侧栏刷屏
              const prevActive = state.activeSessionId;
              pruneEmptyShellsInPlace(
                state,
                shellPruneKeepIds(activeId, prevActive, { activating: true })
              );
            }
          });
          return activeId;
        }

        const currentFolder = activeSess?.folder;
        const defaultFolder = isDemoMode()
          ? '常规会话'
          : opts?.folder || currentFolder || projectId || GENERAL_FOLDER;
        const reuseId = findReusableEmptyShell(get().sessions, defaultFolder, {
          preferId: activeId || null,
        });
        if (reuseId) {
          let reused = false;
          set((state) => {
            const existing = getSessionById(state, reuseId);
            if (!existing) return;
            // draft 内再验：空壳 + 同 folder（拒绝跨项目脏复用 / 竞态写消息）
            if (isStillReusableEmptyShell(existing, defaultFolder)) {
              applyTitleIfDefault(existing, requestedTitle);
              existing.timestamp = nowIsoTimestamp();
              if (opts?.folder) existing.folder = opts.folder;
              const prevActive = state.activeSessionId;
              state.activeSessionId = reuseId;
              state.activeAgentId = null;
              state.panelAgentId = null;
              state.terminalLines = state.terminalBySession[reuseId] || [];
              pruneEmptyShellsInPlace(
                state,
                shellPruneKeepIds(reuseId, prevActive, { activating: true })
              );
              reused = true;
            }
          });
          if (reused) {
            return reuseId;
          }
        }
      }

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
          }
          applyTitleIfDefault(existing, requestedTitle);
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
        const defaultFolder = isDemoMode()
          ? '常规会话'
          : opts?.folder || currentFolder || projectId || GENERAL_FOLDER;
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
        // 连点刷屏仅靠 reuse 路径剪 peer
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
        // 删后剪其它幽灵空壳；保留新活动（及非 activating 无需旧 active）
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

        const newSess: SessionState = {
          id: `sess-branch-${Date.now()}`,
          title,
          folder: original.folder,
          isPinned: false,
          isArchived: false,
          branchParentId: sessionId,
          timestamp: nowIsoTimestamp(),
          messages: original.messages
            ? JSON.parse(JSON.stringify(original.messages))
            : [],
          pinnedMessageIds: original.pinnedMessageIds
            ? [...original.pinnedMessageIds]
            : undefined,
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
        // 与 setActive 同源：激活后剪掉其它幽灵空壳（含空父壳）
        pruneEmptyShellsInPlace(
          state,
          shellPruneKeepIds(newSess.id, null, { activating: true })
        );
      }),

    moveSessionRealtime: (sessionId, targetSessionId, targetFolder, isPinned) =>
      set((state) => {
        const sessIdx = getSessionIndex(state, sessionId);
        if (sessIdx === -1) return;

        const [sess] = state.sessions.splice(sessIdx, 1);
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
}
