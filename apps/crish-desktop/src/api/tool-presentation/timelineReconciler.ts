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
 * 规则（因果时间戳就近插位）：
 * 1. 剔除悬空 tool_call 块（id 不在 tools 中）；
 * 2. 注入缺失 tool_call 块：
 *    - 全为 text / 空块时置前；
 *    - 否则若工具带 `startedAt`，按**因果时间戳就近**插回其真实发生的时段之间；
 *    - 兜底（时间戳未知）：插到**首个正文块之前**，绝不盲目跨越到尾部正文之前。
 *
 * 【历史缺陷】旧实现一律插到「最后一个 text 块之前」，于是
 *   正文 1 → 工具 2 → 正文 2
 * 场景下若工具 1 缺失，它会被插在正文 2 之前（即工具 2 之后），时序彻底倒流。
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

  // 逐个执行因果就近插位（每插一个即更新基线，保证多缺失工具的相对次序）
  for (const t of missing) {
    const inject = { type: 'tool_call' as const, id: t.id };
    const tTime = t.startedAt;
    let insertAt = -1;

    if (typeof tTime === 'number' && Number.isFinite(tTime) && tTime > 0) {
      for (let i = 0; i < next.length; i++) {
        const bTime = next[i]?.startTime;
        if (
          typeof bTime === 'number' &&
          Number.isFinite(bTime) &&
          bTime > tTime
        ) {
          insertAt = i;
          break;
        }
      }
    }

    // 兜底：插到首个正文块之前（绝不跨到尾部正文之前）
    if (insertAt < 0) {
      const firstTextIdx = next.findIndex((b) => b.type === 'text');
      insertAt = firstTextIdx >= 0 ? firstTextIdx : next.length;
    }

    next.splice(insertAt, 0, inject);
  }

  return next;
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
 * 为时间线块生成抗碰撞的稳定槽位 Key。
 *
 * 【历史缺陷】旧 Key 为 `${turn}:${type}:${id ?? ''}`，而历史 `text` 块既无 `id`
 * 且 `turnIndex` 恒被清洗为 `0`，于是整条消息的所有正文块 Key 全部退化为
 * `"0:text:"`——后一个正文块在 `Map.set` 时直接把前一个**覆盖抹杀**。
 *
 * 现契约：有显式 id 走 id；无 id 块（尤其是 text）按「同 turn 同 type 的出现序号」
 * 分配序列槽位，existing 与 incoming 各自从 0 计数，从而第 N 个 incoming 正文
 * 精准对齐第 N 个 existing 正文。
 */
function getReconciliationSlotKey(
  b: MessageTimelineBlock,
  cleanTurn: number,
  typeSeqMap: Map<string, number>
): string {
  if (typeof b.id === 'string' && b.id.trim()) {
    return `${cleanTurn}:${b.type}:${b.id.trim()}`;
  }
  const typeKey = `${cleanTurn}:${b.type}`;
  const seq = typeSeqMap.get(typeKey) ?? 0;
  typeSeqMap.set(typeKey, seq + 1);
  return `${cleanTurn}:${b.type}:#seq_${seq}`;
}

/**
 * Assistant 消息时间线块基于 (turnIndex, type, id) 三元组槽位的无损保全合并算法。
 *
 * 核心设计：
 * 1. 槽位 Key 由 `getReconciliationSlotKey` 唯一裁决（id 优先，否则按序号，禁止碰撞）；
 * 2. 更新对应槽位内容，并 100% 保留已有未被覆盖的历史块（orphan blocks 永不丢失，
 *    含正文——正文同样是真实时间线成员，不得因类型而被丢弃）；
 * 3. 严格按流式到达的插入顺序输出——禁止任何 type/turn 强制重排，真实时间线顺序即为唯一权威。
 */
export function reconcileAssistantMessageBlocks(
  existingBlocks: MessageTimelineBlock[] | undefined,
  incomingBlocks: MessageTimelineBlock[]
): MessageTimelineBlock[] {
  const result: MessageTimelineBlock[] = [];
  const existingMap = new Map<string, MessageTimelineBlock>();
  const existingSeqMap = new Map<string, number>();

  // 1. 注册既有持久块（重点保护 thought、tool_call 与多段 text）
  if (existingBlocks && existingBlocks.length > 0) {
    for (const b of existingBlocks) {
      const cleanTurn = sanitizeTimelineTurnIndex(b.turnIndex);
      const key = getReconciliationSlotKey(b, cleanTurn, existingSeqMap);
      existingMap.set(key, { ...b, turnIndex: cleanTurn });
    }
  }

  // 2. 融合 incoming blocks
  const incomingSeqMap = new Map<string, number>();
  if (incomingBlocks && incomingBlocks.length > 0) {
    for (const b of incomingBlocks) {
      const cleanTurn = sanitizeTimelineTurnIndex(b.turnIndex);
      const key = getReconciliationSlotKey(b, cleanTurn, incomingSeqMap);
      if (existingMap.has(key)) {
        result.push({ ...existingMap.get(key)!, ...b, turnIndex: cleanTurn });
        existingMap.delete(key);
      } else {
        result.push({ ...b, turnIndex: cleanTurn });
      }
    }
  }

  // 3. 追加未被覆盖的历史孤儿块（100% 永久保全历史思考、工具与独立正文段）
  for (const [, orphan] of existingMap) {
    result.push(orphan);
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

  // 历史误置 thought-legacy 自愈：若存在旧版缺陷生成的 thought-legacy 且落在工具调用之后，移回首位
  const legacyIdx = blocks.findIndex(
    (b) => b.type === 'thought' && b.id === 'thought-legacy'
  );
  if (legacyIdx > 0) {
    const [legacy] = blocks.splice(legacyIdx, 1);
    blocks.unshift(legacy!);
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

