import { subagentDeltaKey } from '../api/compositeSessionKeys';

import { MAX_MESSAGES_PER_AGENT } from '@crish/shared-utils/browser';
import { getSessionForWrite, rebindSessionById } from './sessionIndex';
import type {
  SessionActions,
  SessionStoreSlice,
  SessionImmerSet,
} from './sessionActions';
import type { SessionAgent, SessionState } from './types';
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
import {
  dualLatchStateMachine,
  scheduleDualRafClearStreams,
} from './dualLatchProtocol';
import { StreamValueBatcher } from '../api/streamTextBatcher';
import type { FinalSubagentSnapshot } from './sessionMessageActionsCore';

/**
 * 子代理运行期增量更新载荷（Stage 02 12 子代理并发防抖契约）
 */
export interface SubagentRuntimeDelta {
  readonly sessionId: string;
  readonly agentId: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly summary?: string;
  readonly status?: 'running' | 'completed' | 'failed' | 'stopped';
}

/**
 * 12 子代理并发增量节流器（48ms 窗口合并）：
 * 运行期仅向独立子代理分支刷写合并后的增量，严禁在每个子代理 token chunk 到达时克隆主消息数组。
 */
export class SubagentRuntimeBatcher {
  private readonly inner: StreamValueBatcher<SubagentRuntimeDelta>;

  constructor(
    onFlushDelta: (delta: SubagentRuntimeDelta) => void,
    options: {
      intervalMs?: number;
      setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
    } = {}
  ) {
    this.inner = new StreamValueBatcher<SubagentRuntimeDelta>(
      (_key, delta) => {
        onFlushDelta(delta);
      },
      {
        intervalMs: options.intervalMs ?? 48,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
        merge: (prev, next) => ({
          ...prev,
          ...next,
          text: next.text !== undefined ? next.text : prev.text,
          thinking: next.thinking !== undefined ? next.thinking : prev.thinking,
          summary: next.summary !== undefined ? next.summary : prev.summary,
          status: next.status !== undefined ? next.status : prev.status,
        }),
      }
    );
  }

  push(delta: SubagentRuntimeDelta): void {
    this.inner.push(subagentDeltaKey(delta.sessionId, delta.agentId), delta);
  }

  flushNow(): void {
    this.inner.flushNow();
  }

  reset(): void {
    this.inner.reset();
  }
}

/**
 * 从会话内子代理列表提取终态归档快照（`FinalSubagentSnapshot[]`），
 * 同时收集仅归属目标子代理的流式消息 ID 列表（供精确 `clearStreams(sessionId, finalizedMsgIds)` 回收）。
 */
export function buildFinalSubagentSnapshots(
  sessionId: string,
  agents: readonly SessionAgent[],
  targetAgentIds?: ReadonlySet<string>
): {
  readonly snapshots: FinalSubagentSnapshot[];
  readonly finalizedMessageIds: string[];
} {
  const snapshots: FinalSubagentSnapshot[] = [];
  const finalizedMessageIds: string[] = [];
  const now = Date.now();

  for (const ag of agents) {
    if (targetAgentIds && !targetAgentIds.has(ag.id)) continue;

    let finalText = ag.summary || '';
    let finalThinking: string | undefined;

    for (const m of ag.messages || []) {
      if (m.sender !== 'assistant') continue;
      finalizedMessageIds.push(m.id);
      const liveText = getStreamText(sessionId, m.id);
      const candidateText =
        liveText && (!m.text || liveText.length >= m.text.length)
          ? liveText
          : m.text || '';
      if (candidateText) {
        finalText = candidateText;
      }
      const liveThinking = getStreamThinking(sessionId, m.id) || m.thinking;
      if (liveThinking && liveThinking !== '正在处理…') {
        finalThinking = liveThinking;
      }
    }

    const mappedStatus: FinalSubagentSnapshot['status'] =
      ag.status === 'failed'
        ? 'error'
        : ag.status === 'stopped'
          ? 'cancelled'
          : 'completed';

    snapshots.push({
      id: ag.id,
      name: ag.displayLabel || ag.description || ag.mode || ag.id,
      role: ag.mode || 'subagent',
      status: mappedStatus,
      finalText,
      ...(finalThinking !== undefined ? { finalThinking } : {}),
      completedAt: ag.endedAt ?? now,
    });
  }

  return { snapshots, finalizedMessageIds };
}

/**
 * 将子代理终态快照原子归档至 `session.finalAgents` 并从运行期活跃列表中解绑已归档项。
 */
export function archiveFinalAgentsToSession(
  session: SessionState,
  snapshots: readonly FinalSubagentSnapshot[],
  removeArchivedFromActive = false
): FinalSubagentSnapshot[] {
  const carrier: { id: string; finalAgents?: FinalSubagentSnapshot[] } =
    session;
  const current = carrier.finalAgents ? carrier.finalAgents.slice() : [];
  const archivedIds = new Set<string>();

  for (const snap of snapshots) {
    archivedIds.add(snap.id);
    const idx = current.findIndex((item) => item.id === snap.id);
    if (idx >= 0) {
      current[idx] = snap;
    } else {
      current.push(snap);
    }
  }

  carrier.finalAgents = current;
  if (removeArchivedFromActive && Array.isArray(session.agents)) {
    session.agents = session.agents.filter((ag) => !archivedIds.has(ag.id));
  }
  return current;
}

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
        const normalizedStatus: SessionAgent['status'] =
          opts.status === 'failed'
            ? 'failed'
            : opts.status === 'stopped'
              ? 'stopped'
              : 'completed';
        ag.status = normalizedStatus;
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

            // 从 streamingStore 提取残余流式正文并合入持久化消息（语义自锁存）
            const liveText = getStreamText(sessionId, m.id);
            if (liveText && (!m.text || liveText.length > m.text.length)) {
              m.text = liveText;
            }
            const liveThinking = getStreamThinking(sessionId, m.id);
            if (liveThinking && !m.thinking) {
              m.thinking = liveThinking;
            }
            Reflect.deleteProperty(m, 'streamText');
            dualLatchStateMachine.markLatched(
              sessionId,
              m.id,
              (m.text || '').length
            );
          }
          for (const tc of m.toolCalls || []) {
            if (tc.status === 'running' || tc.status === 'pending_approval') {
              tc.status = 'error';
              tc.output =
                tc.output && tc.output !== '执行中…' ? tc.output : '已停止';
            }
          }
        }

        // 将当前子代理终态快照同步归档至会话 finalAgents
        const { snapshots } = buildFinalSubagentSnapshots(
          sessionId,
          [ag],
          new Set([agentId])
        );
        if (snapshots.length > 0) {
          archiveFinalAgentsToSession(sess, snapshots, false);
        }

        rebindSessionById(state, sessionId, sess);

        // 走 Dual-Latch 双帧物理交接后精确清理当前 Agent 关联的消息流，严禁调用 clearSession(sessionId)
        if (finalizedMsgIds.length > 0) {
          scheduleDualRafClearStreams(sessionId, finalizedMsgIds, clearStreams);
        }
      }),
  };
}
