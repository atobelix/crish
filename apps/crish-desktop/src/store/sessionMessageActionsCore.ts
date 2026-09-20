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
            const targetMsg = sess.messages[idx];
            const prevMessages = sess.messages.slice();
            const prevPinned = sess.pinnedMessageIds
              ? sess.pinnedMessageIds.slice()
              : undefined;

            // S4.4：精确识别被撤回节点（目标 assistant / user 及其派生工具回执节点）
            const toRemove = new Set<string>([messageId]);
            const toolCallIds = new Set((targetMsg?.toolCalls || []).map((tc) => tc.id));
            if (toolCallIds.size > 0) {
              for (const m of prevMessages) {
                if (m.toolCallResults?.some((r) => toolCallIds.has(r.id))) {
                  toRemove.add(m.id);
                }
              }
            }

            // 收集被撤回消息影响的文件路径（轻量：仅取 toolCalls[].diffs[].filePath）
            const pathSet = new Set<string>();
            for (const m of prevMessages) {
              if (toRemove.has(m.id)) {
                for (const tc of m.toolCalls || []) {
                  for (const d of tc.diffs || []) {
                    if (d.filePath) pathSet.add(d.filePath);
                  }
                }
              }
            }

            // 严禁截断时间线：仅精确摘除目标节点及其派生节点，后续排队追问与后续对话完整保留
            sess.messages = sess.messages.filter((m) => !toRemove.has(m.id));

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
            // 被撤回消息对象失效广播（仅失效被摘除的节点集合）
            invalidateEditObjects([...toRemove], 'withdraw');
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
        const rawSegment = text.length >= offset ? text.slice(offset) : text;
        const segment =
          offset > 0 ? rawSegment.replace(/^\n+/, '') : rawSegment;
        /**
         * 【双重物理界标隔离】定位可承接当前段落的最新 text 块时，
         * 必须确保该正文块位于「最后一个工具块」**与**「最后一个思考块」之后。
         *
         * 历史缺陷：仅以 `lastToolIdx` 为界标，于是
         *   正文 1 → 思考 2 → 正文 2
         * 这种「无工具 + 多轮思考交错」场景下，倒序查找会命中思考 2 之前的正文 1，
         * 把正文 2 的内容追加合并进正文 1，中间的 thought 被挤到末尾或彻底错乱。
         */
        const blockTypes = msg.blocks.map((b) => b.type);
        const lastToolIdx = blockTypes.lastIndexOf('tool_call');
        const lastThoughtIdx = blockTypes.lastIndexOf('thought');
        const lastProcessDelimiterIdx = Math.max(lastToolIdx, lastThoughtIdx);
        let targetTextIdx = -1;
        for (let i = msg.blocks.length - 1; i >= 0; i--) {
          if (msg.blocks[i]?.type === 'text') {
            if (lastProcessDelimiterIdx === -1 || i > lastProcessDelimiterIdx) {
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

        const cleanTurn =
          typeof turnIndex === 'number' && Number.isFinite(turnIndex)
            ? Math.max(0, Math.floor(turnIndex))
            : 0;
        const thoughtKey = `thought-turn-${cleanTurn}`;

        /**
         * 零副作用短路（既有契约；41020bc97 重写本函数时误删，此处回归）。
         *
         * 同字符串重复调用不得替换状态树：流式重复 chunk 与重复渲染会高频命中，
         * 且因 durationMs 依赖 Date.now()，immer 的引用相等永远无法自动短路，
         * 每次命中都会 produce 出一棵全新的消息树（无谓渲染放大源）。
         *
         * 轮次维度：仅当**本轮次**的思考文本与时间线块都已按该字符串物化时才短路。
         * 数组整体缺省（历史消息无轮次结构）视为无可维护结构，同样短路；
         * 数组存在但缺本轮次时不短路——否则跨轮次同文本会吞掉新一轮的思考块。
         */
        if (msg.thinking === thinking) {
          const turnMaterialized =
            msg.thinkingTurns?.some(
              (tt) => tt.turnIndex === cleanTurn && tt.content === thinking
            ) ?? true;
          const blockMaterialized =
            msg.blocks?.some(
              (b) =>
                b.type === 'thought' &&
                (b.id === thoughtKey || b.turnIndex === cleanTurn) &&
                b.content === thinking
            ) ?? true;
          if (turnMaterialized && blockMaterialized) return;
        }

        msg.thinking = thinking;
        if (!msg.blocks) msg.blocks = [];
        if (!msg.thinkingTurns) msg.thinkingTurns = [];

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
          /**
           * 【游标校准】开启新轮次思考的瞬间，把流式正文游标推进到当前累计正文长度。
           *
           * 历史缺陷：`streamTextOffset` 仅在 `addMessageToolCall` 时推进，
           * 导致无工具调用但多轮思考的场景下，后续正文的 `segment` 切片
           * 仍从旧游标起算，把新正文整段重复拼回上一个正文块。
           */
          const nextOffset = (msg.text || '').length;
          // 仅在确有累计正文时推进游标：无正文时保持状态不变，
          // 以维系「同字符串重复调用为零副作用」的既有契约。
          if (nextOffset > 0) msg.streamTextOffset = nextOffset;
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
