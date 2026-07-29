import { useRef } from 'react';
import { useLayoutStore } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { streamAssistantResponseApi } from '../../api/chatApi';
import type { StreamRequestOptions } from '../../api/chatApi';
import {
  isShellToolName,
  resolveToolDiffs,
  sanitizeToolDisplayOutput,
} from '../../api/toolFeedback';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { normalizeAssistantTimeline } from '../../api/toolPresentation';
import { checkAndAlertSilentComplete } from '../../api/silentComplete';
import { recordStreamDiag } from '../../api/streamDiag';
import { applyUsageDelta, fetchRunSnapshotUsage } from '../../api/sessionEventHydrate';
import { applySubagentEventToMessages } from '../../api/subagentTimeline';
import { getActiveModelId } from '../../api/providerProfiles';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  streamBatchKey,
  streamToolBatchKey,
  isImmediateToolStatus,
} from '../../api/streamTextBatcher';
import type { StreamToolCallPatch } from '../../api/streamTextBatcher';
import { buildGoalRunTaskFields } from '../../api/goalModeController';
import {
  addTerminalLine,
  addTerminalLines,
  patchSession,
  syncTelemetryData,
} from '../../api/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  clearStream,
  getStreamText,
  getStreamTool,
  setStreamText,
} from '../../store/streamingStore';
import { generateMessageId } from '../../utils/generateMessageId';
import { streamRecovery } from '../../services/StreamRecovery';
import type { MessageToolApprovalMeta, MessageToolCall, SessionAgent } from '../../store/types';
import type { SessionMessage } from '../../store/layoutStore';
import type { UseChatStreamOptions, RunNotice } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import {
  resolveStreamSessionId,
  canStreamLocalSession,
  isLiveStreamRun,
  buildTerminalToolPatches,
  scheduleFinalMarkdownHtml,
  preloadPublishToolDiffs,
  publishToolDiffsLazy,
  commitStreamToSession,
  commitStreamToolsToSession,
  snapshotStreamTextToSession,
} from './helpers';
import {
  dispatchStreamStopCancel,
  markStreamingActive,
} from '../../api/streamStop';
import { useGoalMode } from './useGoalMode';

