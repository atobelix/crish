/**
 * chat-stream 流式运行编排钩子（useRunStreamingAssistant）。
 *
 * 负责组装与启动 streamAssistantResponseApi、维护 sessionStreamManager 句柄、
 * 对接 renderBuffer 与 streamingStore，并在生命周期内完整派发工具/思考/事件。
 */
import { useCallback, type MutableRefObject } from 'react';
import type { UseChatStreamOptions } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import type {
  StreamRunQueryHelpers,
  StreamRunStarter,
} from './streamCallbacksSurfaces';
import { streamAssistantResponseApi } from '../../api/chatApi';
import { markStreamingActive } from '../../api/streamStop';
import { generateMessageId } from '../../utils/generateMessageId';
import {
  resolveStreamSessionId,
  canStreamLocalSession,
  isLiveStreamRun,
  snapshotStreamThinkingToSession,
} from './helpers';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { useSessionExecutionTrackerStore } from '../../store/sessionExecutionTrackerStore';
import { clearRuntimeStatus } from '../../store/sessionRuntimeStatusStore';
import { streamBatchKey } from '../../api/streamTextBatcher';
import { recordChunkSample } from '../../api/streamDiag';
import { useGoalMode } from './useGoalMode';
import {
  applySubagentStarted,
  applySubagentEvent,
  applySubagentEnded,
  handleApprovalResolved,
  handleToolSuccess,
  handleToolError,
  handleRunError,
} from './streamCallbacksEvents';
import {
  buildGoalStreamOptions,
  createToolPatchQueue,
  createCompleteHandler,
  type StreamRunState,
} from './streamCallbacksInternals';
import {
  handleStreamConflict,
  createFinalHtmlScheduler,
  handleThinkingResetOnChunk,
  executeStreamCompletion,
  setupStreamRenderBuffer,
} from './streamExecutionHelper';

const tracker = () => useSessionExecutionTrackerStore.getState();

