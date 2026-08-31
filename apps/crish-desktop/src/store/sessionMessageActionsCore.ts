/**
 * 会话消息 actions 核心（从 sessionMessageActions 拆分）。
 *
 * 负责消息增删 / 文本与思考更新 / 撤回与时间线截断 / 审批响应等基础动作。
 * 工具调用 / 状态 / pinned / 缓存度量等见 sessionMessageActionsTools。
 * 纯结构性拆分，逻辑与原实现一致。
 */

import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import { nowIsoTimestamp } from '../api/sessionTime';
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
        upsertMessageById(sess.messages, newMsg);
        const ts =
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp)
            ? new Date(message.timestamp).toISOString()
            : nowIsoTimestamp();
        sess.timestamp = ts;
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
        const lastBlock = msg.blocks[msg.blocks.length - 1];
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content = segment;
        } else if (segment.length > 0) {
          msg.blocks.push({ type: 'text' as const, content: segment });
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    updateMessageThinking: (sessionId, messageId, thinking) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (hit.message.thinking === thinking) return;
        hit.message.thinking = thinking;
        rebindSessionById(state, sessionId, hit.session);
      }),
  };
}
