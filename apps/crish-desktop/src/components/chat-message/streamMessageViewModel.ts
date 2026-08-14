import type { MessageToolCall } from '../../store/types';
import type { StreamToolLive } from '../../store/streamingStore';

export type MsgWithBlocks = {
  text?: string | undefined;
  blocks?: Array<{ type: string; id?: string; content?: string }> | undefined;
};

export type MsgWithTools = {
  text?: string | undefined;
  toolCalls?: MessageToolCall[] | undefined;
  blocks?: Array<{ type: string; id?: string; content?: string }> | undefined;
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

  const blocks = msg.blocks ? msg.blocks.map((b) => ({ ...b })) : [];
  const inBlocks = new Set(
    blocks
      .filter((b) => b.type === 'tool_call' && b.id)
      .map((b) => b.id as string)
  );
  for (const tc of toolCalls) {
    if (!inBlocks.has(tc.id)) {
      blocks.push({ type: 'tool_call', id: tc.id });
      inBlocks.add(tc.id);
    }
  }

  return { ...msg, toolCalls, blocks };
}
