import { useRef, useEffect, type MutableRefObject } from 'react';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  isImmediateToolStatus,
  type StreamToolCallPatch,
} from '../../api/streamTextBatcher';
import {
  clearStreamTool,
  setStreamThinking,
  setStreamTool,
} from '../../store/streamingStore';
import { commitToolPatchToSession } from './helpers';
import {
  registerStreamBatcher,
  unregisterStreamBatcher,
} from '../../api/beforeunloadFlush';
import { logger, toErrMeta } from '../../services/LoggerService';

/**
 * 每个 useChatStream 实例的批处理器（thinking / tool → streamingStore）。
 * 正文经每轮 run 独占的 StreamRenderBuffer（登记在 sessionStreams 句柄上）上屏。
 */
export interface StreamBatcherRefs {
  thinkingBatcherRef: MutableRefObject<StreamTextBatcher | null>;
  toolBatcherRef: MutableRefObject<StreamValueBatcher<StreamToolCallPatch> | null>;
  openSidePanelOnceRef: MutableRefObject<{ terminal: boolean; diff: boolean }>;
  flushStreamBatchers: () => void;
}

function flushBatcher(
  name: string,
  batcher: { flushNow: () => void } | null
): void {
  try {
    batcher?.flushNow();
  } catch (err) {
    logger.warn(`[chat-stream] ${name} batcher flush failed`, {
      module: 'chat-stream',
      err: toErrMeta(err),
    });
  }
}

export function useStreamBatchers(): StreamBatcherRefs {
  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });

  // Thinking flush into lightweight streamingStore (no immer) so token ticks do
  // not rewrite session messages. Durable commit happens on end/cancel/tool.
  const thinkingBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!thinkingBatcherRef.current) {
    const batcher = new StreamTextBatcher(
      (key, thinking) => {
        const sep = key.indexOf('::');
        if (sep < 0) return;
        const sessionId = key.slice(0, sep);
        const messageId = key.slice(sep + 2);
        setStreamThinking(sessionId, messageId, thinking);
      },
      { intervalMs: 48, maxBufferedChars: 4000 }
    );
    registerStreamBatcher(batcher);
    thinkingBatcherRef.current = batcher;
  }

  // Intermediate tool progress → streamingStore (no immer). Durable terminal
  // statuses (success/error/pending_approval) → single session write + clear lite.
  const toolBatcherRef = useRef<StreamValueBatcher<StreamToolCallPatch> | null>(
    null
  );
  if (!toolBatcherRef.current) {
    const batcher = new StreamValueBatcher<StreamToolCallPatch>(
      (key, patch) => {
        const parsed = parseStreamToolBatchKey(key);
        if (!parsed) return;
        const { sessionId, messageId, toolId } = parsed;
        if (isImmediateToolStatus(patch.status)) {
          commitToolPatchToSession(sessionId, messageId, toolId, patch);
          clearStreamTool(sessionId, messageId, toolId);
          return;
        }
        setStreamTool(sessionId, messageId, toolId, {
          id: toolId,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.arguments !== undefined
            ? { arguments: patch.arguments }
            : {}),
          ...(patch.explanation !== undefined
            ? { explanation: patch.explanation }
            : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.output !== undefined ? { output: patch.output } : {}),
          ...(patch.startedAt !== undefined
            ? { startedAt: patch.startedAt }
            : {}),
          ...(patch.approvalMeta !== undefined
            ? { approvalMeta: patch.approvalMeta }
            : {}),
        });
      },
      { intervalMs: 48, merge: mergeToolCallPatch }
    );
    registerStreamBatcher(batcher as StreamValueBatcher<unknown>);
    toolBatcherRef.current = batcher;
  }

  useEffect(() => {
    const thinkingBatcher = thinkingBatcherRef.current;
    const toolBatcher = toolBatcherRef.current;

    if (thinkingBatcher) registerStreamBatcher(thinkingBatcher);
    if (toolBatcher)
      registerStreamBatcher(toolBatcher as StreamValueBatcher<unknown>);

    return () => {
      if (thinkingBatcher) unregisterStreamBatcher(thinkingBatcher);
      if (toolBatcher)
        unregisterStreamBatcher(toolBatcher as StreamValueBatcher<unknown>);
    };
  }, []);

  const flushStreamBatchers = () => {
    flushBatcher('thinking', thinkingBatcherRef.current);
    flushBatcher('tool', toolBatcherRef.current);
  };

  return {
    thinkingBatcherRef,
    toolBatcherRef,
    openSidePanelOnceRef,
    flushStreamBatchers,
  };
}
