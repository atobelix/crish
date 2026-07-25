import { useRef, useEffect, type MutableRefObject } from 'react';
import { StreamRenderBuffer } from '../../api/StreamRenderBuffer';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  streamBatchKey,
  streamToolBatchKey,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  type StreamToolCallPatch,
} from '../../api/streamTextBatcher';
import { SessionStreamManager } from '../../api/sessionStreamManager';
import { useLayoutStore } from '../../store/layoutStore';
import { getSessionById } from '../../store/sessionStore';
import { updateMessageText, updateMessageThinking } from '../../api/storeAccess';
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

  const textBatcherRef = useRef<StreamTextBatcher | null>(null);
  if (!textBatcherRef.current) {
    const batcher = new StreamTextBatcher(
      (key, text) => {
        const sep = key.indexOf('::');
        if (sep < 0) return;
        const sessionId = key.slice(0, sep);
        const messageId = key.slice(sep + 2);
        updateMessageText(sessionId, messageId, text);
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
        updateMessageThinking(sessionId, messageId, thinking);
      },
      { intervalMs: 48, maxBufferedChars: 4000 }
    );
    registerStreamBatcher(batcher);
    thinkingBatcherRef.current = batcher;
  }

  const toolBatcherRef = useRef<StreamValueBatcher<StreamToolCallPatch> | null>(null);
  if (!toolBatcherRef.current) {
    const batcher = new StreamValueBatcher<StreamToolCallPatch>(
      (key, patch) => {
        const parsed = parseStreamToolBatchKey(key);
        if (!parsed) return;
        const { sessionId, messageId, toolId } = parsed;
        const live = useLayoutStore.getState();
        const existing = getSessionById(sessionId)
          ?.messages?.find((m) => m.id === messageId)
          ?.toolCalls?.find((t) => t.id === toolId);
        const updates = { ...patch };
        delete updates.id;
        if (existing) {
          live.updateMessageToolCall(sessionId, messageId, toolId, updates);
        } else {
          live.addMessageToolCall(sessionId, messageId, {
            id: toolId,
            name: patch.name || 'tool',
            arguments: patch.arguments || '',
            explanation: patch.explanation,
            status: patch.status || 'running',
            output: patch.output,
            diffs: patch.diffs,
            approvalMeta: patch.approvalMeta,
          });
        }
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
