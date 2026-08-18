/**
 * useAgentPanel — 子 Agent 面板流式 hook（AgentCard / InlineAgentPanel 唯一入口）。
 *
 * ## 边界（与 useChatStream / chat-stream/ 互斥）
 * | 表面 | 模块 | 消费者 |
 * |------|------|--------|
 * | **主对话** SSE/daemon 流 | `hooks/chat-stream/*`（门面 `useChatStream`） | ChatCard / Composer |
 * | **子 Agent 面板** | **本文件** `useAgentPanel` | AgentCard / InlineAgentPanel |
 *
 * 禁止：主对话 import 本 hook；子 Agent 面板 import `chat-stream/` 的 stop/send。
 * 共享点：`api/streamStop`（L2/L3 wire + markStreamingActive）、`StreamCancelFn`、
 * store actions。两 UI hook 保留各自 finalize partials。
 *
 * ## Stop 语义（与主对话同轨同名，R9 命名对齐）
 * - `handleStopGeneration` = L2 cooperative_stop
 * - `handleForceCancelGeneration` = L3 force_cancel
 * - wire：`dispatchStreamStopCancel` → live StreamCancelFn XOR runId→root（勿双发）
 * - 与主对话 `chat-stream/` 同名同语义；两 UI hook 保留各自 finalize partials（见上）
 *
 * ## 覆盖
 * - streamCollaboratorRun（thinking → chunks → toolCalls）
 * - handleSend / follow-up
 * - isStreaming / isComplete / stopping
 * - daemon 状态轮询（useDaemonSync=true）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../store/sessionStore';
import type {
  SessionMessage,
  FileDiff,
  MessageToolCall,
} from '../store/types';
import type { MessageToolApprovalMeta } from '../store/types';
import {
  sendToSubagent,
  streamCollaboratorRun,
  getSubagentStatus,
} from '../api/subagentApi';
import {
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../api/toolFeedback';
import { publishToolDiffs } from '../api/publishToolDiffs';
import type { StreamCancelFn } from '../api/chatBridge';
import {
  dispatchStreamStopCancel,
  markStreamingActive,
} from '../api/streamStop';
import { getCompositionRoot } from '../app/compositionRoot';

export interface UseAgentPanelOptions {
  parentSessionId: string;
  agentId: string;
  isRunning: boolean;
  /** AgentCard=true, InlineAgentPanel=false */
  useDaemonSync?: boolean;
}

