/**
 * 工具调用与消息块三元槽位保全与对齐（timelineReconciler）。
 *
 * 核心能力：
 * 1. alignToolCallBlocks：tool_call 块 ↔ toolCalls 唯一对齐源（V1-δ）；
 * 2. reconcileAssistantMessageBlocks：基于 (turnIndex, type, id) 三元组槽位的无损保全合并（V1-ε）；
 * 3. normalizeAssistantTimeline：规范化助手消息时间线，对齐 blocks / toolCalls / thinkingTurns。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import type { MessageTimelineBlock } from '../../store/types';

/**
 * tool_call 块 ↔ toolCalls 对齐（单一对齐源，V1-δ）。
 *
 * 规则（text 感知插位）：
 * 1. 剔除悬空 tool_call 块（id 不在 tools 中）；
 * 2. 注入缺失 tool_call 块：仅 text/空块时置前，否则插到最后 text 块之前。
 */
export function alignToolCallBlocks(
  blocks: MessageTimelineBlock[] | undefined,
  tools: MessageToolCall[]
): MessageTimelineBlock[] {
  const toolIds = new Set(tools.map((t) => t.id));
  const next = (blocks || []).filter(
    (b) => b.type !== 'tool_call' || (b.id != null && toolIds.has(b.id))
  );
  const inBlocks = new Set(
    next
      .filter((b) => b.type === 'tool_call' && b.id)
      .map((b) => b.id as string)
  );
  const missing = tools.filter((t) => !inBlocks.has(t.id));
  if (missing.length === 0) return next;

  const onlyTextOrEmpty =
    next.length === 0 || next.every((b) => b.type === 'text');
  if (onlyTextOrEmpty) {
    return [
      ...missing.map((t) => ({ type: 'tool_call' as const, id: t.id })),
      ...next,
    ];
  }

  let insertAt = next.length;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.type === 'text') {
      insertAt = i;
      break;
    }
  }
  const inject = missing.map((t) => ({
    type: 'tool_call' as const,
    id: t.id,
  }));
  return [...next.slice(0, insertAt), ...inject, ...next.slice(insertAt)];
}

/**
 * 防御清洗 turnIndex
 */
export function sanitizeTimelineTurnIndex(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Number.isNaN(raw)) return 0;
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

/**
 * Assistant 消息时间线块基于 (turnIndex, type, id) 三元组槽位的无损保全合并算法。
 *
 * 核心设计：
 * 1. 以 `${cleanTurn}:${type}:${id}` 为三元组槽位；
 * 2. 更新对应槽位内容，并 100% 保留已有未被覆盖的历史 thought 与 tool_call 块（orphan blocks 永不丢失）；
 * 3. 严格按流式到达的插入顺序输出——禁止任何 type/turn 强制重排，真实时间线顺序即为唯一权威。
 */
export function reconcileAssistantMessageBlocks(
  existingBlocks: MessageTimelineBlock[] | undefined,
  incomingBlocks: MessageTimelineBlock[]
): MessageTimelineBlock[] {
  const result: MessageTimelineBlock[] = [];
  const existingMap = new Map<string, MessageTimelineBlock>();

  // 1. 注册既有持久块（重点保护 thought 与 tool_call）
  if (existingBlocks && existingBlocks.length > 0) {
    for (const b of existingBlocks) {
      const cleanTurn = sanitizeTimelineTurnIndex(b.turnIndex);
      const key = `${cleanTurn}:${b.type}:${b.id ?? ''}`;
      existingMap.set(key, { ...b, turnIndex: cleanTurn });
    }
  }

  // 2. 融合 incoming blocks
  if (incomingBlocks && incomingBlocks.length > 0) {
    for (const b of incomingBlocks) {
      const cleanTurn = sanitizeTimelineTurnIndex(b.turnIndex);
      const key = `${cleanTurn}:${b.type}:${b.id ?? ''}`;
      if (existingMap.has(key)) {
        result.push({ ...existingMap.get(key)!, ...b, turnIndex: cleanTurn });
        existingMap.delete(key);
      } else {
        result.push({ ...b, turnIndex: cleanTurn });
      }
    }
  }

  // 3. 追加未被覆盖的历史工具与思考块（100% 永久保全历史 orphan 思考块与工具块）
  for (const [, orphan] of existingMap) {
    if (orphan.type === 'tool_call' || orphan.type === 'thought') {
      result.push(orphan);
    }
  }

  // 严格按插入顺序（流式到达顺序）返回，不做任何 type/turn 重排序
  return result;
}

/**
 * 规范化助手消息时间线：blocks 与 toolCalls 对齐，保证可交错渲染。
 * live / hydrate / 持久化共用，避免各写一套顺序。
 */
export function normalizeAssistantTimeline(
  msg: SessionMessage
): SessionMessage {
  if (msg.sender !== 'assistant') return msg;
  const tools = [...(msg.toolCalls || [])];
  let blocks = msg.blocks ? [...msg.blocks] : [];

  // 双向重水合思考链（Hydration Reconciliation）
  if (msg.thinkingTurns && msg.thinkingTurns.length > 0) {
    const existingThoughtTurns = new Set(
      blocks
        .filter((b) => b.type === 'thought' && b.turnIndex != null)
        .map((b) => sanitizeTimelineTurnIndex(b.turnIndex))
    );
    for (const tt of msg.thinkingTurns) {
      const cleanTurn = sanitizeTimelineTurnIndex(tt.turnIndex);
      if (tt.content?.trim() && !existingThoughtTurns.has(cleanTurn)) {
        const thoughtBlock: MessageTimelineBlock = {
          type: 'thought',
          content: tt.content,
          turnIndex: cleanTurn,
          durationMs: tt.durationMs,
          id: tt.id || `thought-turn-${cleanTurn}`,
        };
        // 严格保持自然因果时序：思考必然在工具之前发生
        if (cleanTurn === 0) {
          blocks.unshift(thoughtBlock);
        } else {
          blocks.push(thoughtBlock);
        }
      }
    }
  } else if (
    (msg.thinking || '').trim() &&
    !blocks.some((b) => b.type === 'thought')
  ) {
    const thoughtBlock: MessageTimelineBlock = {
      type: 'thought',
      content: msg.thinking || '',
      turnIndex: 0,
      durationMs: msg.thinkingTime ? msg.thinkingTime * 1000 : undefined,
      id: 'thought-legacy',
    };
    // 关键：若此前完全没有 thought 块，思考必然是在整条助手消息最开始发生的，
    // 严格置于首位，绝不追加到正文之后或插入到已有工具之后
    blocks.unshift(thoughtBlock);
  }

  const alignedBlocks = alignToolCallBlocks(blocks, tools);

  // 有正文但无 text 块时补偿
  if (
    (msg.text || '').trim() &&
    !alignedBlocks.some((b) => b.type === 'text')
  ) {
    alignedBlocks.push({ type: 'text', content: msg.text || '', turnIndex: 0 });
  }

  const finalBlocks = reconcileAssistantMessageBlocks(
    msg.blocks,
    alignedBlocks
  );

  return {
    ...msg,
    toolCalls: tools,
    blocks: finalBlocks,
  };
}

