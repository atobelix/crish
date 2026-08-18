/**
 * 会话消息 actions 工具/状态/pinned/缓存（从 sessionMessageActions 拆分）。
 *
 * 负责工具调用增改、消息状态机、pinned、引擎 runId、时间线归一、
 * 工具补丁、缓存度量、本地工具卡状态、批量审批。基础消息动作见
 * sessionMessageActionsCore。纯结构性拆分，逻辑与原实现一致。
 */

import { MAX_MESSAGES_PER_SESSION } from '@crish/shared-utils/browser';
import type { MessageToolCall } from './types';
import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import { validateStatusTransition } from '../utils/StatusTransitionGuard';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import {
  applyMessageToolCallPatch,
  getMessageById,
  getSessionMessage,
  sanitizeToolCallUpdates,
  toolCallPatchHasChanges,
} from './sessionSharedHelpers';
import { normalizeAssistantTimeline } from '../api/toolPresentation';
import type { MessageCacheState } from '@crish/shared-types';

/** 工具/状态/pinned/缓存类 actions 子集 */
export function createSessionMessageActionsTools<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'addMessageToolCall'
  | 'updateMessageToolCall'
  | 'setSessionMessageStatus'
  | 'pinMessage'
  | 'unpinMessage'
  | 'setEngineLastRunId'
  | 'updateMessageTimeline'
  | 'applyToolCallPatches'
  | 'setMessageCacheMetrics'
  | 'markToolCallLocalStatus'
  | 'batchRespondToApproval'
