/**
 * 会话消息 actions 核心（从 sessionMessageActions 拆分）。
 *
 * 负责消息增删 / 文本与思考更新 / 撤回与时间线截断 / 审批响应等基础动作。
 * 工具调用 / 状态 / pinned / 缓存度量等见 sessionMessageActionsTools。
 * 纯结构性拆分，逻辑与原实现一致。
 */

import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import { saveMessageSnapshot } from './messageSnapshotsBridge';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import {
  getMessageById,
  getSessionMessage,
  maybeAutoTitleSession,
  truncateMessagesForAppend,
  upsertMessageById,
} from './sessionSharedHelpers';
import { invalidateEditObjects } from '../api/chat-bridge/editSessionConsumer';

/** 核心 actions 子集：消息增删 / 文本 / 思考 / 撤回 / 时间线截断 / 审批 */
export function createSessionMessageActionsCore<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'addMessage'
  | 'withdrawMessage'
  | 'applyTimelineTruncate'
  | 'respondToApproval'
  | 'updateMessageText'
  | 'updateMessageThinking'
> {
  return {
    addMessage: (_wsId, sessionId, message) =>
      set((state) => {
        // getSessionForWrite：经 sessions[] 写，避免 immer 只 fork sessionsById
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!sess.messages) sess.messages = [];

        // D1：timestamp 非有限数时补 Date.now()（order key 与 sess.timestamp 共用）
        const timestamp =
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp)
            ? message.timestamp
            : Date.now();
        const newMsg = {
          ...message,
          timestamp,
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

        // 同 id 已存在 → 原地 update，不 push（幂等 / 防 daemon 回显双写）
        const existing = getMessageById(sess.messages, newMsg.id);
        if (!existing) {
          truncateMessagesForAppend(
            sess.messages,
            MAX_MESSAGES_PER_SESSION,
            sess,
            sess.pinnedMessageIds
          );
        }
        // D1：不额外排序——upsertMessageById 已按 compareMessageOrder 有序插入
        upsertMessageById(sess.messages, newMsg);
        sess.timestamp = new Date(timestamp).toISOString();
        if (sess.timestampSource !== 'local') {
          sess.timestampSource = 'local';
        }
        if (message.sender === 'user') {
          maybeAutoTitleSession(state, sess);
        }
        rebindSessionById(state, sessionId, sess);
      }),

    withdrawMessage: (_wsId, sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (sess?.messages) {
          const idx = sess.messages.findIndex((m) => m.id === messageId);
          if (idx !== -1) {
            const prevMessages = sess.messages.slice();
            const prevPinned = sess.pinnedMessageIds
              ? sess.pinnedMessageIds.slice()
              : undefined;
            // 收集被撤回消息影响的文件路径（轻量：仅取 toolCalls[].diffs[].filePath）
            const pathSet = new Set<string>();
            for (const m of prevMessages.slice(idx)) {
              for (const tc of m.toolCalls || []) {
                for (const d of tc.diffs || []) {
                  if (d.filePath) pathSet.add(d.filePath);
                }
              }
            }
            sess.messages = sess.messages.slice(0, idx);
            if (sess.pinnedMessageIds?.length) {
              const keep = new Set(sess.messages.map((m) => m.id));
              sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) =>
                keep.has(id)
              );
              if (sess.pinnedMessageIds.length === 0)
                delete sess.pinnedMessageIds;
            }
            saveMessageSnapshot(
              sessionId,
              {
                sessionId,
                operation: 'withdraw',
                messages: prevMessages,
                ...(prevPinned !== undefined
                  ? { pinnedMessageIds: prevPinned }
                  : {}),
                diffFilePaths: [...pathSet],
                timestamp: Date.now(),
                description: '撤回消息',
              },
              { afterMessages: sess.messages }
            );
            rebindSessionById(state, sessionId, sess);
            // R2-b ⑥ gap2 补点：被撤回消息（含其后）对象失效广播（语义不变）
            invalidateEditObjects(
              prevMessages.slice(idx).map((m) => m.id),
              'withdraw'
            );
          }
        }
      }),

    // ── R1 撤回消费（统一输入流收敛战役）：timeline-truncate 投影重放 ──

    applyTimelineTruncate: (sessionId, boundarySeq, targetMessageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess?.messages) return;
        // 投影重放至 boundary：保留边界 user 节点（seq == boundary_seq，
        // 事件流只追加语义下其起始即边界），丢弃其后的全部节点
        // （`> boundary_seq` 部分）；撤回的呈现标记由展示投影层（V1）
        // 决定，本 action 只做投影截断。
        const idx = sess.messages.findIndex((m) => m.id === targetMessageId);
        if (idx === -1) return;
        if (idx + 1 >= sess.messages.length) return; // 无后续节点，无截断
        const prevMessages = sess.messages.slice();
        sess.messages = sess.messages.slice(0, idx + 1);
        // 后续节点的固定消息与 pinned 引用一并清理（对齐 withdrawMessage 语义）
        if (sess.pinnedMessageIds?.length) {
          const keep = new Set(sess.messages.map((m) => m.id));
          sess.pinnedMessageIds = sess.pinnedMessageIds.filter((id) =>
            keep.has(id)
          );
          if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
        }
        saveMessageSnapshot(
          sessionId,
          {
            sessionId,
            operation: 'timeline-truncate',
            messages: prevMessages,
            diffFilePaths: [],
            timestamp: Date.now(),
            description: `撤回截断至 boundary=${boundarySeq}（target=${targetMessageId}）`,
          },
          { afterMessages: sess.messages }
        );
        rebindSessionById(state, sessionId, sess);
      }),

    respondToApproval: (sessionId, messageId, toolCallId, decision) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        const tc = hit.message.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        if (tc.approvalDecision !== decision) {
          tc.approvalDecision = decision;
          rebindSessionById(state, sessionId, hit.session);
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
        if (msg.text === text && !htmlChanged) return;
        const prev = msg.text || '';
        msg.text = text;
        if (!msg.blocks) msg.blocks = [];
        let offset =
          typeof msg.streamTextOffset === 'number' ? msg.streamTextOffset : 0;
        if (
          text.length < offset ||
          (prev &&
            text.length < prev.length &&
            !prev.startsWith(text) &&
            !text.startsWith(prev.slice(0, Math.min(prev.length, text.length))))
        ) {
          offset = 0;
          msg.streamTextOffset = 0;
          msg.blocks = msg.blocks.filter((b) => b.type !== 'text');
        }
        const segment = text.length >= offset ? text.slice(offset) : text;
        // 定位是否已有可承接当前段落的最新 text 块（位于最后工具调用之后，或全块无工具）
        const lastToolIdx = msg.blocks.map((b) => b.type).lastIndexOf('tool_call');
        let targetTextIdx = -1;
        for (let i = msg.blocks.length - 1; i >= 0; i--) {
          if (msg.blocks[i]?.type === 'text') {
            if (lastToolIdx === -1 || i > lastToolIdx) {
              targetTextIdx = i;
            }
            break;
          }
        }

        const now = Date.now();
        if (targetTextIdx >= 0) {
          const target = msg.blocks[targetTextIdx]!;
          target.content = segment;
          if (target.startTime) {
            target.durationMs = Math.max(0, now - target.startTime);
          }
        } else if (segment.length > 0) {
          msg.blocks.push({
            type: 'text' as const,
            content: segment,
            startTime: now,
            durationMs: 0,
          });
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    updateMessageThinking: (sessionId, messageId, thinking, turnIndex = 0) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        msg.thinking = thinking;
        if (!msg.blocks) msg.blocks = [];
        if (!msg.thinkingTurns) msg.thinkingTurns = [];

        const cleanTurn =
          typeof turnIndex === 'number' && Number.isFinite(turnIndex)
            ? Math.max(0, Math.floor(turnIndex))
            : 0;
        const thoughtKey = `thought-turn-${cleanTurn}`;
        const now = Date.now();

        // 1. 同步维护 thinkingTurns（持久化与重水合权威源）
        const ttIdx = msg.thinkingTurns.findIndex(
          (tt) => tt.turnIndex === cleanTurn
        );
        if (ttIdx >= 0) {
          const existingTt = msg.thinkingTurns[ttIdx]!;
          msg.thinkingTurns[ttIdx] = {
            ...existingTt,
            content: thinking,
            isStreaming: true,
            durationMs: existingTt.durationMs ?? Math.max(0, now - (msg.timestamp || now)),
          };
        } else if (thinking.trim()) {
          msg.thinkingTurns.push({
            turnIndex: cleanTurn,
            content: thinking,
            id: thoughtKey,
            isStreaming: true,
            durationMs: 0,
          });
        }

        // 2. 严格按物理因果时间线维护 blocks
        const existingBlockIdx = msg.blocks.findIndex(
          (b) =>
            b.type === 'thought' &&
            (b.id === thoughtKey || b.turnIndex === cleanTurn)
        );
        if (existingBlockIdx >= 0) {
          if (!thinking.trim()) {
            msg.blocks.splice(existingBlockIdx, 1);
          } else {
            const eb = msg.blocks[existingBlockIdx]!;
            const sTime = eb.startTime || now;
            msg.blocks[existingBlockIdx] = {
              ...eb,
              content: thinking,
              turnIndex: cleanTurn,
              startTime: sTime,
              durationMs: Math.max(0, now - sTime),
              isStreaming: true,
            };
          }
        } else if (thinking.trim()) {
          const newBlock = {
            type: 'thought' as const,
            id: thoughtKey,
            content: thinking,
            turnIndex: cleanTurn,
            startTime: now,
            durationMs: 0,
            isStreaming: true,
          };
          // 物理时序保证：按真实发生时间追加到末端，严禁将新步骤思考逆向插入历史步骤的 text 之前
          const lastBlock = msg.blocks[msg.blocks.length - 1];
          if (lastBlock && lastBlock.type === 'text' && !lastBlock.content?.trim()) {
            msg.blocks.splice(msg.blocks.length - 1, 0, newBlock);
          } else {
            msg.blocks.push(newBlock);
          }
        }
        rebindSessionById(state, sessionId, hit.session);
      }),
  };
}
