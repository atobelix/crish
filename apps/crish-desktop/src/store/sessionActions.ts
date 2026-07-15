/**
 * 会话 / 消息 / agent 相关 action 实现。
 * 仍挂在同一 useLayoutStore，不单独建 zustand store。
 */

import { isDemoMode } from '../api/appMode';
import { GENERAL_FOLDER, getActiveProjectId } from '../api/projectStore';
import type { PermissionMode } from '../api/permissionModes';
import { fillDefaultSessionTitles, maybeAutoTitleFromMessages } from '../api/sessionTitle';
import type {
  MessageToolCall,
  SessionAgent,
  SessionMessage,
  SessionState,
} from './types';

/**
 * 会话域 action 需要读写的 store 切片（避免与 layoutStore 循环 import）。
 * 字段名/形状须与 LayoutStore 对齐。
 */
interface SessionStoreSlice {
  sessions: SessionState[];
  folderOrder: string[];
  activeSessionId: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  permissionMode: PermissionMode;
  planModeEnabled: boolean;
  planApproved: boolean;
  terminalLines: string[];
  terminalBySession: Record<string, string[]>;
}

/** 会话 / 消息 / agent 域 action 签名（与 LayoutStore 同名方法一致） */
export interface SessionActions {
  setActiveSessionId: (id: string) => void;
  setActiveAgentId: (id: string | null) => void;
  setPanelAgentId: (id: string | null) => void;
  upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  patchSessionAgent: (
    sessionId: string,
    agentId: string,
    patch: Partial<SessionAgent>,
  ) => void;
  appendSessionAgentMessage: (
    sessionId: string,
    agentId: string,
    message: SessionMessage,
  ) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  renameSession: (sessionId: string, title: string) => void;
  createSession: (opts?: { title?: string; folder?: string; id?: string }) => string;
  pinSession: (sessionId: string) => void;
  unpinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  branchSession: (sessionId: string, newTitle: string) => void;
  moveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean,
  ) => void;
  moveFolderRealtime: (folderName: string, targetFolderName: string | null) => void;
  pinFolderSessions: (folderName: string) => void;
  unpinFolderSessions: (folderName: string) => void;
  addMessage: (wsId: string, sessionId: string, message: SessionMessage) => void;
  withdrawMessage: (wsId: string, sessionId: string, messageId: string) => void;
  respondToApproval: (
    wsId: string,
    sessionId: string,
    messageId: string,
    toolCallId: string,
    status: 'success' | 'error',
  ) => void;
  setSessions: (sessions: SessionState[]) => void;
  updateMessageText: (sessionId: string, messageId: string, text: string) => void;
  updateMessageThinking: (sessionId: string, messageId: string, thinking: string) => void;
  addMessageToolCall: (sessionId: string, messageId: string, toolCall: MessageToolCall) => void;
  updateMessageToolCall: (
    sessionId: string,
    messageId: string,
    toolCallId: string,
    updates: Partial<MessageToolCall>,
  ) => void;
  setSessionMessageStatus: (
    sessionId: string,
    messageId: string,
    status: 'queued' | 'processing' | 'completed',
    thinkingTime?: number,
  ) => void;
}

/** immer set：recipe 可原地改 draft */
type ImmerSet = (recipe: (state: SessionStoreSlice) => void) => void;
type StoreGet = () => SessionStoreSlice;

/**
 * 创建会话域 actions，供 layoutStore 的 immer((set,get)=>({...})) 展开。
 */
