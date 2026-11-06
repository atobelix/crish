/**
 * 工具调用与消息块三元槽位保全与对齐（timelineReconciler）。
 *
 * 核心能力：
 * 1. alignToolCallBlocks：tool_call 块 ↔ toolCalls 唯一对齐源（V1-δ）；
 * 2. reconcileAssistantMessageBlocks：基于 (turnIndex, type, id) 三元组槽位的无损保全合并（V1-ε）；
 *    未被 incoming 覆盖的孤儿块按其在既有序列中的邻居锚点回插原位，禁止一律追加末尾；
 * 3. normalizeAssistantTimeline：规范化助手消息时间线，对齐 blocks / toolCalls / thinkingTurns；
 * 4. applyStreamedTextToBlocks：正文分段记账的唯一实现——流式正文按段建块
 *    （稳定 id `text-seg-<序号>` + turnIndex），段与段之间以 tool_call / thought
 *    块为物理界标；主流路径、子代理回调与事件投影共用同一套机制，无第二实现。
 *
 * 【已删除的旧模型】单一 `streamTextOffset` 累计偏移切片：正文段靠「最后界标后
 * 一段」的偏移算术维护，最终权威正文短于偏移时尾段永不落块，完成收口只能把
 * 整条正文拼成一块追加末尾——交错时序（正文→工具→正文）在落盘形态里被系统性
 * 抹平（sess-1793884211510 事故根因）。该模型及其补偿已整段删除，不得恢复。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import type { MessageTimelineBlock } from '../../store/types';

/**
 * tool_call 块 ↔ toolCalls 对齐（单一对齐源，V1-δ）。
 *
 * 规则（因果时间戳就近插位）：
 * 1. 剔除悬空 tool_call 块（id 不在 tools 中）；
 * 2. 注入缺失 tool_call 块：
 *    - 若工具带 `startedAt`，按**因果时间戳就近**插回其真实发生的时段之间；
 *    - 兜底（时间戳未知或无后续时间块）：**始终就后追加（next.length）**，严禁越过已有正文逆序前置。
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

    // 兜底：始终就后追加（绝不越过已有正文逆序前置）
    if (insertAt < 0) {
      insertAt = next.length;
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

/** 正文段之间的物理界标块类型：界标之后的正文属于新的一段。 */
const TEXT_SEGMENT_DELIMITER_TYPES: ReadonlySet<string> = new Set([
  'tool_call',
  'thought',
]);

/** 新分段模型下正文段块的稳定 id 前缀（序号 = 该消息内正文段的创建序，永不复用）。 */
export const TEXT_SEGMENT_ID_PREFIX = 'text-seg-';

/**
 * 推导新正文段的 turnIndex：以最近一个 thought 块的 turn 为准（思考与正文同轮），
 * 其次调用方的轮次提示，最后 0。turnIndex 只是元数据——段的身份由 id 承载，
 * 一经创建永不改写（改写会使 reconcile 槽位 Key 漂移、同一段裂成两块）。
 */
function deriveTextSegmentTurnIndex(
  blocks: MessageTimelineBlock[],
  turnHint?: number
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === 'thought' && b.turnIndex != null) {
      return sanitizeTimelineTurnIndex(b.turnIndex);
    }
  }
  if (turnHint != null) return sanitizeTimelineTurnIndex(turnHint);
  return 0;
}

/**
 * 正文分段记账（唯一实现）：把消息累计正文从 prevText 推进到 nextText，
 * 同步维护 blocks 中的正文段块。就地修改 blocks 数组（调用方传 store 草稿
 * 或普通数组均可）。
 *
 * 段模型：
 * - 每个正文段是一个 text 块，创建即带稳定 id 与 turnIndex，按事件序入 blocks；
 * - 最后一个 text 块之后若再无界标块（tool_call / thought），它就是**活跃段**，
 *   流式增长只往活跃段追加；界标块落下即**封口**其前一段，其后正文另起新段；
 * - 累计正文只增（append-only）是流式常态，走增量追加；
 * - 非增量改写（message-end 权威全文、收口择优全文、占位符清理）走锚点重对齐：
 *   已封口段以其现有内容（trim 后）为锚在新全文中顺序定位并换成新版本，
 *   剩余尾部归活跃段（无活跃段则新建段）——已封口段永不被改写吞并、
 *   永不整段丢失，相对顺序永不改变；
 * - opts.sealActive：段的终结不以界标块为唯一信号——事件投影里引擎消息
 *   切换（新 message-start / message-end）即封口上一段，调用方据此宣告，
 *   防止相邻两段正文在无工具间隔时被并成一段。
 */
