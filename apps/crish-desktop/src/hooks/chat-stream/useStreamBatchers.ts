import { useRef, useEffect, type MutableRefObject } from 'react';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  isImmediateToolStatus,
  type StreamToolCallPatch,
} from '../../api/streamTextBatcher';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import {
  clearStreamTool,
  setStreamText,
  setStreamThinking,
  setStreamTool,
} from '../../store/streamingStore';
import { commitToolPatchToSession } from './helpers';
import { registerStreamBatcher, unregisterStreamBatcher } from '../../api/beforeunloadFlush';

export interface StreamBatcherRefs {
  streamManagerRef: MutableRefObject<SessionStreamManager | null>;
  textBatcherRef: MutableRefObject<StreamTextBatcher | null>;
  thinkingBatcherRef: MutableRefObject<StreamTextBatcher | null>;
  toolBatcherRef: MutableRefObject<StreamValueBatcher<StreamToolCallPatch> | null>;
  renderBufferRef: MutableRefObject<StreamRenderBuffer | null>;
  openSidePanelOnceRef: MutableRefObject<{ terminal: boolean; diff: boolean }>;
  flushStreamBatchers: () => void;
}

export function useStreamBatchers(): StreamBatcherRefs {
  const streamManagerRef = useRef<SessionStreamManager | null>(null);
  if (!streamManagerRef.current) {
    streamManagerRef.current = new SessionStreamManager();
  }

  const openSidePanelOnceRef = useRef({ terminal: false, diff: false });

  // Text/thinking flush into lightweight streamingStore (no immer) so token
  // ticks do not rewrite session messages. Durable commit happens on end/cancel/tool.
  const textBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!textBatcherRef.current) {
    const batcher = new StreamTextBatcher(
      (key, text) => {
        const sep = key.indexOf('::');
        if (sep < 0) return;
        const sessionId = key.slice(0, sep);
        const messageId = key.slice(sep + 2);
        setStreamText(sessionId, messageId, text);
      },
      { intervalMs: 48, maxBufferedChars: 8000 }
    );
    registerStreamBatcher(batcher);
    textBatcherRef.current = batcher;
  }

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
  const toolBatcherRef = useRef<StreamValueBatcher<StreamToolCallPatch> | null>(null);
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
    const textBatcher = textBatcherRef.current;
    const thinkingBatcher = thinkingBatcherRef.current;
    const toolBatcher = toolBatcherRef.current;

    if (textBatcher) registerStreamBatcher(textBatcher);
    if (thinkingBatcher) registerStreamBatcher(thinkingBatcher);
    if (toolBatcher) registerStreamBatcher(toolBatcher as StreamValueBatcher<unknown>);

    return () => {
      if (textBatcher) unregisterStreamBatcher(textBatcher);
      if (thinkingBatcher) unregisterStreamBatcher(thinkingBatcher);
      if (toolBatcher) unregisterStreamBatcher(toolBatcher as StreamValueBatcher<unknown>);
    };
  }, []);

  const renderBufferRef = useRef<StreamRenderBuffer | null>(null);

  const flushStreamBatchers = () => {
    try { textBatcherRef.current?.flushNow(); } catch { /* ignore */ }
    try { thinkingBatcherRef.current?.flushNow(); } catch { /* ignore */ }
    try { toolBatcherRef.current?.flushNow(); } catch { /* ignore */ }
  };

  return {
    streamManagerRef,
    textBatcherRef,
    thinkingBatcherRef,
    toolBatcherRef,
    renderBufferRef,
    openSidePanelOnceRef,
    flushStreamBatchers,
  };
}
