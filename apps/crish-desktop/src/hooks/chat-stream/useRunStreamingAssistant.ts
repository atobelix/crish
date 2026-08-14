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
  scheduleFinalMarkdownHtml,
  buildTerminalToolPatches,
} from './helpers';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { setStreamText } from '../../store/streamingStore';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import { streamBatchKey } from '../../api/streamTextBatcher';
import { addTerminalLine } from '../../api/storeAccess';
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
  commitRunCompletion,
  decideEmptyRunNotice,
  finalizeAssistantMessageText,
  finalizeRunCompletionStatuses,
  buildGoalStreamOptions,
  createToolPatchQueue,
  createCompleteHandler,
  type StreamRunState,
} from './streamCallbacksInternals';
import { applyRunUsageSnapshot } from './streamCallbacksUsage';
import type { SessionMessage } from '../../store/layoutStore';

export function useRunStreamingAssistant(
  options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  noticeHelpers: StreamRunNoticeHelpers,
  queryHelpers: StreamRunQueryHelpers,
  generationMapRef: MutableRefObject<Map<string, number>>
): {
  runStreamingAssistant: StreamRunStarter;
} {
  const { onShowToast } = options;
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
    streamManagerRef,
    onShowToast
  );

  const runStreamingAssistant: StreamRunStarter = useCallback(
    (input, userMsgId, sessionIdOverride, streamOptions) => {
      const sid = resolveStreamSessionId(
        sessionIdOverride,
        getCompositionRoot().session.getActiveSessionId()
      );
      if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) return;

      const prevStream = streamManagerRef.current?.get(sid);
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

      const assistantMsgId = generateMessageId('assistant');
      const store = getCompositionRoot().layout.getState();
      const toolNames: Record<string, string> = {};
      const startTime = Date.now();
      dismissTransientRunNotice();
      let gotRealText = false;
      let runEndedWithNetworkError = false;
      let localRunId: string | null = null;
      let streamedFullText = '';
      let finalHtmlScheduled = false;
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
        thinking: '正在处理…',
        timestamp: startTime,
        status: 'processing',
        toolCalls: [],
      });

      const scheduleRunFinalHtml = (fullText: string) => {
        if (finalHtmlScheduled || !(fullText || '').trim()) return;
        finalHtmlScheduled = true;
        scheduleFinalMarkdownHtml(sid, assistantMsgId, fullText, {
          preCleaned: true,
        });
      };

      const finishComplete = () => {
        if (completed) return;
        completed = true;
        markStreamingActive(false);
        flushStreamBatchers();
        const { committedText, elapsed, asst } = commitRunCompletion({
          sid,
          assistantMsgId,
          buffer,
          streamedFullText,
          startTime,
          runId: localRunId,
          gotRealText,
        });
        decideEmptyRunNotice({
          asst,
          committedText,
          gotRealText,
          runEndedWithNetworkError,
          pushRunNotice,
          dismissTransientRunNotice,
        });
        const toolPatches = buildTerminalToolPatches(
          asst?.toolCalls,
          'complete'
        );
        if (toolPatches.length) {
          getCompositionRoot()
            .layout.getState()
            .applyToolCallPatches(sid, assistantMsgId, toolPatches);
        }
        finalizeAssistantMessageText({
          sid,
          assistantMsgId,
          committedText,
          streamedFullText,
          scheduleRunFinalHtml,
          thinkingBatcher: thinkingBatcherRef.current,
        });
        finalizeRunCompletionStatuses({
          sid,
          userMsgId,
          assistantMsgId,
          elapsed,
          runId: localRunId,
        });
        generationMapRef.current.delete(sid);
        state.runClosed = true;
        state.draining = false;
        void applyRunUsageSnapshot({
          runId: localRunId,
          sid,
          userMsgId,
          assistantMsgId,
        });
        if (!maybeContinueGoalMode(sid, assistantMsgId)) {
          drainQueuedAfterComplete(sid);
        }
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
              .layout.getState()
              .setEngineLastRunId(sid, runId);
          },
          onThought: (thought) => {
            if (!assertLive()) return;
            thinkingBatcherRef.current?.push(
              streamBatchKey(sid, assistantMsgId),
              thought
            );
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
          onTerminalLine: (line) => {
            if (!assertLive()) return;
            addTerminalLine(line, sid);
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
            const cur = getSessionById(sid)?.messages?.find(
              (m: SessionMessage) => m.id === assistantMsgId
            );
            if (
              cur?.thinking === '正在处理…' ||
              cur?.thinking === '正在思考中...'
            ) {
              thinkingBatcherRef.current?.drop(
                streamBatchKey(sid, assistantMsgId)
              );
              getCompositionRoot()
                .layout.getState()
                .updateMessageThinking(sid, assistantMsgId, '');
            }
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
              onShowToast,
              flushStreamBatchers,
              refs: {
                renderBuffer: renderBufferRef.current,
                streamManager: streamManagerRef.current!,
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
      onShowToast,
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
