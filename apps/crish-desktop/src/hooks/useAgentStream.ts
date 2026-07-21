/**
 * 统一 Agent 面板 hook：合并 AgentCard 与 InlineAgentPanel 的流式处理与状态轮询逻辑。
 *
 * 覆盖：
 * - streamCollaboratorRun 回调处理（thinking -> chunks -> toolCalls 组装）
 * - handleStop 停止流程
 * - handleSend send / follow-up 处理
 * - 流状态管理（isStreaming / isComplete / stopping）
 * - daemon 状态轮询（useDaemonSync=true 时自动启动）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { SessionMessage, FileDiff } from '../store/layoutStore';
import { sendToSubagent, streamCollaboratorRun, getSubagentStatus } from '../api/subagentApi';
import { resolveToolDiffs, sanitizeToolDisplayOutput } from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';

export interface UseAgentPanelOptions {
  parentSessionId: string;
  agentId: string;
  isRunning: boolean;
  /** AgentCard=true, InlineAgentPanel=false */
  useDaemonSync?: boolean;
}

export interface UseAgentStreamOptions extends UseAgentPanelOptions {
  /** @deprecated derived from store automatically */
  subagentRunId?: string | null;
}

export interface UseAgentPanelReturn {
  handleSend: (text: string) => Promise<void>;
  handleStop: (summary?: string) => void;
  incrementEpoch: () => void;
  sending: boolean;
  stopping: boolean;
  sendError: string;
  setSendError: (err: string) => void;
  isStreaming: boolean;
  isComplete: boolean;
  /** daemon 轮询（AgentCard 专用），返回 cleanup 函数 */
  startStatusSync: () => () => void;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
}

export function useAgentPanel(options: UseAgentPanelOptions): UseAgentPanelReturn {
  const { parentSessionId, agentId, useDaemonSync } = options;

  const isRunningRef = useRef(options.isRunning);
  isRunningRef.current = options.isRunning;

  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState('');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const onToggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  }, []);

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

  const getSubagentRunId = useCallback((): string | null => {
    if (!parentSessionId || !agentId) return null;
    const state = useLayoutStore.getState();
    const sess =
      state.sessionsById[parentSessionId] ||
      state.sessions.find((s) => s.id === parentSessionId);
    const ag = sess?.agents?.find((a) => a.id === agentId);
    return ag?.subagentRunId ?? null;
  }, [parentSessionId, agentId]);

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

  const handleSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending || stopping) return;
      const capturedEpoch = epochRef.current;
      setSendError('');
      setSending(true);
      const isRunning = isRunningRef.current;
      const subagentRunId = getSubagentRunId();
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
    [parentSessionId, agentId, sending, stopping, appendSessionAgentMessage, startFollowUp, getSubagentRunId],
  );

  const handleStop = useCallback(
    (summary?: string) => {
      if (stopping) return;
      setStopping(true);
      epochRef.current += 1;
      cancelRef.current?.();
      cancelRef.current = null;
      finalizeInFlight();
      const runId = getSubagentRunId();
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
    [parentSessionId, agentId, stopping, finalizeInFlight, patchSessionAgent, getSubagentRunId],
  );

  const startStatusSync = useCallback(() => {
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const runId = getSubagentRunId();
        if (!runId) return;
        const st = await getSubagentStatus(runId);
        if (!st || cancelled) return;
        if (st.status && st.status !== 'running' && st.status !== 'unknown') {
          const state = useLayoutStore.getState();
          const sess =
            state.sessionsById[parentSessionId] ||
            state.sessions.find((s) => s.id === parentSessionId);
          if (!sess) return;
          const live = sess.agents?.find((a) => a.id === agentId);
          if (!live || live.status !== 'running') return;
          if (/complete|success|failed|cancel|error|stopp?ed|abort/i.test(st.status)) {
            const raw = String(st.status);
            const nextStatus: 'completed' | 'failed' | 'stopped' = /cancel|stopp?ed|abort/i.test(raw)
              ? 'stopped'
              : /fail|error/i.test(raw)
                ? 'failed'
                : 'completed';
            patchSessionAgent(sess.id, agentId, {
              status: nextStatus,
              endedAt: Date.now(),
              summary:
                live.summary ||
                st.latestError ||
                st.progress ||
                (nextStatus === 'stopped' ? '已停止' : undefined),
            });
          }
        }
      } catch { /* ignore */ }
    };
    void poll();
    const intervalId = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [parentSessionId, agentId, patchSessionAgent, getSubagentRunId]);

  useEffect(() => {
    if (!useDaemonSync) return;
    return startStatusSync();
  }, [useDaemonSync, startStatusSync]);

  const isStreaming = sending || stopping || options.isRunning;
  const isComplete = !options.isRunning && !sending && !stopping;

  return {
    handleSend,
    handleStop,
    incrementEpoch,
    sending,
    stopping,
    sendError,
    setSendError,
    isStreaming,
    isComplete,
    startStatusSync,
    expandedTools,
    onToggleTool,
  };
}

export const useAgentStream: (options: UseAgentStreamOptions) => UseAgentPanelReturn = useAgentPanel;

async function cancelDaemonRun(runId: string): Promise<void> {
  try {
    const { getDesktopDaemonClient } = await import('../api/daemonClient');
    await getDesktopDaemonClient().send({ type: 'cancel-run', runId });
  } catch {
    /* ignore */
  }
}