export function useRunStreamingAssistant(
  _options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  queryHelpers: StreamRunQueryHelpers,
  generationMapRef: MutableRefObject<Map<string, number>>
): { runStreamingAssistant: StreamRunStarter } {
  const { wsId, upsertSessionAgent } = queryHelpers;
  const {
    streamManagerRef,
    textBatcherRef,
    thinkingBatcherRef,
    toolBatcherRef,
    renderBufferRef,
    flushStreamBatchers,
  } = refs;

  const { maybeContinueGoalMode, drainQueuedAfterComplete } =
    useGoalMode(streamManagerRef);

  const runStreamingAssistant: StreamRunStarter = useCallback(
    (input, userMsgId, sessionIdOverride, streamOptions) => {
      const sid = resolveStreamSessionId(
        sessionIdOverride,
        getCompositionRoot().session.getActiveSessionId()
      );
      if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) return;

      if (handleStreamConflict(sid, userMsgId, streamManagerRef.current)) {
        return;
      }

      const assistantMsgId = generateMessageId('assistant');
      const store = getCompositionRoot().session.getState();
      const toolNames: Record<string, string> = {};
      const startTime = Date.now();
      // 单轨收敛 §2.0：run 启动原子清空运行时状态（新一轮开始，旧瞬态/错误行消失）
      clearRuntimeStatus(sid);
      let gotRealText = false;
      let runEndedWithNetworkError = false;
      let localRunId: string | null = null;
      let streamedFullText = '';
      const state: StreamRunState = {
        runClosed: false,
        draining: false,
        runEndedWithError: false,
      };
      let completed = false;

      let cancelStreamFn: (opts?: {
        mode?: 'cooperative' | 'force';
      }) => void = () => {};
      streamManagerRef.current?.set(sid, {
        cancel: (opts) => cancelStreamFn(opts),
        userMsgId,
        assistantMsgId,
        runId: null,
      });

      markStreamingActive(true);
      tracker().startRun(sid, null, 'thinking');
      store.addMessage(wsId, sid, {
        id: assistantMsgId,
        sender: 'assistant',
        text: '',
        thinking: undefined,
        timestamp: startTime,
        status: 'processing',
        toolCalls: [],
      });

      const scheduleRunFinalHtml = createFinalHtmlScheduler(
        sid,
        assistantMsgId
      );

      const finishComplete = () => {
        if (completed) return;
        completed = true;
        tracker().completeRun(sid);
        executeStreamCompletion({
          sid,
          userMsgId,
          assistantMsgId,
          buffer,
          streamedFullText,
          startTime,
          localRunId,
          gotRealText,
          runEndedWithNetworkError,
          scheduleRunFinalHtml,
          thinkingBatcher: thinkingBatcherRef.current,
          flushStreamBatchers,
          generationMapRef,
          state,
          maybeContinueGoalMode,
          drainQueuedAfterComplete,
        });
      };

      const assertLive = (): boolean =>
        !state.runClosed &&
        isLiveStreamRun(streamManagerRef.current?.get(sid), assistantMsgId);

      const buffer = setupStreamRenderBuffer({
        sid,
        assistantMsgId,
        renderBufferRef,
        generationMapRef,
        state,
        assertLive,
        finishComplete,
      });

      const { queueToolCallPatch, upsertToolCall } = createToolPatchQueue({
        sid,
        assistantMsgId,
        toolNames,
        assertLive,
        readStreamedFullText: () => streamedFullText,
        toolBatcher: toolBatcherRef.current,
      });

      const onComplete = createCompleteHandler({
        sid,
        assistantMsgId,
        state,
        refs: { streamManagerRef },
        flushStreamBatchers,
        finishComplete,
        buffer,
      });

      cancelStreamFn = streamAssistantResponseApi(
        input,
        {
          onRunMeta: ({ runId }) => {
            if (!assertLive()) return;
            localRunId = runId;
            tracker().updateRunId(sid, runId);
            const entry = streamManagerRef.current?.get(sid);
            if (entry && entry.assistantMsgId === assistantMsgId)
              entry.runId = runId;
            getCompositionRoot()
              .session.getState()
              .setEngineLastRunId(sid, runId);
          },
          onThought: (thought) => {
            // D2 单轨收敛：thinking 仅经 batcher → streamingStore（与 onChunk 同构），
            // 不再同步直写 sessionStore.updateMessageThinking。
            if (!assertLive()) return;
            // S4.3：首帧思考清理运行时状态（消除幽灵重试瞬态行）
            clearRuntimeStatus(sid);
            tracker().updateStage(sid, 'thinking');
            thinkingBatcherRef.current?.push(
              streamBatchKey(sid, assistantMsgId),
              thought
            );
          },
          onToolStart: (toolId, name, args, explanation) => {
            if (!assertLive()) return;
            // S4.3：首帧工具调用清理运行时状态（消除幽灵重试瞬态行）
            clearRuntimeStatus(sid);
            tracker().updateStage(sid, 'executing_tool', name);
            upsertToolCall(toolId, name, args, explanation, 'running');
          },
          onToolPendingApproval: (
            toolId,
            name,
            args,
            explanation,
            approvalMeta
          ) => {
            if (!assertLive()) return;
            tracker().markApprovalPending(sid, toolId, name);
            upsertToolCall(
              toolId,
              name,
              args,
              explanation,
              'pending_approval',
              approvalMeta
            );
          },
          onApprovalResolved: (toolId, decision) => {
            if (!assertLive()) return;
            tracker().resolveApproval(sid);
            handleApprovalResolved({
              toolId,
              decision,
              toolNames,
              queueToolCallPatch,
            });
          },
          onSubagentStarted: (info) => {
            if (!assertLive()) return;
            applySubagentStarted({
              sid,
              info,
              upsertSessionAgent,
              queueToolCallPatch,
            });
          },
          onSubagentEvent: (info) => {
            if (!assertLive()) return;
            applySubagentEvent({ sid, info });
          },
          onSubagentEnded: (info) => {
            if (!assertLive()) return;
            applySubagentEnded({ sid, info });
          },
          onTerminalLine: (_line) => {
            // No-op: Terminal store decoupled from AI stream outputs (DIM-07)
          },
          onToolSuccess: (toolId, output, diffs, durationMs) => {
            if (!assertLive()) return;
            handleToolSuccess({
              sid,
              assistantMsgId,
              toolId,
              output,
              diffs,
              toolNames,
              durationMs,
              queueToolCallPatch,
            });
          },
          onToolError: (toolId, error, durationMs) => {
            if (!assertLive()) return;
            handleToolError({
              sid,
              assistantMsgId,
              toolId,
              error,
              toolNames,
              durationMs,
              queueToolCallPatch,
            });
          },
          onChunk: (chunk) => {
            if (!assertLive()) return;
            recordChunkSample(chunk.length);
            if (!gotRealText) {
              // 首个正文 token 抵达：前置思考阶段正式结束（"吐字开始"），
              // 立即固化思考内容与真实思考耗时（durationMs），杜绝后续吐字阶段的耗时混入思考耗时。
              snapshotStreamThinkingToSession(sid, assistantMsgId);
              // 单轨收敛 §2.0：新 Token 到达 = 重试成功信号，瞬态重试行立即消失（不留痕）
              clearRuntimeStatus(sid);
              tracker().updateStage(sid, 'streaming_text');
            }
            gotRealText = true;
            streamedFullText += chunk;
            if (renderBufferRef.current) {
              renderBufferRef.current.push(chunk);
            } else {
              textBatcherRef.current?.push(
                streamBatchKey(sid, assistantMsgId),
                streamedFullText
              );
            }
            handleThinkingResetOnChunk(
              sid,
              assistantMsgId,
              thinkingBatcherRef.current
            );
          },
          onRunError: (message, kind, detail) => {
            if (!assertLive()) return;
            state.runEndedWithError = true;
            tracker().failRun(sid, message);
            const res = handleRunError({
              wsId,
              sid,
              userMsgId,
              assistantMsgId,
              runId: localRunId,
              message,
              kind,
              detail,
              flushStreamBatchers,
              refs: {
                renderBuffer: renderBufferRef.current,
                streamManager: streamManagerRef.current ?? undefined,
                generationMap: generationMapRef.current,
              },
            });
            if (res.hadNetworkError) runEndedWithNetworkError = true;
          },
          onComplete,
        },
        sid,
        assistantMsgId,
        buildGoalStreamOptions({ sid, assistantMsgId, streamOptions })
      );

      const stillMine = streamManagerRef.current?.get(sid);
      if (stillMine?.assistantMsgId === assistantMsgId) {
        stillMine.cancel = (opts) => cancelStreamFn?.(opts);
        if (localRunId) stillMine.runId = localRunId;
      }
    },
    [
      wsId,
      upsertSessionAgent,
      streamManagerRef,
      textBatcherRef,
      thinkingBatcherRef,
      toolBatcherRef,
      renderBufferRef,
      flushStreamBatchers,
      maybeContinueGoalMode,
      drainQueuedAfterComplete,
      generationMapRef,
    ]
  );

  streamManagerRef.current?.bindStarter(runStreamingAssistant);

  return { runStreamingAssistant };
}
