import { MAX_MESSAGES_PER_AGENT } from '@crish/shared-utils/browser';
import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import {
  applyMessageToolCallPatch,
  applySessionAgentPatch,
  getMessageById,
  getSessionAgent,
  sanitizeToolCallUpdates,
  toolCallPatchHasChanges,
  truncateMessagesForAppend,
  upsertMessageById,
} from './sessionSharedHelpers';
import { applySubagentEventToMessages } from '../api/subagentTimeline';
import {
  clearStreams,
  getStreamText,
  getStreamThinking,
} from './streamingStore';

export function createSessionAgentActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<
  SessionActions,
  | 'upsertSessionAgent'
  | 'patchSessionAgent'
  | 'appendSessionAgentMessage'
  | 'patchAgentTool'
  | 'patchSessionAgentMessage'
  | 'applySubagentEventToAgent'
  | 'patchSessionAgentToolStatus'
  | 'finalizeAgentMessages'
> {
  return {
    upsertSessionAgent: (sessionId, agent) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        if (!sess.agents) sess.agents = [];
        const i = sess.agents.findIndex((a) => a.id === agent.id);
        if (i >= 0) {
          const existingAgent = sess.agents[i];
          if (!existingAgent) {
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
        rebindSessionById(state, sessionId, sess);
      }),

    patchSessionAgent: (sessionId, agentId, patch) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        applySessionAgentPatch(ag, patch);
        rebindSessionById(state, sessionId, sess);
      }),

    appendSessionAgentMessage: (sessionId, agentId, message) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        if (!ag.messages) ag.messages = [];
        // 同 id upsert，与主会话 addMessage 一致
        if (!getMessageById(ag.messages, message.id)) {
          truncateMessagesForAppend(
            ag.messages,
            MAX_MESSAGES_PER_AGENT,
            sess,
            undefined
          );
        }
        upsertMessageById(ag.messages, message);
        rebindSessionById(state, sessionId, sess);
      }),

    patchAgentTool: (sessionId, agentId, toolCallId, patch) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag?.messages) return;
        for (const msg of ag.messages) {
          if (!msg.toolCalls) continue;
          const tc = msg.toolCalls.find((t) => t.id === toolCallId);
          if (!tc) continue;
          const effective = sanitizeToolCallUpdates(tc, patch);
          if (!toolCallPatchHasChanges(tc, effective)) return;
          applyMessageToolCallPatch(tc, effective);
          rebindSessionById(state, sessionId, sess);
          return;
        }
      }),

    // ── 事件写入收敛（T-E 步骤 3：U2/A1/S2、U3/S3、A2 共用承载面）──

    patchSessionAgentMessage: (sessionId, agentId, messageId, patch) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        const m = ag?.messages?.find((x) => x.id === messageId);
        if (!m) return;
        patch(m);
        rebindSessionById(state, sessionId, sess);
      }),

    applySubagentEventToAgent: (sessionId, agentId, event) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        ag.messages = applySubagentEventToMessages(ag.messages || [], event);
        rebindSessionById(state, sessionId, sess);
      }),

    patchSessionAgentToolStatus: (sessionId, agentId, opts) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag) return;
        // wire 归一终态（completed/failed/stopped，mapSubagentEndStatus 同口径）
        ag.status = opts.status as 'completed' | 'failed' | 'stopped';
        if (opts.summary) ag.summary = opts.summary;
        ag.endedAt = Date.now();
        const summary = opts.summary || ag.summary || '';
        for (const m of ag.messages || []) {
          if (m.status === 'processing') m.status = 'completed';
        }
        const toolId = ag.parentToolCallId;
        if (toolId && sess?.messages) {
          for (const m of sess.messages) {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) continue;
            const st = String(opts.status || '');
            const failed = /fail|error/i.test(st);
            const stopped = /cancel|stopp?ed|abort/i.test(st);
            tc.status = failed || stopped ? 'error' : 'success';
            const body =
              summary.trim() ||
              (failed ? '协作未完成' : stopped ? '协作已停止' : '协作已完成');
            tc.output = body.length > 1200 ? body.slice(0, 1199) + '…' : body;
          }
        }
        rebindSessionById(state, sessionId, sess);
      }),

    finalizeAgentMessages: (sessionId, agentId) =>
      set((state) => {
        const sess = getSessionForWrite(state, sessionId);
        if (!sess) return;
        const ag = getSessionAgent(sess, agentId);
        if (!ag?.messages) return;

        const finalizedMsgIds: string[] = [];
        for (const m of ag.messages) {
          if (m.sender !== 'assistant') continue;
          finalizedMsgIds.push(m.id);
          if (m.status === 'processing') {
            m.status = 'completed';
            if (m.thinking === '正在处理…') m.thinking = '';

            // 关键补齐：从 streamingStore 提取残余流式正文并合入持久化消息
            const liveText = getStreamText(sessionId, m.id);
            if (liveText && (!m.text || liveText.length > m.text.length)) {
              m.text = liveText;
            }
            const liveThinking = getStreamThinking(sessionId, m.id);
            if (liveThinking && !m.thinking) {
              m.thinking = liveThinking;
            }
          }
          for (const tc of m.toolCalls || []) {
            if (tc.status === 'running' || tc.status === 'pending_approval') {
              tc.status = 'error';
              tc.output =
                tc.output && tc.output !== '执行中…' ? tc.output : '已停止';
            }
          }
        }
        rebindSessionById(state, sessionId, sess);

        // 精确清理当前 Agent 关联的消息流，绝不误伤同会话下其它 Agent 的并发流
        if (finalizedMsgIds.length > 0) {
          queueMicrotask(() => {
            clearStreams(sessionId, finalizedMsgIds);
          });
        }
      }),
  };
}
