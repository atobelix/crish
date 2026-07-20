/**
 * 共享 hook：提取 AgentCard.tsx 与 InlineAgentPanel.tsx 中 ~150 行重复的流式处理逻辑。
 *
 * 覆盖：
 * - streamCollaboratorRun 回调处理（thinking → chunks → toolCalls 组装）
 * - handleStop 停止流程
 * - handleSend send → follow-up 处理
 * - patchAsst 消息更新辅助函数
 * - finalizeInFlight 停止收尾
 * - 流状态管理（isStreaming / isComplete）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage, FileDiff } from '../store/layoutStore';
import { sendToSubagent, streamCollaboratorRun } from '../api/subagentApi';
import { resolveToolDiffs, sanitizeToolDisplayOutput } from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';

export interface UseAgentStreamOptions {
  parentSessionId: string;
  agentId: string;
  isRunning: boolean;
  subagentRunId?: string | null;
}

export function useAgentStream(options: UseAgentStreamOptions) {
  const { parentSessionId, agentId } = options;

  // 用 ref 持有频繁变化的 prop，避免 handleSend / buildStreamCallbacks 被频繁重建
  const isRunningRef = useRef(options.isRunning);
  isRunningRef.current = options.isRunning;
  const subagentRunIdRef = useRef(options.subagentRunId ?? null);
  subagentRunIdRef.current = options.subagentRunId ?? null;

  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState('');

  // -- 代数守卫：停止 / 切换 agent 后迟到回调不再写入 store --
  const epochRef = useRef(0);
  const cancelRef = useRef<null | (() => void)>(null);
  const localRunIdRef = useRef<string | null>(null);
  const cooldownRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const patchSessionAgent = useLayoutStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useLayoutStore((s) => s.appendSessionAgentMessage);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRef.current?.();
      cancelRef.current = null;
      if (cooldownRef.current != null) {
        window.clearTimeout(cooldownRef.current);
        cooldownRef.current = null;
      }
    };
  }, []);

  /** 递增代数 → 所有旧流的回调被静默忽略 */
  const incrementEpoch = useCallback(() => {
    epochRef.current += 1;
    cancelRef.current?.();
    cancelRef.current = null;
    setSending(false);
    setStopping(false);
    if (cooldownRef.current != null) {
      window.clearTimeout(cooldownRef.current);
      cooldownRef.current = null;
    }
  }, []);

  const guard = useCallback(() => mountedRef.current, []);

  /** 构造绑定到指定 assistant 消息的 patch 函数 */
  const buildPatchAsst = useCallback(
    (asstId: string) =>
      (fn: (m: SessionMessage) => void) => {
        if (!guard()) return;
        useLayoutStore.setState((state) => {
          const sess =
            state.sessionsById[parentSessionId] ||
            state.sessions.find((s) => s.id === parentSessionId);
          const ag = sess?.agents?.find((a) => a.id === agentId);
          const m = ag?.messages?.find((x) => x.id === asstId);
          if (m) fn(m);
        });
      },
    [parentSessionId, agentId],
  );

  /** 构造 streamCollaboratorRun 所需全套回调 */
  const buildStreamCallbacks = useCallback(
    (asstId: string, onComplete?: () => void) => {
      const capturedEpoch = epochRef.current;
      const valid = () => guard() && capturedEpoch === epochRef.current;
      const pa = buildPatchAsst(asstId);

      return {
        onRunMeta: ({ runId }: { runId: string }) => {
          if (!valid()) return;
          localRunIdRef.current = runId;
          patchSessionAgent(parentSessionId, agentId, {
            subagentRunId: runId,
            status: 'running',
          });
        },
        onThought: (t: string) =>
          pa((m) => {
            m.thinking = t;
          }),
        onChunk: (c: string) =>
          pa((m) => {
            m.text = c;
            if (m.thinking === '正在处理…') m.thinking = '';
          }),
        onToolStart: (toolId: string, name: string, args: string, explanation?: string) =>
          pa((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            if (!m.toolCalls.some((t) => t.id === toolId)) {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'running',
              });
              m.blocks.push({ type: 'tool_call', id: toolId });
            }
          }),
        onToolSuccess: (toolId: string, output?: string | null, diffs?: FileDiff[]) => {
          let resolved: FileDiff[] = [];
          pa((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) return;
            const displayOut = sanitizeToolDisplayOutput(output || '');
            resolved = resolveToolDiffs({
              name: tc.name || '',
              args: tc.arguments,
              output: displayOut,
              structuredDiffs: diffs,
            });
            tc.status = 'success';
            tc.output = displayOut || output || '完成';
            if (resolved.length) tc.diffs = resolved;
          });
          if (valid()) publishToolDiffs(resolved);
        },
        onToolError: (toolId: string, err?: string | null) =>
          pa((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (tc) {
              tc.status = 'error';
              tc.output = sanitizeToolDisplayOutput(err || '') || err || '失败';
            }
          }),
        onToolPendingApproval: (
          toolId: string,
          name: string,
          args: string,
          explanation: string,
          approvalMeta?: any,
        ) =>
          pa((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            const existing = m.toolCalls.find((t) => t.id === toolId);
            if (existing) {
              existing.status = 'pending_approval';
              existing.arguments = args || existing.arguments;
              if (explanation) existing.explanation = explanation;
              if (approvalMeta) existing.approvalMeta = approvalMeta;
            } else {
              const entry: Record<string, unknown> = {
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'pending_approval',
              };
              if (approvalMeta) entry.approvalMeta = approvalMeta;
              m.toolCalls.push(entry as any);
              if (!m.blocks.some((b) => b.type === 'tool_call' && b.id === toolId)) {
                m.blocks.push({ type: 'tool_call', id: toolId });
              }
            }
          }),
        onApprovalResolved: (toolId: string, decision: string) =>
          pa((m) => {
            const tc = m.toolCalls?.find((t) => t.id === toolId);
            if (!tc) return;
            if (decision === 'allow') {
              tc.status = 'running';
              tc.output = '执行中…';
            } else {
              tc.status = 'error';
              tc.output = '未获批准';
            }
          }),
        onSubagentEvent: () => {},
        onComplete: () => {
          if (!valid()) {
            cancelRef.current = null;
            onComplete?.();
            return;
          }
          pa((m) => {
            m.status = 'completed';
            if (m.thinking === '正在处理…') m.thinking = '';
          });
          patchSessionAgent(parentSessionId, agentId, {
            status: 'completed',
            endedAt: Date.now(),
            ...(localRunIdRef.current ? { subagentRunId: localRunIdRef.current } : {}),
          });
          cancelRef.current = null;
          onComplete?.();
        },
      } as const;
    },
    [parentSessionId, agentId, patchSessionAgent, buildPatchAsst],
  );

  /** 停止时收尾所有 in-flight assistant 消息与工具行 */
  const finalizeInFlight = useCallback(() => {
    useLayoutStore.setState((state) => {
      const sess =
        state.sessionsById[parentSessionId] ||
        state.sessions.find((s) => s.id === parentSessionId);
      const ag = sess?.agents?.find((a) => a.id === agentId);
      if (!ag?.messages) return;
      for (const m of ag.messages) {
        if (m.sender !== 'assistant') continue;
        if (m.status === 'processing') {
          m.status = 'completed';
          if (m.thinking === '正在处理…') m.thinking = '';
        }
        for (const tc of m.toolCalls || []) {
          if (tc.status === 'running' || tc.status === 'pending_approval') {
            tc.status = 'error';
            tc.output = tc.output && tc.output !== '执行中…' ? tc.output : '已停止';
          }
        }
      }
    });
  }, [parentSessionId, agentId]);

  /** 启动 follow-up 流 */
  const startFollowUp = useCallback(
    (text: string, asstId: string, onStreamDone?: () => void) => {
      cancelRef.current?.();
      localRunIdRef.current = null;
      patchSessionAgent(parentSessionId, agentId, { status: 'running' });
      appendSessionAgentMessage(parentSessionId, agentId, {
        id: asstId,
        sender: 'assistant',
        text: '',
        thinking: '正在处理…',
        timestamp: Date.now(),
        status: 'processing',
        toolCalls: [],
        blocks: [],
      });
      cancelRef.current = streamCollaboratorRun(
        text,
        agentId,
        buildStreamCallbacks(asstId, onStreamDone),
      );
    },
    [parentSessionId, agentId, patchSessionAgent, appendSessionAgentMessage, buildStreamCallbacks],
  );

  /** 发送消息或 steer 运行中 agent */
  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || stopping) return;
      const capturedEpoch = epochRef.current;
      setSendError('');
      setSending(true);
      const isRunning = isRunningRef.current;
      const subagentRunId = subagentRunIdRef.current;
      try {
        if (capturedEpoch !== epochRef.current) return;
        appendSessionAgentMessage(parentSessionId, agentId, {
          id: `u-${Date.now().toString(36)}`,
          sender: 'user',
          text: trimmed,
          timestamp: Date.now(),
          status: 'completed',
        });
        if (isRunning && subagentRunId) {
          const res = await sendToSubagent(subagentRunId, trimmed);
          // 发送后若代数已变 → 忽略响应（agent 已切换/停止）
          if (capturedEpoch !== epochRef.current) return;
          if (!res.ok || res.accepted === false) {
            setSendError(res.error ? res.error : '进行新一轮续聊…');
            startFollowUp(trimmed, `asst-${Date.now().toString(36)}`);
          }
        } else if (capturedEpoch === epochRef.current) {
          startFollowUp(trimmed, `asst-${Date.now().toString(36)}`);
        }
      } finally {
        if (capturedEpoch === epochRef.current) setSending(false);
      }
    },
    [parentSessionId, agentId, sending, stopping, appendSessionAgentMessage, startFollowUp],
  );

  /** 停止当前 run */
  const handleStop = useCallback(
    (summary?: string) => {
      if (stopping) return;
      setStopping(true);
      epochRef.current += 1;
      cancelRef.current?.();
      cancelRef.current = null;
      finalizeInFlight();
      const runId = subagentRunIdRef.current;
      if (runId) {
        void cancelDaemonRun(runId);
      }
      patchSessionAgent(parentSessionId, agentId, {
        status: 'stopped',
        summary: summary || '已停止',
        endedAt: Date.now(),
      });
      if (cooldownRef.current != null) {
        window.clearTimeout(cooldownRef.current);
      }
      cooldownRef.current = window.setTimeout(() => {
        cooldownRef.current = null;
        if (mountedRef.current) setStopping(false);
      }, 200);
    },
    [parentSessionId, agentId, stopping, finalizeInFlight, patchSessionAgent],
  );

  const isStreaming = sending || stopping || options.isRunning;
  const isComplete = !options.isRunning && !sending && !stopping;

  return {
    handleSend,
    handleStop,
    startFollowUp,
    buildPatchAsst,
    buildStreamCallbacks,
    finalizeInFlight,
    incrementEpoch,
    sending,
    setSending,
    stopping,
    sendError,
    setSendError,
    isStreaming,
    isComplete,
    patchSessionAgent,
    appendSessionAgentMessage,
  };
}

async function cancelDaemonRun(runId: string): Promise<void> {
  try {
    const { getDesktopDaemonClient } = await import('../api/daemonClient');
    await getDesktopDaemonClient().send({ type: 'cancel-run', runId });
  } catch {
    /* ignore */
  }
}