export function applyStreamedTextToBlocks(
  blocks: MessageTimelineBlock[],
  prevText: string,
  nextText: string,
  opts?: { turnHint?: number; sealActive?: boolean; now?: number }
): void {
  if (nextText === prevText) return;
  const now = opts?.now ?? Date.now();

  const textIdxs: number[] = [];
  let lastDelimiterIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.type === 'text') textIdxs.push(i);
    else if (TEXT_SEGMENT_DELIMITER_TYPES.has(b.type)) lastDelimiterIdx = i;
  }
  const lastTextIdx = textIdxs.length > 0 ? textIdxs[textIdxs.length - 1]! : -1;
  // sealActive：调用方明确宣告上一段已终结（如事件投影里引擎消息切换）——
  // 即便其后尚无界标块，也不得再把新正文并入该段，按已封口处理。
  const activeIdx =
    !opts?.sealActive && lastTextIdx > lastDelimiterIdx ? lastTextIdx : -1;

  const createSegment = (content: string): void => {
    blocks.push({
      type: 'text',
      id: `${TEXT_SEGMENT_ID_PREFIX}${textIdxs.length}`,
      content,
      turnIndex: deriveTextSegmentTurnIndex(blocks, opts?.turnHint),
      startTime: now,
    });
    textIdxs.push(blocks.length - 1);
  };

  // 清空：所有段内容一并清空（段块本身保留，维持 id/顺序稳定）
  if (!nextText) {
    for (const i of textIdxs) blocks[i]!.content = '';
    return;
  }

  // 增量追加（流式常态）：只长不缩短，直接并入活跃段
  if (prevText && nextText.startsWith(prevText)) {
    const increment = nextText.slice(prevText.length);
    if (!increment) return;
    if (activeIdx >= 0) {
      const b = blocks[activeIdx]!;
      b.content = (b.content || '') + increment;
      if (b.startTime) b.durationMs = Math.max(0, now - b.startTime);
    } else {
      const seg = textIdxs.length > 0 ? increment.replace(/^\n+/, '') : increment;
      if (seg) createSegment(seg);
    }
    return;
  }

  // 权威改写：锚点重对齐已封口段 + 尾部归活跃段
  let cursor = 0;
  const anchorIdxs = activeIdx >= 0 ? textIdxs.slice(0, -1) : textIdxs;
  for (const i of anchorIdxs) {
    const b = blocks[i]!;
    const anchor = (b.content || '').trim();
    if (!anchor) continue;
    const pos = nextText.indexOf(anchor, cursor);
    if (pos < 0) continue; // 定位失败：保留旧内容、游标不动（有界退化，绝不丢段）
    b.content = nextText.slice(cursor, pos + anchor.length).replace(/^\n+/, '');
    cursor = pos + anchor.length;
  }
  const remainder = nextText.slice(cursor).replace(/^\n+/, '');
  if (activeIdx >= 0) {
    const b = blocks[activeIdx]!;
    b.content = remainder;
    if (b.startTime) b.durationMs = Math.max(0, now - b.startTime);
  } else if (remainder) {
    createSegment(remainder);
  }
}

/**
 * 从流式缓冲全文中切出**活跃段**的正文（渲染层用）：已封口段的内容依次从
 * 缓冲头部锚定剥离，剩余即活跃段（含尚未快照落块的最新增量）。
 * 无已封口段时原样返回（与旧偏移为 0 的行为一致）；剥离过至少一段时
 * 去除段间前导换行（与旧偏移切片行为一致）。锚定失败即停（宁可少量重复，
 * 绝不丢正文）。
 */