> {
  return {
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

        const existing = msg.toolCalls.find((t) => t.id === toolCall.id);
        if (existing) {
          mergeInto(existing);
          rebindSessionById(state, sessionId, hit.session);
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
        rebindSessionById(state, sessionId, hit.session);
      }),

    updateMessageToolCall: (sessionId, messageId, toolCallId, updates) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        const msg = hit.message;
        if (!msg.toolCalls) return;
        const tc = msg.toolCalls.find((t) => t.id === toolCallId);
        if (!tc) return;
        const effective = sanitizeToolCallUpdates(tc, updates);
        if (!toolCallPatchHasChanges(tc, effective)) return;
        applyMessageToolCallPatch(tc, effective);
        rebindSessionById(state, sessionId, hit.session);
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
        if (
          hit.message.status === status &&
          (thinkingTime === undefined ||
            hit.message.thinkingTime === thinkingTime) &&
          !opts?.errorDetail
        ) {
          return;
        }
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
        if (opts?.errorDetail) {
          hit.message.errorDetail = opts.errorDetail;
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    pinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!getMessageById(sess.messages, messageId)) return;
        if (!sess.pinnedMessageIds) sess.pinnedMessageIds = [];
        if (
          !sess.pinnedMessageIds.includes(messageId) &&
          sess.pinnedMessageIds.length < MAX_MESSAGES_PER_SESSION
        ) {
          sess.pinnedMessageIds.push(messageId);
          rebindSessionById(state, sessionId, sess);
        }
      }),

    unpinMessage: (sessionId, messageId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess?.pinnedMessageIds?.length) return;
        const next = sess.pinnedMessageIds.filter((id) => id !== messageId);
        if (next.length === sess.pinnedMessageIds.length) return;
        sess.pinnedMessageIds = next;
        if (sess.pinnedMessageIds.length === 0) delete sess.pinnedMessageIds;
        rebindSessionById(state, sessionId, sess);
      }),

    // ── 事件写入收敛（T-E 步骤 3）──────────────

    setEngineLastRunId: (sessionId, runId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (sess.engineLastRunId === runId) return;
        sess.engineLastRunId = runId;
        rebindSessionById(state, sessionId, sess);
      }),

    updateMessageTimeline: (sessionId, messageId) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit) return;
        if (hit.message.sender !== 'assistant') return;
        const n = normalizeAssistantTimeline({ ...hit.message });
        hit.message.blocks = n.blocks;
        hit.message.toolCalls = n.toolCalls;
        rebindSessionById(state, sessionId, hit.session);
      }),

    applyToolCallPatches: (sessionId, messageId, patches) =>
      set((state) => {
        const hit = getSessionMessage(state, sessionId, messageId);
        if (!hit?.message.toolCalls) return;
        if (!patches || patches.length === 0) return;
        for (const p of patches) {
          const tc = hit.message.toolCalls.find((t) => t.id === p.id);
          if (!tc) continue;
          tc.status = p.status;
          if (p.output !== undefined) tc.output = p.output;
        }
        rebindSessionById(state, sessionId, hit.session);
      }),

    setMessageCacheMetrics: (sessionId, messageId, metrics) =>
      set((state) => {
        // metrics 为 null/空时不写（P6 C15：store 保持无字段，渲染层隐藏）
        if (!metrics || typeof metrics !== 'object') return;
        const sess = getSessionForWrite(state, sessionId);
        if (!sess?.messages) return;
        let target = messageId
          ? sess.messages.find((m) => m.id === messageId)
          : undefined;
        if (!target) {
          // 载荷缺 id 兜底：末条 status === 'processing' 的 assistant 消息
          for (let i = sess.messages.length - 1; i >= 0; i--) {
            const m = sess.messages[i];
            if (!m) continue;
            if (m.sender === 'assistant' && m.status === 'processing') {
              target = m;
              break;
            }
          }
        }
        if (!target) return;
        const cacheState: MessageCacheState = {
          metrics,
          source: 'engine-message-end',
        };
        target.cacheMetrics = cacheState;
        rebindSessionById(state, sessionId, sess);
      }),

    markToolCallLocalStatus: (toolCallId, status, output, scope) =>
      set((state) => {
        if (!toolCallId) return;
        const sessions = scope?.sessionId
          ? state.sessions.filter((s) => s.id === scope.sessionId)
          : scope?.runId
            ? state.sessions.filter(
                (s) => s.engineLastRunId === scope.runId || s.id === scope.runId
              )
            : state.sessions;
        for (const s of sessions) {
          // getSessionForWrite + rebind：经 sessions[] canonical 写，避免
          // immer fork 陷阱（sessionsById 持旧引用）——原组件 raw setState
          // 有该陷阱，迁入 action 后内建索引保障（README:130-133）
          const sess = getSessionForWrite(state, s.id);
          if (!sess) continue;
          let touched = false;
          // agentId scope 命中：主消息域不扫（「只扫 scope 内」严格语义）
          if (!scope?.agentId) {
            for (const m of sess.messages || []) {
              const tc = m.toolCalls?.find((t) => t.id === toolCallId);
              if (!tc) continue;
              // 终态工具卡不回退 running（与 sanitizeToolCallUpdates 同语义守卫）
              if (
                status === 'running' &&
                (tc.status === 'success' || tc.status === 'error')
              ) {
                continue;
              }
              tc.status = status;
              tc.output = output;
              touched = true;
            }
          }
          for (const ag of sess.agents || []) {
            if (scope?.agentId && ag.id !== scope.agentId) continue;
            for (const m of ag.messages || []) {
              const tc = m.toolCalls?.find((t) => t.id === toolCallId);
              if (!tc) continue;
              if (
                status === 'running' &&
                (tc.status === 'success' || tc.status === 'error')
              ) {
                continue;
              }
              tc.status = status;
              tc.output = output;
              touched = true;
            }
          }
          if (touched) rebindSessionById(state, s.id, sess);
        }
      }),

    batchRespondToApproval: (decisions) =>
      set((state) => {
        if (!decisions?.length) return;
        for (const d of decisions) {
          const hit = getSessionMessage(state, d.sessionId, d.messageId);
          if (!hit?.message.toolCalls) continue;
          const tc = hit.message.toolCalls.find((t) => t.id === d.toolCallId);
          if (!tc) continue;
          if (tc.approvalDecision !== d.decision) {
            tc.approvalDecision = d.decision;
            rebindSessionById(state, d.sessionId, hit.session);
          }
        }
      }),
  };
}