export interface UseAgentPanelReturn {
  /** 默认 Stop = L2 cooperative_stop（单击） */
  handleStopGeneration: (summary?: string) => void;
  /** 强制取消 = L3 force_cancel（Shift+点击 / 长按，二次确认后） */
  handleForceCancelGeneration: (summary?: string) => void;
  handleSend: (text: string) => Promise<void>;
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

export function useAgentPanel(
  options: UseAgentPanelOptions
): UseAgentPanelReturn {
  const { parentSessionId, agentId, useDaemonSync } = options;

  const isRunningRef = useRef(options.isRunning);
  isRunningRef.current = options.isRunning;

  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState('');
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>(
    {}
  );
  const onToggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  }, []);

  const epochRef = useRef(0);
  /** follow-up stream cancel；支持 L2/L3 mode（streamViaEngine → StreamCancelFn） */
  const cancelRef = useRef<null | StreamCancelFn>(null);
  const localRunIdRef = useRef<string | null>(null);
  const cooldownRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const patchSessionAgent = useSessionStore((s) => s.patchSessionAgent);
  const appendSessionAgentMessage = useSessionStore(
    (s) => s.appendSessionAgentMessage
  );
  const patchSessionAgentMessage = useSessionStore(
    (s) => s.patchSessionAgentMessage
  );
  const finalizeAgentMessages = useSessionStore((s) => s.finalizeAgentMessages);

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
    // 命令式读：compositionRoot.session（= session facade / layout alias）
    const state = getCompositionRoot().session.getState();
    const sess =
      state.sessionsById[parentSessionId] ||
      state.sessions.find((s) => s.id === parentSessionId);
    const ag = sess?.agents?.find((a) => a.id === agentId);
    return ag?.subagentRunId ?? null;
  }, [parentSessionId, agentId]);

  // T-E 步骤 3（A1）：流式 patch 走 patchSessionAgentMessage action（raw setState 清零）
  const buildPatchAsst = useCallback(
    (asstId: string) => (fn: (m: SessionMessage) => void) => {
      if (!guard()) return;
      patchSessionAgentMessage(parentSessionId, agentId, asstId, fn);
    },
    [parentSessionId, agentId, patchSessionAgentMessage, guard]
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
        onToolStart: (
          toolId: string,
          name: string,
          args: string,
          explanation?: string
        ) =>
          pa((m) => {
            if (!m.toolCalls) m.toolCalls = [];
            if (!m.blocks) m.blocks = [];
            if (!m.toolCalls.some((t) => t.id === toolId)) {
              m.toolCalls.push({
                id: toolId,
                name,
                arguments: args,
                ...(explanation !== undefined ? { explanation } : {}),
                status: 'running',
              });
              m.blocks.push({ type: 'tool_call', id: toolId });
            }
          }),
        onToolSuccess: (
          toolId: string,
          output?: string | null,
          diffs?: FileDiff[]
        ) => {
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
          approvalMeta?: MessageToolApprovalMeta
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
              const entry: MessageToolCall = {
                id: toolId,
                name,
                arguments: args,
                explanation,
                status: 'pending_approval',
              };
              if (approvalMeta) entry.approvalMeta = approvalMeta;
              m.toolCalls.push(entry);
              if (
                !m.blocks.some((b) => b.type === 'tool_call' && b.id === toolId)
              ) {
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
            ...(localRunIdRef.current
              ? { subagentRunId: localRunIdRef.current }
              : {}),
          });
          cancelRef.current = null;
          onComplete?.();
        },
      } as const;
    },
    [parentSessionId, agentId, patchSessionAgent, buildPatchAsst, guard]
  );

  const finalizeInFlight = useCallback(() => {
    // T-E 步骤 3（A2）：multi-message finalize 走 finalizeAgentMessages action
    finalizeAgentMessages(parentSessionId, agentId);
  }, [parentSessionId, agentId, finalizeAgentMessages]);

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
      // streamViaEngine 返回 StreamCancelFn；subagentApi 签名仍为 () => void
      cancelRef.current = streamCollaboratorRun(
        text,
        agentId,
        buildStreamCallbacks(asstId, onStreamDone)
      ) as StreamCancelFn;
    },
    [
      parentSessionId,
      agentId,
      patchSessionAgent,
      appendSessionAgentMessage,
      buildStreamCallbacks,
    ]
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
    [
      parentSessionId,
      agentId,
      sending,
      stopping,
      appendSessionAgentMessage,
      startFollowUp,
      getSubagentRunId,
    ]
  );

  /**
   * 停止子 agent：默认 L2 cooperative；force=true 时 L3。
   * UI 默认 Stop → handleStopGeneration()；强制取消 → handleForceCancelGeneration()（ComposerField 二次确认）。
   *
   * Wire：shared `dispatchStreamStopCancel`（live StreamCancelFn XOR runId→root）。
   * Agent partials：epoch / stopping / patchSessionAgent / cooldown。
   */
  const finalizeAgentStop = useCallback(
    (force: boolean, summary?: string) => {
      if (stopping) return;
      setStopping(true);
      epochRef.current += 1;
      const cancel = cancelRef.current;
      cancelRef.current = null;
      markStreamingActive(false);
      dispatchStreamStopCancel({
        force,
        cancel,
        // live cancel already wires L2/L3; only pass runId when no cancel handle
        runId: cancel ? null : getSubagentRunId(),
        sessionId: parentSessionId,
        reasonCooperative: 'ui-agent-stop',
        reasonForce: 'ui-agent-force-cancel',
      });
      finalizeInFlight();
      patchSessionAgent(parentSessionId, agentId, {
        status: 'stopped',
        summary: summary || (force ? '已强制取消' : '已停止'),
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
    [
      parentSessionId,
      agentId,
      stopping,
      finalizeInFlight,
      patchSessionAgent,
      getSubagentRunId,
    ]
  );

  /** 默认 Stop = L2 cooperative_stop */
  const handleStopGeneration = useCallback(
    (summary?: string) => {
      finalizeAgentStop(false, summary);
    },
    [finalizeAgentStop]
  );

  /** 强制取消 = L3 force_cancel（UI 应二次确认） */
  const handleForceCancelGeneration = useCallback(
    (summary?: string) => {
      finalizeAgentStop(true, summary);
    },
    [finalizeAgentStop]
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
          const state = getCompositionRoot().session.getState();
          const sess =
            state.sessionsById[parentSessionId] ||
            state.sessions.find((s) => s.id === parentSessionId);
          if (!sess) return;
          const live = sess.agents?.find((a) => a.id === agentId);
          if (!live || live.status !== 'running') return;
          if (
            /complete|success|failed|cancel|error|stopp?ed|abort/i.test(
              st.status
            )
          ) {
            const raw = String(st.status);
            const nextStatus: 'completed' | 'failed' | 'stopped' =
              /cancel|stopp?ed|abort/i.test(raw)
                ? 'stopped'
                : /fail|error/i.test(raw)
                  ? 'failed'
                  : 'completed';
            const summaryText =
              live.summary ||
              st.latestError ||
              st.progress ||
              '上次会话中断，协作 agent 未完成';
            patchSessionAgent(sess.id, agentId, {
              status: nextStatus,
              endedAt: Date.now(),
              ...(summaryText !== undefined ? { summary: summaryText } : {}),
            });
          }
        }
      } catch {
        /* ignore */
      }
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
    handleStopGeneration,
    handleForceCancelGeneration,
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
