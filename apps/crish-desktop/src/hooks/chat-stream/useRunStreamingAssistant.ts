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
  StreamRunNoticeHelpers,
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
} from './helpers';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { setStreamText } from '../../store/streamingStore';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import { streamBatchKey } from '../../api/streamTextBatcher';
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
} from './streamExecutionHelper';

export function useRunStreamingAssistant(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  noticeHelpers: StreamRunNoticeHelpers,
  queryHelpers: StreamRunQueryHelpers,
  generationMapRef: MutableRefObject<Map<string, number>>
): {
  runStreamingAssistant: StreamRunStarter;
} {
  const { wsId, upsertSessionAgent } = queryHelpers;
  const { pushRunNotice, dismissTransientRunNotice } = noticeHelpers;
  const {
    streamManagerRef,
    textBatcherRef,
    thinkingBatcherRef,
    toolBatcherRef,
    renderBufferRef,
    flushStreamBatchers,
  } = refs;

  const { maybeContinueGoalMode, drainQueuedAfterComplete } = useGoalMode(
    streamManagerRef
  );

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
      dismissTransientRunNotice();
      let gotRealText = false;
      let runEndedWithNetworkError = false;
      let localRunId: string | null = null;
      let streamedFullText = '';
      const state: StreamRunState = { runClosed: false, draining: false };
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
          pushRunNotice,
          dismissTransientRunNotice,
          scheduleRunFinalHtml,
          thinkingBatcher: thinkingBatcherRef.current,
          flushStreamBatchers,
          generationMapRef,
          state,
          maybeContinueGoalMode,
          drainQueuedAfterComplete,
        });
      };

      const buffer = new StreamRenderBuffer();
      renderBufferRef.current = buffer;
      buffer.reset();

      const myGen = (generationMapRef.current.get(sid) ?? 0) + 1;
      generationMapRef.current.set(sid, myGen);

      const assertLive = (): boolean =>
        !state.runClosed &&
        isLiveStreamRun(streamManagerRef.current?.get(sid), assistantMsgId);

      buffer.onFrame = (frame) => {
        if (frame.isFinal) {
          if (state.draining) {
            setStreamText(sid, assistantMsgId, frame.full);
            finishComplete();
          }
          return;
        }
        if (state.runClosed && !state.draining) return;
        if (!assertLive() && !state.draining) return;
        if (myGen !== generationMapRef.current.get(sid)) return;
        setStreamText(sid, assistantMsgId, frame.full);
      };
      buffer.start();

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
            const entry = streamManagerRef.current?.get(sid);
            if (entry && entry.assistantMsgId === assistantMsgId)
              entry.runId = runId;
            getCompositionRoot()
              .session.getState()
              .setEngineLastRunId(sid, runId);
          },
          onThought: (thought, turnIndex = 0) => {
            if (!assertLive()) return;
            thinkingBatcherRef.current?.push(
              streamBatchKey(sid, assistantMsgId),
              thought
            );
            getCompositionRoot()
              .session.getState()
              .updateMessageThinking(sid, assistantMsgId, thought, turnIndex);
          },
          onToolStart: (toolId, name, args, explanation) => {
            if (!assertLive()) return;
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
          onToolSuccess: (toolId, output, diffs) => {
            if (!assertLive()) return;
            handleToolSuccess({
              sid,
              assistantMsgId,
              toolId,
              output,
              diffs,
              toolNames,
              queueToolCallPatch,
            });
          },
          onToolError: (toolId, error) => {
            if (!assertLive()) return;
            handleToolError({
              sid,
              toolId,
              error,
              toolNames,
              queueToolCallPatch,
            });
          },
          onChunk: (chunk) => {
            if (!assertLive()) return;
            gotRealText = true;
            dismissTransientRunNotice();
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
            const res = handleRunError({
              wsId,
              sid,
              assistantMsgId,
              runId: localRunId,
              message,
              kind,
              detail,
              pushRunNotice,
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
      pushRunNotice,
      dismissTransientRunNotice,
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
