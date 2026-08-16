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
 * 将流式文本无损合入 SessionMessage 的纯函数视图模型转换器
 * Merge live stream text into a message view-model for timeline rendering.
 * Prefers full cumulative stream text; appends trailing delta after durable
 * blocks when tools already committed a text prefix into the session store.
 */
export function applyStreamTextToMessage<T extends MsgWithBlocks>(
  msg: T,
  streamText: string | undefined
): T {
  if (streamText == null) return msg;
  const committed = msg.text || '';
  if (streamText === committed) return msg;

  if (!msg.blocks?.length) {
    return { ...msg, text: streamText };
  }

  const trailing =
    committed && streamText.startsWith(committed)
      ? streamText.slice(committed.length)
      : committed
        ? null
        : streamText;

  if (trailing === null) {
    // Divergence: use stream as authoritative full text for display.
    return { ...msg, text: streamText };
  }
  if (!trailing) {
    return { ...msg, text: streamText };
  }

  const blocks = msg.blocks.map((b) => ({ ...b }));
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text') {
    blocks[blocks.length - 1] = {
      ...last,
      content: (last.content || '') + trailing,
    };
  } else {
    blocks.push({ type: 'text', content: trailing });
  }
  return { ...msg, text: streamText, blocks };
}

/**
 * 将流式中间工具状态无损合入 SessionMessage 的纯函数视图模型转换器
 * Merge intermediate tool rows from streamingStore into a message view-model.
 * Does not downgrade terminal session statuses (success/error).
 * Ensures tool_call blocks exist so timeline cards render live.
 */
export function applyStreamToolsToMessage<T extends MsgWithTools>(
  msg: T,
  tools: Record<string, StreamToolLive> | undefined
): T {
  if (!tools) return msg;
  const ids = Object.keys(tools);
  if (ids.length === 0) return msg;

  const toolCalls = [...(msg.toolCalls || [])];
  const indexById = new Map(toolCalls.map((t, i) => [t.id, i]));
  let changed = false;

  for (const toolId of ids) {
    const live = tools[toolId];
    if (!live) continue;
    const idx = indexById.get(toolId);
    if (idx === undefined) {
      const tc: MessageToolCall = {
        id: toolId,
        name: live.name || 'tool',
        status: live.status || 'running',
        ...(live.arguments !== undefined ? { arguments: live.arguments } : {}),
        ...(live.explanation !== undefined
          ? { explanation: live.explanation }
          : {}),
        ...(live.output !== undefined ? { output: live.output } : {}),
        ...(live.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
        ...(live.approvalMeta !== undefined
          ? { approvalMeta: live.approvalMeta }
          : {}),
      };
      indexById.set(toolId, toolCalls.length);
      toolCalls.push(tc);
      changed = true;
      continue;
    }
    const existing = toolCalls[idx]!;
    // Never let intermediate lite state clobber durable terminal rows.
    if (existing.status === 'success' || existing.status === 'error') {
      continue;
    }
    const merged: MessageToolCall = {
      ...existing,
      ...(live.name !== undefined ? { name: live.name } : {}),
      ...(live.arguments !== undefined ? { arguments: live.arguments } : {}),
      ...(live.explanation !== undefined
        ? { explanation: live.explanation }
        : {}),
      ...(live.status !== undefined ? { status: live.status } : {}),
      ...(live.output !== undefined ? { output: live.output } : {}),
      ...(live.startedAt !== undefined ? { startedAt: live.startedAt } : {}),
      ...(live.approvalMeta !== undefined
        ? { approvalMeta: live.approvalMeta }
        : {}),
    };
    if (
      merged.name !== existing.name ||
      merged.arguments !== existing.arguments ||
      merged.explanation !== existing.explanation ||
      merged.status !== existing.status ||
      merged.output !== existing.output ||
      merged.startedAt !== existing.startedAt ||
      merged.approvalMeta !== existing.approvalMeta
    ) {
      toolCalls[idx] = merged;
      changed = true;
    }
  }

  if (!changed) return msg;

  // V1-δ（对齐单源）：tool_call 块补齐复用 normalizeAssistantTimeline 的
  // 单一对齐纯函数 alignToolCallBlocks（原内联 append 补齐已删；插位语义
  // 与持久化/水合路径一致——仅 text/空块置前，否则插到最后 text 块之前）。
  return {
    ...msg,
    toolCalls,
    blocks: alignToolCallBlocks(msg.blocks, toolCalls),
  };
}

/** 流式渲染 view model（T4 A1：投影链单源装配产物，页面壳层只收此结果） */
export interface StreamMessageViewModel {
  /** 已合并流式正文/工具的渲染消息投影（热缓冲无条目时 = 原消息引用） */
  msg: SessionMessage;
  /** 流式累积正文（undefined = 热缓冲无条目；驱动流式增量区与图片扫描） */
  streamText: string | undefined;
}

/** 稳定空切片：非 live 行在 byKey tick 上零重渲染（原 MessageContent 内联常量上移） */
const EMPTY_STREAM_BODY: {
  text: string | undefined;
  tools: Record<string, StreamToolLive> | undefined;
} = { text: undefined, tools: undefined };

/**
 * 流式 view model 装配（T4 A1：渲染期 merge 从组件内联上移到壳层单点）。
 *
 * - 订阅 streamingStore 热缓冲 byKey（useShallow 浅比较，与旧内联订阅同构）；
 * - 防撕裂平滑三元降级公式（原 MessageContent「关键防御 2」原样上移）：
 *   1. 仅当持久化 msg.text 非空且状态 completed 才完全信任持久化 text；
 *   2. 否则 streamText 存在时无条件优先；
 *   3. 兜底 msg.text；
 * - 工具中间态经 applyStreamToolsToMessage 合并（不降级终态行）。
 * 热缓冲写入/清理路径（streamingStore actions + commitStreamToSession 的
 * queueMicrotask clearStream 时序闭环）不在此触碰。
 */
export function useStreamMessageViewModel(
  msg: SessionMessage,
  sessionId: string | undefined
): StreamMessageViewModel {
  const { text: streamText, tools: streamTools } = useStreamingStore(
    useShallow((s) => {
      if (!sessionId) return EMPTY_STREAM_BODY;
      const e = s.byKey[streamStoreKey(sessionId, msg.id)];
      if (!e) return EMPTY_STREAM_BODY;
      return { text: e.text, tools: e.tools };
    })
  );

  const merged = useMemo(() => {
    let next: SessionMessage = msg;
    const hasCommittedText = Boolean(msg.text && msg.text.trim().length > 0);
    const activeText =
      hasCommittedText && msg.status === 'completed'
        ? msg.text
        : (streamText ?? msg.text);

    if (activeText != null && activeText !== msg.text) {
      next = applyStreamTextToMessage(next, activeText) as SessionMessage;
    }
    if (streamTools) {
      next = applyStreamToolsToMessage(next, streamTools);
    }
    return next;
  }, [msg, streamText, streamTools]);

  return { msg: merged, streamText };
}