export function createSessionActions(set: ImmerSet, get: StoreGet): SessionActions {
  return {
    addMessage: (_wsId, sessionId, message) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess) {
        if (!sess.messages) sess.messages = [];

        // 注意：正式审批由 daemonChatBridge 处理；此处不再伪造「自动授权成功」输出
        const newMsg = {
          ...message,
          blocks: message.blocks || []
        };
        if (newMsg.blocks.length === 0) {
          if (newMsg.text) {
            newMsg.blocks.push({ type: 'text' as const, content: newMsg.text });
          }
          if (newMsg.toolCalls) {
            newMsg.toolCalls.forEach(tc => {
              newMsg.blocks.push({ type: 'tool_call' as const, id: tc.id });
            });
          }
        }

        sess.messages.push(newMsg);
      }
    }),

    withdrawMessage: (_wsId, sessionId, messageId) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const idx = sess.messages.findIndex(m => m.id === messageId);
        if (idx !== -1) {
          sess.messages = sess.messages.slice(0, idx);
        }
      }
    }),

    respondToApproval: (_wsId, sessionId, messageId, toolCallId, status) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg && msg.toolCalls) {
          const tc = msg.toolCalls.find(t => t.id === toolCallId);
          if (tc) {
            if (status === 'success') {
              // mock 流会轮询 status===success；daemon 路径随后 tool-end 会覆盖
              tc.status = 'success';
              tc.output = '已批准，正在执行\u2026';
            } else {
              tc.status = 'error';
              tc.output = '权限被拒绝。';
            }
          }
        }
      }
    }),

    setSessions: (sessions) => set((state) => {
      // 合并远程后补默认标题（有消息则推导）
      state.sessions = fillDefaultSessionTitles(sessions);
      // 合并远程会话后补齐侧栏分组顺序
      for (const s of state.sessions) {
        if (s.folder && !state.folderOrder.includes(s.folder)) {
          state.folderOrder.push(s.folder);
        }
      }
      // 活动会话若已被移除则清空（回到空态）
      if (state.activeSessionId && !state.sessions.some((s) => s.id === state.activeSessionId)) {
        state.activeSessionId = '';
      }
    }),

    updateMessageText: (sessionId, messageId, text) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          const prev = msg.text || '';
          msg.text = text;
          if (!msg.blocks) msg.blocks = [];
          let offset = typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
          // 全文缩短/重写：重置偏移，避免 segment 变成整篇导致正文重复
          if (text.length < offset || (prev && text.length < prev.length && !prev.startsWith(text) && !text.startsWith(prev.slice(0, Math.min(prev.length, text.length))))) {
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
        }
      }
    }),

    updateMessageThinking: (sessionId, messageId, thinking) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          // 支持累计全文或引擎推送的完整思考
          msg.thinking = thinking;
        }
      }
    }),

    addMessageToolCall: (sessionId, messageId, toolCall) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          if (!msg.toolCalls) msg.toolCalls = [];
          if (!msg.blocks) msg.blocks = [];

          const mergeInto = (target: MessageToolCall) => {
            if (
              (target.status === 'success' || target.status === 'error') &&
              toolCall.status === 'running'
            ) {
              if (!target.arguments && toolCall.arguments) target.arguments = toolCall.arguments;
              if (!target.explanation && toolCall.explanation) target.explanation = toolCall.explanation;
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
          if (!msg.blocks.some((b) => b.type === 'tool_call' && b.id === toolCall.id)) {
            msg.blocks.push({ type: 'tool_call' as const, id: toolCall.id });
          }
        }
      }
    }),

    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          if (!msg.toolCalls) msg.toolCalls = [];
          const tc = msg.toolCalls.find(t => t.id === toolCallId);
          if (tc) {
            if (
              (tc.status === 'success' || tc.status === 'error') &&
              updates.status === 'running'
            ) {
              const { status: _s, ...rest } = updates;
              Object.assign(tc, rest);
              return;
            }
            Object.assign(tc, updates);
          }
          // 不对齐 id 时不猜「最近 running」，避免写错行
        }
      }
    }),

    setSessionMessageStatus: (sessionId, messageId, status, thinkingTime) => set((state) => {
      const sess = state.sessions.find(s => s.id === sessionId);
      if (sess && sess.messages) {
        const msg = sess.messages.find(m => m.id === messageId);
        if (msg) {
          msg.status = status;
          if (thinkingTime !== undefined) {
            msg.thinkingTime = thinkingTime;
          }
        }
      }
    }),

    setActiveAgentId: (id) => set((state) => {
      state.activeAgentId = id;
    }),

    setPanelAgentId: (id) => set((state) => {
      state.panelAgentId = id;
    }),

    upsertSessionAgent: (sessionId, agent) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (!sess) return;
      if (!sess.agents) sess.agents = [];
      const i = sess.agents.findIndex((a) => a.id === agent.id);
      if (i >= 0) {
        sess.agents[i] = { ...sess.agents[i], ...agent, messages: agent.messages?.length ? agent.messages : sess.agents[i].messages };
      } else {
        sess.agents.unshift(agent);
        if (sess.agents.length > 40) sess.agents.length = 40;
      }
    }),

    patchSessionAgent: (sessionId, agentId, patch) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      const ag = sess?.agents?.find((a) => a.id === agentId);
      if (!ag) return;
      Object.assign(ag, patch);
    }),

    appendSessionAgentMessage: (sessionId, agentId, message) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      const ag = sess?.agents?.find((a) => a.id === agentId);
      if (!ag) return;
      if (!ag.messages) ag.messages = [];
      const existing = ag.messages.find((m) => m.id === message.id);
      if (existing) {
        Object.assign(existing, message);
      } else {
        ag.messages.push(message);
      }
    }),

    setActiveSessionId: (id) => {
      set((state) => {
        state.activeSessionId = id;
        state.activeAgentId = null; // 切会话时回到主对话
        // 切换会话时切换终端缓冲视图
        if (id) {
          state.terminalLines = state.terminalBySession[id] || [];
        }
      });
      // 正式版：切换会话时同步工作区 cwd（folder = projectId 或 对话）
      if (!isDemoMode() && id) {
        const sess = get().sessions.find((s) => s.id === id);
        if (sess) {
          void import('../api/projectStore').then(({ activateWorkspaceForSessionFolder }) => {
            activateWorkspaceForSessionFolder(sess.folder);
          });
          // 空会话壳：尽力从引擎水合正文（H2）；失败保持空态
          if (
            !sess.hydratedFromEngine &&
            (!sess.messages || sess.messages.length === 0)
          ) {
            void import('../api/sessionEventHydrate').then(({ hydrateSessionMessagesFromDaemon }) => {
              void hydrateSessionMessagesFromDaemon(id).then((res) => {
                if (!res.ok) return;
                set((state) => {
                  const s = state.sessions.find((x) => x.id === id);
                  if (!s) return;
                  // 水合期间用户可能已发消息，勿覆盖非空
                  if (s.messages && s.messages.length > 0) {
                    s.hydratedFromEngine = true;
                    const auto = maybeAutoTitleFromMessages(s.title, s.messages);
                    if (auto) s.title = auto;
                    return;
                  }
                  if (res.messages.length > 0) {
                    s.messages = res.messages;
                    s.timestamp = '远程';
                    const auto = maybeAutoTitleFromMessages(s.title, res.messages);
                    if (auto) s.title = auto;
                  }
                  s.engineCursor = res.nextAfterSequence;
                  if (res.lastRunId) s.engineLastRunId = res.lastRunId;
                  s.hydratedFromEngine = true;
                });
              });
            });
          }
        }
      }
    },

    setPermissionMode: (mode) => {
      set((state) => {
        state.permissionMode = mode;
        // 计划模式与侧栏「计划」进度状态对齐
        state.planModeEnabled = mode === 'plan';
        if (mode !== 'plan') state.planApproved = false;
      });
      try {
        localStorage.setItem('crish_permission_mode', mode);
      } catch {
        /* ignore */
      }
    },

    renameSession: (sessionId, title) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) {
        sess.title = title.slice(0, 48) || sess.title;
      }
    }),

    createSession: (opts) => {
      const id =
        (opts?.id && String(opts.id).trim()) || `sess-${Date.now()}`;
      set((state) => {
        // 已存在则仅激活（定时 workflow 复用引擎 sessionId）
        const existing = state.sessions.find((s) => s.id === id);
        if (existing) {
          state.activeSessionId = id;
          if (opts?.title && existing.title === '新会话') {
            existing.title = opts.title;
          }
          return;
        }
        const projectId = getActiveProjectId();
        const defaultFolder = isDemoMode()
          ? '常规会话'
          : opts?.folder || projectId || GENERAL_FOLDER;
        const sess: SessionState = {
          id,
          title: opts?.title || '新会话',
          folder: defaultFolder,
          isPinned: false,
          isArchived: false,
          timestamp: '刚刚',
          messages: [],
        };
        state.sessions.unshift(sess);
        if (!state.folderOrder.includes(sess.folder)) {
          state.folderOrder.unshift(sess.folder);
        }
        state.activeSessionId = id;
      });
      return id;
    },

    pinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = true;
    }),

    unpinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = false;
    }),

    archiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = true;
    }),

    unarchiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = false;
    }),

    branchSession: (sessionId, newTitle) => set((state) => {
      const original = state.sessions.find((s) => s.id === sessionId);
      if (!original) return;

      const newSess: SessionState = {
        id: `sess-branch-${Date.now()}`,
        title: newTitle,
        folder: original.folder,
        isPinned: false,
        isArchived: false,
        branchParentId: sessionId,
        timestamp: '刚刚',
        messages: original.messages ? JSON.parse(JSON.stringify(original.messages)) : [],
      };
      // 分叉会话紧插在原会话之后
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      state.sessions.splice(idx + 1, 0, newSess);
      state.activeSessionId = newSess.id; // 自动聚焦新分叉
    }),

    moveSessionRealtime: (sessionId, targetSessionId, targetFolder, isPinned) => set((state) => {
      const sessIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessIdx === -1) return;

      const [sess] = state.sessions.splice(sessIdx, 1);
      sess.isPinned = isPinned;
      sess.folder = targetFolder;

      if (targetSessionId) {
        const tIdx = state.sessions.findIndex((s) => s.id === targetSessionId);
        if (tIdx !== -1) {
          state.sessions.splice(tIdx, 0, sess);
        } else {
          state.sessions.push(sess);
        }
      } else {
        state.sessions.push(sess);
      }
    }),

    moveFolderRealtime: (folderName, targetFolderName) => set((state) => {
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

    pinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = true;
        }
      });
    }),

    unpinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = false;
        }
      });
    }),
  };
}
