/**
 * chat-stream 流式运行编排钩子（useRunStreamingAssistant）。
 *
 * 负责组装与启动 streamViaEngine、维护 sessionStreamManager 句柄、
 * 对接 renderBuffer 与 streamingStore。
 */
import { useCallback, type MutableRefObject } from 'react';
import type { UseChatStreamOptions } from './types';
import type { StreamBatcherRefs } from './useStreamBatchers';
import type {
  StreamRunNoticeHelpers,
  StreamRunQueryHelpers,
  StreamRunStarter,
} from './streamCallbacksSurfaces';
import { streamViaEngine } from '../../api/chatBridge';
import { markStreamingActive } from '../../api/streamStop';
import { generateMessageId } from '../../utils/generateMessageId';
import { resolveStreamSessionId, commitStreamToSession } from './helpers';
import { setStreamText } from '../../store/streamingStore';

export function useRunStreamingAssistant(
  _options: UseChatStreamOptions,
  refs: StreamBatcherRefs,
  noticeHelpers: StreamRunNoticeHelpers,
  queryHelpers: StreamRunQueryHelpers,
  generationMapRef: MutableRefObject<Map<string, number>>
): {
  runStreamingAssistant: StreamRunStarter;
} {
  const { streamManagerRef, renderBufferRef, flushStreamBatchers } = refs;
  const { pushRunNotice } = noticeHelpers;

  const runStreamingAssistant: StreamRunStarter = useCallback(
    (input, userMsgId, sessionIdOverride, streamOptions) => {
      const sid = resolveStreamSessionId(sessionIdOverride, queryHelpers.wsId);
      if (!sid) return;

      const assistantMsgId = generateMessageId('assistant');

      markStreamingActive(true);
      const seq = (generationMapRef.current.get(sid) ?? 0) + 1;
      generationMapRef.current.set(sid, seq);

      const buffer = renderBufferRef.current;
      if (buffer) {
        buffer.onFrame = (frame) => {
          setStreamText(sid, assistantMsgId, frame.full);
        };
        buffer.start();
      }

      const stop = streamViaEngine(
        input,
        {
          onChunk: (chunk) => {
            renderBufferRef.current?.push(chunk);
          },
          onThought: (_thought) => {},
          onToolStart: (_toolId, _name, _args, _explanation) => {},
          onToolSuccess: (_toolId, _output, _diffs) => {},
          onToolError: (_toolId, _error) => {},
          onComplete: () => {
            markStreamingActive(false);
            buffer?.flushFinal();
            flushStreamBatchers();
            commitStreamToSession(sid, assistantMsgId);
          },
          onRunError: (message, _kind, _detail) => {
            markStreamingActive(false);
            pushRunNotice({ text: String(message), kind: 'error' });
          },
        },
        sid,
        assistantMsgId,
        streamOptions
      );

      streamManagerRef.current?.set(sid, {
        cancel: stop,
        userMsgId,
        assistantMsgId,
        runId: null,
      });
    },
    [
      queryHelpers.wsId,
      renderBufferRef,
      streamManagerRef,
      flushStreamBatchers,
      pushRunNotice,
      generationMapRef,
    ]
  );

  return { runStreamingAssistant };
}