export function useStreamCallbacks(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  noticeHelpers: {
    pushRunNotice: (notice: RunNotice, ttlMs?: number) => void;
    dismissRunNotice: () => void;
  },
  queryHelpers: {
    wsId: string;
    setActiveDiffSource: (source: unknown) => void;
    upsertSessionAgent: (sessionId: string, agent: SessionAgent) => void;
  },
): {
  runStreamingAssistant: (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void;
  /** 默认 Stop = L2 cooperative */
  handleStopGeneration: () => void;
  /** 强制取消 = L3 force（UI 二次确认后调用） */
  handleForceCancelGeneration: () => void;
} {
  const { onShowToast } = options;
  const { wsId, setActiveDiffSource, upsertSessionAgent } = queryHelpers;
  const { pushRunNotice, dismissRunNotice } = noticeHelpers;
  const {
    streamManagerRef,
    textBatcherRef,
    thinkingBatcherRef,
    toolBatcherRef,
    renderBufferRef,
    openSidePanelOnceRef,
    flushStreamBatchers,
  } = refs;

  const { maybeContinueGoalMode, drainQueuedAfterComplete } = useGoalMode(
    streamManagerRef,
    onShowToast,
  );

  const generationMapRef = useRef<Map<string, number>>(new Map());

  const runStreamingAssistant = (
    input: string,
    userMsgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => {
    const sid = resolveStreamSessionId(
      sessionIdOverride,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) return;

    // W8-3：live stream 存在时禁止 hard replace/cancel。
    // 发送路径应走 useSlashSend follow_up 入队；此处 fail-closed 拒绝第二路 stream。
    const prevStream = streamManagerRef.current!.get(sid);
    if (prevStream) {
      try {
        const st = getCompositionRoot().layout.getState();
        const userMsg = getSessionById(sid)?.messages?.find(
          (m: SessionMessage) => m.id === userMsgId
        );
        if (userMsg?.sender === 'user' && userMsg.status === 'processing') {
          st.setSessionMessageStatus(sid, userMsgId, 'queued');
        }
      } catch {
        /* ignore */
      }
      console.warn(
        '[runStreamingAssistant] refuse start while stream live (L1 follow_up, no abort)',
        sid,
        userMsgId
      );
      return;
    }

    // 发送前固定 assistant clientMessageId（= message.id）：
    // 热路径 streamingStore / 终态 commit / run-task 下发 / hydrate rekey 同一键
    const assistantMsgId = generateMessageId('assistant');
    const store = getCompositionRoot().layout.getState();
    const toolNames: Record<string, string> = {};
    const startTime = Date.now();
    dismissRunNotice();
    let gotRealText = false;
    let localRunId: string | null = null;
    let runClosed = false;
    let streamedFullText = '';
    let finalHtmlScheduled = false;

    const scheduleRunFinalHtml = (fullText: string) => {
      if (finalHtmlScheduled) return;
      if (!(fullText || '').trim()) return;
      finalHtmlScheduled = true;
      scheduleFinalMarkdownHtml(sid, assistantMsgId, fullText);
    };

    const buffer = new StreamRenderBuffer();
    renderBufferRef.current = buffer;
    buffer.reset();

    const myGen = (generationMapRef.current.get(sid) ?? 0) + 1;
    generationMapRef.current.set(sid, myGen);

    const assertLive = (): boolean => {
      if (runClosed) return false;
      return isLiveStreamRun(streamManagerRef.current!.get(sid), assistantMsgId);
    };

    buffer.onFrame = (frame) => {
      if (runClosed && !frame.isFinal) return;
      if (!assertLive() && !frame.isFinal) return;
      if (myGen !== generationMapRef.current.get(sid)) return;
      // Lightweight store only — avoid immer/session messages ref churn per token.
      setStreamText(sid, assistantMsgId, frame.full);
      if (myGen !== generationMapRef.current.get(sid)) return;
      streamRecovery.noteRenderBuffer(sid, buffer.bufferedLength());
    };
    buffer.start();
    preloadPublishToolDiffs();
    if (getCompositionRoot().session.getActiveSessionId() === sid) {
      openSidePanelOnceRef.current = { terminal: false, diff: false };
      setActiveDiffSource(null);
    }

    // cancel 支持 L2/L3 mode；协议对接见 runControlClient / createStreamCancel
    let cancelStreamFn: (opts?: { mode?: 'cooperative' | 'force' }) => void = () => {};
    streamManagerRef.current!.set(sid, {
      cancel: (opts) => cancelStreamFn(opts),
      userMsgId,
      assistantMsgId,
      runId: null,
    });
    // 上文已拒绝 live replace；此处恒为 net-new start
    markStreamingActive(true);

    store.addMessage(wsId, sid, {
      id: assistantMsgId,
      sender: 'assistant',
      text: '',
      thinking: '正在处理…',
      timestamp: Date.now(),
      status: 'processing',
      toolCalls: [],
    });

    const queueToolCallPatch = (
      toolId: string,
      patch: StreamToolCallPatch,
      immediate = false
    ) => {
      if (!assertLive()) return;
      const key = streamToolBatchKey(sid, assistantMsgId, toolId);
      toolBatcherRef.current?.push(key, patch);
      if (immediate || isImmediateToolStatus(patch.status)) {
        try { toolBatcherRef.current?.flushNow(); } catch { /* ignore */ }
      }
    };

    const upsertToolCall = (
      toolId: string,
      name: string,
      args: string | undefined,
      explanation: string | undefined,
      status: 'running' | 'pending_approval',
      approvalMeta?: MessageToolApprovalMeta
    ) => {
      // Durable text snapshot before tool so blocks/streamTextOffset interleave correctly.
      snapshotStreamTextToSession(sid, assistantMsgId, streamedFullText);
      toolNames[toolId] = name;
      queueToolCallPatch(
        toolId,
        {
          id: toolId, name, arguments: args, explanation, status,
          ...(approvalMeta ? { approvalMeta } : {}),
        },
        status === 'pending_approval'
      );
      if (isShellToolName(name) && args) {
        addTerminalLine(`$ ${args}`, sid);
      }
    };

    const goalOpts = (() => {
      const liveGm = getSessionById(sid)?.goalMode;
      if (!liveGm?.active || !(liveGm.goal || '').trim()) return undefined;
      return buildGoalRunTaskFields({
        goal: liveGm.goal,
        maxIterations: liveGm.maxIterations ?? 5,
      });
    })();
    // 助手 placeholder 幂等键始终下发；用户 clientMessageId 由 send 路径注入 options
    const mergedStreamOptions: StreamRequestOptions = {
      ...(streamOptions ?? {}),
      ...(goalOpts ?? {}),
      assistantClientMessageId:
        streamOptions?.assistantClientMessageId || assistantMsgId,
    };

    cancelStreamFn = streamAssistantResponseApi(
      input,
      {
        onRunMeta: ({ runId }) => {
          if (!assertLive()) return;
          localRunId = runId;
          const entry = streamManagerRef.current!.get(sid);
          if (entry && entry.assistantMsgId === assistantMsgId) {
            entry.runId = runId;
          }
          streamRecovery.registerStream(sid, runId);
          // OPT-H4: immer recipe residual — intentional; LayoutFacade has no setState/patchState.
          // Command reads use getCompositionRoot().layout.getState() (see above).
          useLayoutStore.setState((state) => {
            const s = state.sessionsById[sid];
            if (s) s.engineLastRunId = runId;
          });
        },
        onThought: (thought) => {
          if (!assertLive()) return;
          thinkingBatcherRef.current?.push(
            streamBatchKey(sid, assistantMsgId), thought
          );
        },
        onToolStart: (toolId, name, args, explanation) => {
          if (!assertLive()) return;
          upsertToolCall(toolId, name, args, explanation, 'running');
        },
        onToolPendingApproval: (toolId, name, args, explanation, approvalMeta) => {
          if (!assertLive()) return;
          upsertToolCall(toolId, name, args, explanation, 'pending_approval', approvalMeta);
        },
        onApprovalResolved: (toolId, decision) => {
          if (!assertLive()) return;
          toolNames[toolId] = toolNames[toolId] || 'tool';
          if (decision === 'allow') {
            queueToolCallPatch(toolId, { id: toolId, status: 'running', output: '执行中…' }, true);
          } else {
            queueToolCallPatch(toolId, { id: toolId, status: 'error', output: '未获批准' }, true);
          }
        },
        onSubagentStarted: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          const taskLabel = (info.description || '协作任务').trim() || '协作任务';
          upsertSessionAgent(sid, {
            id: info.subagentId,
            subagentRunId: info.subagentRunId,
            parentSessionId: sid,
            parentRunId: info.parentRunId,
            parentToolCallId: info.parentToolCallId,
            description: taskLabel,
            mode: info.mode || 'research',
            status: 'running',
            messages: [],
            startedAt: Date.now(),
          });
          if (info.parentToolCallId) {
            queueToolCallPatch(info.parentToolCallId, {
              id: info.parentToolCallId,
              status: 'running',
              output: '协作进行中…',
            }, true);
          }
        },
        onSubagentEvent: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          // OPT-H4: nested agent message immer patch (no facade method for this recipe).
          useLayoutStore.setState((state) => {
            const sess = state.sessionsById[sid];
            const ag = sess?.agents?.find((a: SessionAgent) => a.id === info.subagentId);
            if (!ag) return;
            ag.messages = applySubagentEventToMessages(ag.messages || [], info.event);
          });
        },
        onSubagentEnded: (info) => {
          if (!assertLive()) return;
          if (!info.subagentId) return;
          let parentToolCallId: string | undefined;
          let summary = info.summary || '';
          // OPT-H4: multi-field agent terminal patch via immer (intentional residual).
          useLayoutStore.setState((state) => {
            const sess = state.sessionsById[sid];
            const ag = sess?.agents?.find((a: SessionAgent) => a.id === info.subagentId);
            if (!ag) return;
            ag.status = info.status;
            if (info.summary) ag.summary = info.summary;
            ag.endedAt = Date.now();
            parentToolCallId = ag.parentToolCallId;
            if (!summary) summary = ag.summary || '';
            for (const m of ag.messages || []) {
              if (m.status === 'processing') m.status = 'completed';
            }
            const toolId = ag.parentToolCallId;
            if (toolId && sess?.messages) {
              for (const m of sess.messages) {
                const tc = m.toolCalls?.find((t: MessageToolCall) => t.id === toolId);
                if (!tc) continue;
                const st = String(info.status || '');
                const failed = /fail|error/i.test(st);
                const stopped = st === 'stopped' || /cancel|stopp?ed|abort/i.test(st);
                tc.status = failed || stopped ? 'error' : 'success';
                const body = summary.trim() || (failed ? '协作未完成' : stopped ? '协作已停止' : '协作已完成');
                tc.output = body.length > 1200 ? body.slice(0, 1199) + '…' : body;
              }
            }
          });
          void parentToolCallId;
        },
        onTerminalLine: (line) => {
          if (!assertLive()) return;
          addTerminalLine(line, sid);
        },
        onToolSuccess: (toolId, output, diffs) => {
          if (!assertLive()) return;
          const name =
            toolNames[toolId] ||
            getStreamTool(sid, assistantMsgId, toolId)?.name ||
            getSessionById(sid)
              ?.messages?.find((m: SessionMessage) => m.id === assistantMsgId)
              ?.toolCalls?.find((t: MessageToolCall) => t.id === toolId)
              ?.name ||
            '';
          const args =
            getStreamTool(sid, assistantMsgId, toolId)?.arguments ||
            getSessionById(sid)
              ?.messages?.find((m: SessionMessage) => m.id === assistantMsgId)
              ?.toolCalls?.find((t: MessageToolCall) => t.id === toolId)
              ?.arguments ||
            '';
          const displayOut = sanitizeToolDisplayOutput(output || '');
          const resolvedDiffs = resolveToolDiffs({ name, args, output: displayOut, structuredDiffs: diffs });
          queueToolCallPatch(toolId, {
            id: toolId,
            ...(name ? { name } : {}),
            status: 'success',
            output: displayOut || output || '完成',
            diffs: resolvedDiffs.length ? resolvedDiffs : undefined,
          }, true);
          if (isShellToolName(name) && displayOut) {
            addTerminalLines(displayOut.split('\n').slice(0, 80), sid);
          }
          if (resolvedDiffs.length > 0) {
            publishToolDiffsLazy(resolvedDiffs);
          }
        },
        onToolError: (toolId, error) => {
          if (!assertLive()) return;
          const clean = sanitizeToolDisplayOutput(error || '');
          queueToolCallPatch(toolId, { id: toolId, status: 'error', output: clean || error || '失败' }, true);
          const name = toolNames[toolId];
          if (name && isShellToolName(name) && clean) {
            addTerminalLine(clean, sid);
          }
        },
        onChunk: (chunk) => {
          if (!assertLive()) return;
          gotRealText = true;
          dismissRunNotice();
          streamedFullText += chunk;
          streamRecovery.updateHeartbeat(sid, { bytes: chunk.length });
          if (renderBufferRef.current) {
            renderBufferRef.current.push(chunk);
            streamRecovery.noteRenderBuffer(sid, renderBufferRef.current.bufferedLength());
          } else {
            textBatcherRef.current?.push(streamBatchKey(sid, assistantMsgId), streamedFullText);
          }
          const cur = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          if (cur?.thinking === '正在处理…') {
            thinkingBatcherRef.current?.drop(streamBatchKey(sid, assistantMsgId));
            store.updateMessageThinking(sid, assistantMsgId, '');
          }
        },
        onRunError: (message, kind, detail) => {
          if (!assertLive()) return;
          streamRecovery.markFailed(sid, message || kind || 'error');
          const asstErr = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          const lastToolErr = (asstErr?.toolCalls || []).findLast(Boolean);
          recordStreamDiag({
            sessionId: sid,
            runId: localRunId || undefined,
            scope: kind || 'run-error',
            kind: kind || 'error',
            message,
            raw: detail || message,
            context: {
              lastTool: lastToolErr?.name ?? null,
              lastToolStatus: lastToolErr?.status ?? null,
              toolCount: asstErr?.toolCalls?.length ?? 0,
            },
          });
          // 错误只走横幅/toast，禁止写入 assistant 气泡（用户要求：勿把错误当 AI 输出）
          pushRunNotice(
            { text: message, kind: kind || 'error', detail: detail || undefined },
            14000
          );
          onShowToast(message);
          if (asstErr) {
            const hadText =
              !!(asstErr.text || '').trim() ||
              !!getStreamText(sid, assistantMsgId)?.trim();
            if (!hadText) {
              store.withdrawMessage(wsId, sid, assistantMsgId);
              clearStream(sid, assistantMsgId);
            } else {
              store.setSessionMessageStatus(sid, assistantMsgId, 'error', undefined, {
                errorDetail: {
                  message: message || '服务暂时不可用，请检查网络或后端配置',
                  kind: kind || 'stream-error',
                  technical: typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : undefined
                }
              });
            }
          }
          flushStreamBatchers();
        },
        onComplete: () => {
          if (runClosed) return;
          if (!isLiveStreamRun(streamManagerRef.current!.get(sid), assistantMsgId)) {
            runClosed = true;
            // Replaced by a newer run — that run owns streamingActive; do not clear.
            return;
          }
          runClosed = true;
          markStreamingActive(false);
          streamRecovery.markCompleted(sid);

          buffer.push('', true);
          buffer.flush(true);
          flushStreamBatchers();
          // ONE durable commit of final stream text + thinking; clear streaming entry.
          const committedText = commitStreamToSession(sid, assistantMsgId, {
            text:
              getStreamText(sid, assistantMsgId) ||
              buffer.currentText() ||
              streamedFullText ||
              '',
          });
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const st = getCompositionRoot().layout.getState();
          const asst = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          const lastTool = (asst?.toolCalls || []).findLast(Boolean);
          const runningLeft = (asst?.toolCalls || []).filter(
            (t: MessageToolCall) => t.status === 'running'
          ).length;
          recordStreamDiag({
            sessionId: sid,
            runId: localRunId || undefined,
            scope: 'run-complete',
            kind: 'complete',
            message: runningLeft ? `流已收口，但仍有 ${runningLeft} 个工具显示运行中` : '流正常收口',
            context: {
              lastTool: lastTool?.name ?? null,
              lastToolStatus: lastTool?.status ?? null,
              toolCount: asst?.toolCalls?.length ?? 0,
              gotRealText,
              elapsedSec: elapsed,
            },
          });
          if (asst && !gotRealText && !(asst.text || committedText || '').trim()) {
            const hasTools = (asst.toolCalls || []).some(
              (t: MessageToolCall) =>
                t.status === 'success' || t.status === 'error' || t.status === 'running'
            );
            if (!hasTools) {
              pushRunNotice({ text: '这一轮没有文字回复。若刚改过配置，请检查模型与网络。', kind: 'empty' }, 6000);
            } else {
              dismissRunNotice();
            }
          } else if (gotRealText || (asst?.text || committedText || '').trim()) {
            dismissRunNotice();
          }
          const toolPatches = buildTerminalToolPatches(asst?.toolCalls, 'complete');
          for (const p of toolPatches) {
            st.updateMessageToolCall(sid, assistantMsgId, p.id, {
              status: p.status, output: p.output,
            });
          }
          let finalTextForHtml = '';
          try {
            const latest = getSessionById(sid)?.messages.find(
              (m: SessionMessage) => m.id === assistantMsgId
            );
            const raw = latest?.text || committedText || streamedFullText || '';
            const cleaned = stripThoughtPlaceholders(raw);
            if (cleaned !== raw) st.updateMessageText(sid, assistantMsgId, cleaned);
            finalTextForHtml = cleaned || raw;
            const th = latest?.thinking || '';
            if (th === '正在处理…' || th === '正在思考中...') {
              thinkingBatcherRef.current?.drop(streamBatchKey(sid, assistantMsgId));
              st.updateMessageThinking(sid, assistantMsgId, '');
            }
            // OPT-H4: timeline normalize mutates msg in place — keep store.setState recipe.
            useLayoutStore.setState((state) => {
              const sess = state.sessionsById[sid];
              const msg = sess?.messages.find((m: SessionMessage) => m.id === assistantMsgId);
              if (!msg || msg.sender !== 'assistant') return;
              const n = normalizeAssistantTimeline({ ...msg });
              msg.blocks = n.blocks;
              msg.toolCalls = n.toolCalls;
            });
          } catch { /* ignore */ }
          scheduleRunFinalHtml(finalTextForHtml);
          const latestUserMsg = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === userMsgId
          );
          const latestAssistantMsg = getSessionById(sid)?.messages.find(
            (m: SessionMessage) => m.id === assistantMsgId
          );
          // 只在消息仍处于 processing 时标记完成；error/cancelled 等终态保持原状，
          // 避免触发 error → completed 这类非法状态转换。
          if (latestUserMsg?.status === 'processing') {
            st.setSessionMessageStatus(sid, userMsgId, 'completed');
          }
          if (latestAssistantMsg?.status === 'processing') {
            st.setSessionMessageStatus(sid, assistantMsgId, 'completed', elapsed);
          }
          // D2-5：终态后检测 silent complete（无 UserView 可见正文/工具）；仅 metric + dev warn，不改成功语义
          try {
            const finalizedAsst = getSessionById(sid)?.messages.find(
              (m: SessionMessage) => m.id === assistantMsgId
            );
            checkAndAlertSilentComplete(finalizedAsst, {
              sessionId: sid,
              runId: localRunId || undefined,
              messageId: assistantMsgId,
            });
          } catch {
            /* ignore alert failures */
          }
          const curStream = streamManagerRef.current!.get(sid);
          if (curStream?.assistantMsgId === assistantMsgId) {
            streamManagerRef.current!.delete(sid);
            generationMapRef.current.delete(sid);
          }
          void (async () => {
            try {
              const runId = localRunId;
              let applied = false;
              const { estimateCostUsd } = await import('../../api/pricingStore');
              if (runId) {
                await new Promise((r) => setTimeout(r, 400));
                const usage = await fetchRunSnapshotUsage(runId);
                if (usage && (usage.sampleCount ?? 0) > 0 && (usage.promptTokens || usage.completionTokens)) {
                  const model = getActiveModelId() || 'unknown';
                  const cur = getCompositionRoot().layout.getState().tokenUsage;
                  const next = applyUsageDelta(cur, usage, (i: number, o: number) => estimateCostUsd(model, i, o));
                  const dIn = Math.max(0, (next.input || 0) - (cur.input || 0));
                  const dOut = Math.max(0, (next.output || 0) - (cur.output || 0));
                  const dCost = Math.max(0, (next.cost || 0) - (cur.cost || 0));
                  syncTelemetryData({ tokenUsage: next });
                  try {
                    const { recordUsageDelta } = await import('../../api/usageStore');
                    recordUsageDelta({ input: dIn, output: dOut, cost: dCost, model });
                  } catch { /* ignore */ }
                  applied = true;
                }
              }
              if (!applied) {
                const sess = getSessionById(sid);
                const userText = sess?.messages.find((m: SessionMessage) => m.id === userMsgId)?.text || '';
                const asstText = sess?.messages.find((m: SessionMessage) => m.id === assistantMsgId)?.text || '';
                const approxIn = Math.max(1, Math.ceil(userText.length / 4));
                const approxOut = Math.max(0, Math.ceil(asstText.length / 4));
                const model = getActiveModelId() || 'unknown';
                const cur = getCompositionRoot().layout.getState().tokenUsage;
                const dCost = estimateCostUsd(model, approxIn, approxOut);
                syncTelemetryData({
                  tokenUsage: {
                    ...cur,
                    input: cur.input + approxIn,
                    output: cur.output + approxOut,
                    cost: cur.cost + dCost,
                  },
                });
                try {
                  const { recordUsageDelta } = await import('../../api/usageStore');
                  recordUsageDelta({ input: approxIn, output: approxOut, cost: dCost, model });
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          })();
          if (!maybeContinueGoalMode(sid, assistantMsgId)) {
            drainQueuedAfterComplete(sid);
          }
        },
      },
      sid,
      assistantMsgId,
      mergedStreamOptions
    );

    const stillMine = streamManagerRef.current!.get(sid);
    if (stillMine?.assistantMsgId === assistantMsgId) {
      stillMine.cancel = (opts) => cancelStreamFn?.(opts);
      if (localRunId) stillMine.runId = localRunId;
    }
  };

  streamManagerRef.current!.bindStarter(runStreamingAssistant);

  /**
   * 停止生成：默认 L2 cooperative；force=true 时 L3。
   * UI 默认 Stop → handleStopGeneration()；强制取消 → handleForceCancelGeneration()。
   * 共享 wire：api/streamStop.dispatchStreamStopCancel → createStreamCancel / compositionRoot
   *（TRANSITIONAL：daemon L2 未全量时仍成对 cancel-run.mode）。
   * 本函数保留 chat 专属 partials（buffer / goalMode / message status / telemetry）。
   */
  const finalizeStopGeneration = (force: boolean) => {
    const sid = resolveStreamSessionId(
      null,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    streamRecovery.markFailed(sid, force ? 'force_cancelled' : 'cancelled');
    streamManagerRef.current!.delete(sid);
    generationMapRef.current.delete(sid);
    markStreamingActive(false);
    const stopBuf = renderBufferRef.current;
    stopBuf?.push('', true);
    stopBuf?.flush(true);
    stopBuf?.stop();
    flushStreamBatchers();
    const st = getCompositionRoot().layout.getState();
    if (getSessionById(sid)?.goalMode?.active) {
      streamManagerRef.current!.markGoalCancelled(sid);
      patchSession(sid, { goalMode: null });
    }
    // Persist partial stream text only（禁止把「已停止」等系统句写入气泡）
    const partialText =
      getStreamText(sid, cur.assistantMsgId) ||
      stopBuf?.currentText() ||
      getSessionById(sid)?.messages.find(
        (m: SessionMessage) => m.id === cur.assistantMsgId
      )?.text ||
      '';
    const stopText = (partialText || '').trim();
    commitStreamToolsToSession(sid, cur.assistantMsgId);
    if (stopText) {
      commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
    } else {
      // 无正文：清空占位，用横幅提示停止（不写 assistant 正文）
      st.updateMessageText(sid, cur.assistantMsgId, '');
      clearStream(sid, cur.assistantMsgId);
      pushRunNotice(
        {
          text: force ? '已强制停止本轮生成。' : '已停止本轮生成。',
          kind: 'ended',
        },
        5000
      );
    }
    const asst = getSessionById(sid)?.messages.find(
      (m: SessionMessage) => m.id === cur.assistantMsgId
    );
    st.setSessionMessageStatus(sid, cur.userMsgId, 'completed');
    st.setSessionMessageStatus(sid, cur.assistantMsgId, 'completed');
    if (stopText) {
      scheduleFinalMarkdownHtml(sid, cur.assistantMsgId, stopText);
    }
    const stopPatches = buildTerminalToolPatches(asst?.toolCalls, 'stop');
    if (stopPatches.length) {
      // OPT-H4: batch tool-terminal status via immer (no LayoutFacade.setState).
      useLayoutStore.setState((state) => {
        const msg = state.sessionsById[sid]?.messages.find(
          (m: SessionMessage) => m.id === cur.assistantMsgId
        );
        if (!msg?.toolCalls) return;
        for (const p of stopPatches) {
          const tc = msg.toolCalls.find((t: MessageToolCall) => t.id === p.id);
          if (!tc) continue;
          tc.status = p.status;
          tc.output = p.output;
        }
      });
    }
    void (async () => {
      try {
        const sess = getSessionById(sid);
        const userTxt = sess?.messages.find((m: SessionMessage) => m.id === cur.userMsgId)?.text || '';
        const asstTxt = asst?.text || stopText || '';
        if (!userTxt && !asstTxt) return;
        const { estimateCostUsd } = await import('../../api/pricingStore');
        const approxIn = Math.max(1, Math.ceil(userTxt.length / 4));
        const approxOut = Math.max(0, Math.ceil(asstTxt.length / 4));
        const model = getActiveModelId() || 'unknown';
        const curUsage = getCompositionRoot().layout.getState().tokenUsage;
        const dCost = estimateCostUsd(model, approxIn, approxOut);
        syncTelemetryData({
          tokenUsage: {
            ...curUsage,
            input: (curUsage.input || 0) + approxIn,
            output: (curUsage.output || 0) + approxOut,
            cost: (curUsage.cost || 0) + dCost,
          },
        });
        try {
          const { recordUsageDelta } = await import('../../api/usageStore');
          recordUsageDelta({ input: approxIn, output: approxOut, cost: dCost, model });
        } catch { /* ignore */ }
      } catch { /* ignore */ }
    })();
    // L2/L3 wire：shared helper（chat has live cancel; no runId double-dispatch）
    dispatchStreamStopCancel({ force, cancel: cur.cancel });
  };

  /** 默认 Stop = L2 cooperative_stop */
  const handleStopGeneration = () => {
    finalizeStopGeneration(false);
  };

  /** 强制取消 = L3 force_cancel（UI 应二次确认） */
  const handleForceCancelGeneration = () => {
    finalizeStopGeneration(true);
  };

  return { runStreamingAssistant, handleStopGeneration, handleForceCancelGeneration };
}
