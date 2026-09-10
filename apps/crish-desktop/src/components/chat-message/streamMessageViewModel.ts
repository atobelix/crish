import { useMemo } from 'react';
import type {
  MessageTimelineBlock,
  MessageToolCall,
  SessionMessage,
} from '../../store/types';
import { alignToolCallBlocks } from '../../api/tool-presentation/timelineNormalizer';
import {
  useStreamingStore,
  useShallow,
  streamStoreKey,
  type StreamToolLive,
} from '../../store/storeAccess';

export type MsgWithBlocks = {
  text?: string | undefined;
  blocks?: Array<{ type: string; id?: string; content?: string }> | undefined;
};

export type MsgWithTools = {
  text?: string | undefined;
  toolCalls?: MessageToolCall[] | undefined;
  blocks?: MessageTimelineBlock[] | undefined;
};

/**
 * 单轨流式正文直通纯函数
 * Pass-through authoritative stream text into message view model.
 * 彻底废除基于 startsWith 与 trailing delta 的盲猜切片拼接，以单轨权威正文直通。
 */
export function applyStreamTextToMessage<T extends MsgWithBlocks>(
  msg: T,
  streamText: string | undefined
): T {
  if (streamText == null || streamText === msg.text) {
    return msg;
  }
  return { ...msg, text: streamText };
}

/**
 * 单轨流式工具状态直通纯函数
 * Merge live tool calls into message view model without Map ledger or race guessing.
 * 不降级已完成终态（success/error），保持 tool_call 块对齐。
 */
export function applyStreamToolsToMessage<T extends MsgWithTools>(
  msg: T,
  tools: Record<string, StreamToolLive> | undefined
): T {
  if (!tools) return msg;
  const entries = Object.entries(tools);
  if (entries.length === 0) return msg;

  const toolCalls = [...(msg.toolCalls || [])];
  let changed = false;

  for (const [toolId, live] of entries) {
    if (!live) continue;
    const idx = toolCalls.findIndex((t) => t.id === toolId);
    if (idx === -1) {
      const { id: _liveId, ...restLive } = live;
      toolCalls.push({
        id: toolId,
        name: live.name || 'tool',
        status: live.status || 'running',
        ...restLive,
      });
      changed = true;
    } else {
      const existing = toolCalls[idx]!;
      if (existing.status === 'success' || existing.status === 'error') {
        continue;
      }
      toolCalls[idx] = { ...existing, ...live };
      changed = true;
    }
  }

  if (!changed) return msg;

  return {
    ...msg,
    toolCalls,
    blocks: alignToolCallBlocks(msg.blocks, toolCalls),
  };
}

/** 流式渲染 view model（单轨装配产物） */
export interface StreamMessageViewModel {
  /** 已合并流式正文/工具的渲染消息投影（热缓冲无条目时 = 原消息引用） */
  msg: SessionMessage;
  /** 流式累积正文（undefined = 热缓冲无条目；驱动流式增量区与图片扫描） */
  streamText: string | undefined;
}

/** 稳定空切片：非 live 行在 byKey tick 上零重渲染 */
const EMPTY_STREAM_BODY: {
  text: string | undefined;
  tools: Record<string, StreamToolLive> | undefined;
  thinking: string | undefined;
} = { text: undefined, tools: undefined, thinking: undefined };

/**
 * 流式 view model 装配纯受控挂载点。
 * 订阅 streamingStore 单轨热缓冲，废除防撕裂平滑三元降级补丁，
 * 直接以单轨流式数据驱动纯函数直通。
 */
export function useStreamMessageViewModel(
  msg: SessionMessage,
  sessionId: string | undefined
): StreamMessageViewModel {
  const {
    text: streamText,
    tools: streamTools,
    thinking: streamThinking,
  } = useStreamingStore(
    useShallow((s) => {
      if (!sessionId) return EMPTY_STREAM_BODY;
      const e = s.byKey[streamStoreKey(sessionId, msg.id)];
      if (!e) return EMPTY_STREAM_BODY;
      return { text: e.text, tools: e.tools, thinking: e.thinking };
    })
  );

  const merged = useMemo(() => {
    let next: SessionMessage = msg;
    if (
      streamThinking != null &&
      streamThinking.trim() !== '' &&
      streamThinking !== msg.thinking
    ) {
      next = { ...next, thinking: streamThinking };
    }
    if (streamTools) {
      next = applyStreamToolsToMessage(next, streamTools);
    }
    if (streamText != null && streamText !== msg.text) {
      next = applyStreamTextToMessage(next, streamText);
    }
    return next;
  }, [msg, streamText, streamTools, streamThinking]);

  return { msg: merged, streamText };
}
