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
import type { SessionMessage } from '../store/types';
import {
  sendToSubagent,
  streamCollaboratorRun,
  getSubagentStatus,
} from '../api/subagentApi';
import type { StreamCancelFn } from '../api/chatBridge';
import { getCompositionRoot } from '../app/compositionRoot';
import {
  buildAgentStreamCallbacks,
  finalizeAgentStop,
} from './agentStreamCallbacks';

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

  // buildStreamCallbacks 委托给纯函数 buildAgentStreamCallbacks（依赖注入，
  // 见 agentStreamCallbacks.ts）；此处仅提供 ref 读写与 store action。
  const buildStreamCallbacks = useCallback(
    (asstId: string, onComplete?: () => void) =>
      buildAgentStreamCallbacks(asstId, onComplete, {
        parentSessionId,
        agentId,
        capturedEpoch: epochRef.current,
        getEpoch: () => epochRef.current,
        guard,
        buildPatchAsst,
        setLocalRunId: (runId: string | null) => {
          localRunIdRef.current = runId;
        },
        getLocalRunId: () => localRunIdRef.current,
        setCancel: (cancel: StreamCancelFn | null) => {
          cancelRef.current = cancel;
        },
        patchSessionAgent,
      }),
    [parentSessionId, agentId, guard, buildPatchAsst, patchSessionAgent]
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
   *
   * 委托给纯函数 finalizeAgentStop（依赖注入，见 agentStreamCallbacks.ts）。
   */
  const finalizeAgentStopCb = useCallback(
    (force: boolean, summary?: string) =>
      finalizeAgentStop(force, summary, {
        parentSessionId,
        agentId,
        isStopping: stopping,
        setStopping: (v: boolean) => setStopping(v),
        incrementEpoch: () => {
          epochRef.current += 1;
        },
        takeCancel: () => {
          const cancel = cancelRef.current;
          cancelRef.current = null;
          return cancel;
        },
        getSubagentRunId,
        finalizeInFlight,
        patchSessionAgent,
        isMounted: () => mountedRef.current,
        clearCooldown: () => {
          if (cooldownRef.current != null) {
            window.clearTimeout(cooldownRef.current);
            cooldownRef.current = null;
          }
        },
        setCooldown: (timer: number) => {
          cooldownRef.current = timer;
        },
      }),
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
      finalizeAgentStopCb(false, summary);
    },
    [finalizeAgentStopCb]
  );

  /** 强制取消 = L3 force_cancel（UI 应二次确认） */
  const handleForceCancelGeneration = useCallback(
    (summary?: string) => {
      finalizeAgentStopCb(true, summary);
    },
    [finalizeAgentStopCb]
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