export function sliceActiveStreamText(
  streamText: string,
  blocks: MessageTimelineBlock[] | undefined
): string {
  if (!streamText || !blocks || blocks.length === 0) return streamText;
  let lastDelimiterIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (TEXT_SEGMENT_DELIMITER_TYPES.has(blocks[i]!.type)) lastDelimiterIdx = i;
  }
  if (lastDelimiterIdx < 0) return streamText;
  let rest = streamText;
  let strippedAny = false;
  for (let i = 0; i < lastDelimiterIdx; i++) {
    const b = blocks[i]!;
    if (b.type !== 'text') continue;
    const anchor = (b.content || '').trim();
    if (!anchor) continue;
    const pos = rest.indexOf(anchor);
    if (pos < 0) break;
    rest = rest.slice(pos + anchor.length);
    strippedAny = true;
  }
  return strippedAny ? rest.replace(/^\n+/, '') : streamText;
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
  const resultKeys: string[] = [];
  const existingMap = new Map<string, MessageTimelineBlock>();
  const existingOrdered: { key: string; block: MessageTimelineBlock }[] = [];
  const existingSeqMap = new Map<string, number>();

  // 1. 注册既有持久块（重点保护 thought、tool_call 与多段 text），并保留既有全序
  if (existingBlocks && existingBlocks.length > 0) {
    for (const b of existingBlocks) {
      const cleanTurn = sanitizeTimelineTurnIndex(b.turnIndex);
      const key = getReconciliationSlotKey(b, cleanTurn, existingSeqMap);
      const normalized = { ...b, turnIndex: cleanTurn };
      existingMap.set(key, normalized);
      existingOrdered.push({ key, block: normalized });
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
      resultKeys.push(key);
    }
  }

  // 3. 未被覆盖的历史孤儿块按其在既有序列中的原位置回插（100% 保全内容，
  //    且相对顺序不变）：优先锚定最近的已落位前邻，其次最近的已落位后邻，
  //    两者皆无（incoming 与既有完全 disjoint）时才按既有序追加到末尾。
  //    【已删除的旧行为】孤儿一律追加末尾——中间正文段在收口时被沉到整轮
  //    末尾与最终总结拼接，是交错时序被打乱的直接机关之一。
  for (let oi = 0; oi < existingOrdered.length; oi++) {
    const { key, block } = existingOrdered[oi]!;
    if (!existingMap.has(key)) continue; // 已被 incoming 覆盖融合
    let insertAt = -1;
    for (let j = oi - 1; j >= 0; j--) {
      const ri = resultKeys.indexOf(existingOrdered[j]!.key);
      if (ri >= 0) {
        insertAt = ri + 1;
        break;
      }
    }
    if (insertAt < 0) {
      for (let j = oi + 1; j < existingOrdered.length; j++) {
        const ri = resultKeys.indexOf(existingOrdered[j]!.key);
        if (ri >= 0) {
          insertAt = ri;
          break;
        }
      }
    }
    if (insertAt < 0) insertAt = result.length;
    result.splice(insertAt, 0, block);
    resultKeys.splice(insertAt, 0, key);
    existingMap.delete(key);
  }

  // 严格按插入顺序（流式到达顺序）返回，不做任何 type/turn 重排序
  return result;
}

/**
 * 把重水合的思考块按其轮次插回因果位置（禁止一律追加末尾——那会把中段
 * 轮次的思考沉到整条消息之后）：
 * 1. 同轮已有 text 块 → 插到它之前（思考先于同轮正文）；
 * 2. 否则有更大 turnIndex 的块 → 插到第一个之前；
 * 3. 否则 turn 0 → 置首（首轮思考先于一切）；
 * 4. 否则追加末尾（该轮即最末轮，末尾正是其保序位置）。
 */
function insertThoughtBlockAtTurnPosition(
  blocks: MessageTimelineBlock[],
  thoughtBlock: MessageTimelineBlock,
  cleanTurn: number
): void {
  const sameTurnTextIdx = blocks.findIndex(
    (b) =>
      b.type === 'text' &&
      b.turnIndex != null &&
      sanitizeTimelineTurnIndex(b.turnIndex) === cleanTurn
  );
  if (sameTurnTextIdx >= 0) {
    blocks.splice(sameTurnTextIdx, 0, thoughtBlock);
    return;
  }
  const laterTurnIdx = blocks.findIndex(
    (b) =>
      b.turnIndex != null &&
      sanitizeTimelineTurnIndex(b.turnIndex) > cleanTurn
  );
  if (laterTurnIdx >= 0) {
    blocks.splice(laterTurnIdx, 0, thoughtBlock);
    return;
  }
  if (cleanTurn === 0) {
    blocks.unshift(thoughtBlock);
    return;
  }
  blocks.push(thoughtBlock);
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
  const blocks = msg.blocks ? [...msg.blocks] : [];

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
        insertThoughtBlockAtTurnPosition(blocks, thoughtBlock, cleanTurn);
        existingThoughtTurns.add(cleanTurn);
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
      durationMs: undefined,
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

  // 无账本兜底（严格限定）：正文存在、但 blocks 与既有块中**一概没有任何
  // text 块**（分段记账从未在此消息上运行过，如远古存量数据）时，把整条
  // 正文作为单一段置于末尾——最终答复位是无段信息时的最优先验，且不改变
  // 其余任何块的相对顺序。
  // 【已删除的旧补偿】旧实现在此条件下把整条 msg.text 拼成一块追加末尾，
  // 而触发条件在子代理/面板路径（只写 text 不建块）下**必然命中**，于是
  // 本已按事件序存在的交错正文被整段沉底。分段记账落地后该条件在正常
  // 路径永不触发；仅存的 text 块一律经 reconcile 的邻居锚点回插原位。
  if (
    (msg.text || '').trim() &&
    !alignedBlocks.some((b) => b.type === 'text')
  ) {
    alignedBlocks.push({
      type: 'text',
      id: `${TEXT_SEGMENT_ID_PREFIX}0`,
      content: msg.text || '',
      turnIndex: 0,
    });
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
