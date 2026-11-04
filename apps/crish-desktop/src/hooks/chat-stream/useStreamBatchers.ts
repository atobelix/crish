import { useRef, useEffect, type MutableRefObject } from 'react';
import {
  StreamValueBatcher,
  parseStreamToolBatchKey,
  mergeToolCallPatch,
  isImmediateToolStatus,
  type StreamToolCallPatch,
} from '../../api/streamTextBatcher';
import {
  clearStreamTool,
  getStreamThinking,
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
/**
 * R6：thinking 增量批合并器。
 *
 * push 收到的是思考 delta（onThought 契约改增量，见 messageHandlers）：
 * 窗口（48ms）内 delta 拼接合并，flush 时追加到 streamingStore 现值——
 * 消除旧全文覆写链路每帧整串回放的 O(n²) 拷贝。set 为全文覆写：先刷出
 * 待写 delta 再覆写（轮次首帧以首个 delta 覆写上一轮累积、message-end
 * 以权威全文收口）。
 */
export interface ThinkingBatcher {
  push: (key: string, delta: string) => void;
  set: (key: string, fullText: string) => void;
  drop: (key: string) => void;
  hasPending: (key?: string) => boolean;
  flushNow: () => void;
  /** beforeunload 注册表句柄（内部 StreamValueBatcher 本体） */
  readonly registryBatcher: StreamValueBatcher<unknown>;
}

function parseThinkingKey(
  key: string
): { sessionId: string; messageId: string } | null {
  const sep = key.indexOf('::');
  if (sep < 0) return null;
  return { sessionId: key.slice(0, sep), messageId: key.slice(sep + 2) };
}

function createThinkingBatcher(): ThinkingBatcher {
  const inner = new StreamValueBatcher<string>(
    (key, chunk) => {
      const parsed = parseThinkingKey(key);
      if (!parsed) return;
      const prev = getStreamThinking(parsed.sessionId, parsed.messageId);
      setStreamThinking(
        parsed.sessionId,
        parsed.messageId,
        prev ? prev + chunk : chunk
      );
    },
    {
      intervalMs: 32,
      merge: (a, b) => a + b,
      // 人本化速度域平滑节流：累计 200 字符强制 flush，消除大块突发刷屏
      maxBufferedSize: 200,
    }
  );
  const batcher: ThinkingBatcher = {
    push: (key, delta) => inner.push(key, delta),
    set: (key, fullText) => {
      inner.flushNow();
      inner.drop(key);
      const parsed = parseThinkingKey(key);
      if (parsed) {
        setStreamThinking(parsed.sessionId, parsed.messageId, fullText);
      }
    },
    drop: (key) => inner.drop(key),
    hasPending: (key) => inner.hasPending(key),
    flushNow: () => inner.flushNow(),
    registryBatcher: inner as StreamValueBatcher<unknown>,
  };
  registerStreamBatcher(batcher.registryBatcher);
  return batcher;
}

export interface StreamBatcherRefs {
  thinkingBatcherRef: MutableRefObject<ThinkingBatcher | null>;
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
  // R6：增量批合并（delta 拼接 + flush 追加），见 ThinkingBatcher 定义。
  const thinkingBatcherRef = useRef<ThinkingBatcher | null>(null);
  if (!thinkingBatcherRef.current) {
    thinkingBatcherRef.current = createThinkingBatcher();
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
      { intervalMs: 32, merge: mergeToolCallPatch }
    );
    registerStreamBatcher(batcher as StreamValueBatcher<unknown>);
    toolBatcherRef.current = batcher;
  }

  useEffect(() => {
    const thinkingBatcher = thinkingBatcherRef.current;
    const toolBatcher = toolBatcherRef.current;

    if (thinkingBatcher) registerStreamBatcher(thinkingBatcher.registryBatcher);
    if (toolBatcher)
      registerStreamBatcher(toolBatcher as StreamValueBatcher<unknown>);

    return () => {
      if (thinkingBatcher)
        unregisterStreamBatcher(thinkingBatcher.registryBatcher);
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
