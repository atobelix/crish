/**
 * 时间线签名与缓存管理（timelineCache）。
 *
 * 核心能力：
 * 1. timelineSignature：计算流式 0 重排签名，避免纯文本流式帧破坏 React.memo；
 * 2. D7.5 子块签名缓存：历史 text/thought 块的投影摘要按内容引用缓存，
 *    尾块变更时不重算历史块——O(delta) 而非 O(全文)。
 * 3. R3 增量装配（渲染整改波 1）：签名按「片段 → 数组装配」两级缓存——
 *    片段按对象身份（WeakMap）缓存，装配按数组引用缓存。流式文本帧不触碰
 *    blocks / toolCalls / injections 数组引用（热缓冲只替换 msg 包装对象），
 *    故每帧签名退化为三次 WeakMap 命中 + 短串拼接，O(1) 而非 O(全文)；
 *    工具/注入片段不再每帧 JSON.stringify 全部 output/arguments。
 *    签名的「变化敏感性」与旧实现逐项等价（同一组语义输入决定签名相等性）：
 *    历史块内容、尾块（live 时仅空否、封口时全文）、工具投影
 *    {id,name,status,output,arguments,explanation,turnId,startedAt}、
 *    注入投影、status、无显式正文分支的 msg.text/hasText。
 * 4. R3 身份协调（reconcileTimelineItems / reconcileTimelineSegments）：
 *    签名未命中而重建时间线/分段时，把语义未变的条目换回上一帧对象引用。
 *    已封口段的条目/段对象引用跨帧稳定，下游 memo（collapseContextState、
 *    partitionTimelineSegments、FoldableProcessSection、ProcessItemRenderer）
 *    对历史段零重算；只有真正变化的尾段/变更段产生新对象。
 */

import type { MessageToolCall, SessionMessage } from '../../store/layoutStore';
import type {
  AssistantTimelineItem,
  ProcessSegmentMetrics,
  ProcessTimelineSegment,
  StateNoticeTimelineSegment,
  TextTimelineSegment,
  TimelineSegment,
  TimelineInjectionItem,
  TimelineTextItem,
  TimelineThoughtItem,
  TimelineToolsItem,
  ToolRenderItem,
} from './toolPresentationTypes';

/**
 * 历史块投影摘要缓存（cacheKey → 投影 JSON 片段）。
 * 流式帧只重算尾块；历史块命中缓存。
 * 有界：超限时整 clear（与 thought stripper 整 clear 同法，禁无界增长）。
 *
 * 为何按「内容」键控而非对象身份：reconcileAssistantMessageBlocks 在每次
 * 存储提交时都会复制 block 对象（{...b}），身份键控会全灭；内容键控跨复制存活。
 */
const HIST_PROJ_CACHE_LIMIT = 4096;
const histProjCache = new Map<string, string>();

function histTextProj(content: string): string {
  const cached = histProjCache.get(content);
  if (cached !== undefined) return cached;
  const proj = JSON.stringify({ t: 'text', c: content });
  if (histProjCache.size >= HIST_PROJ_CACHE_LIMIT) {
    histProjCache.clear();
  }
  histProjCache.set(content, proj);
  return proj;
}

/** 封口尾文本块投影（与历史块的区别：带 last 标记 + 全文，口径与旧实现一致）。 */
function histLastTextProj(content: string): string {
  const cacheKey = 'lasttext|' + content;
  const cached = histProjCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const proj = JSON.stringify({ t: 'text', last: 1, c: content });
  if (histProjCache.size >= HIST_PROJ_CACHE_LIMIT) {
    histProjCache.clear();
  }
  histProjCache.set(cacheKey, proj);
  return proj;
}

function histThoughtProj(
  content: string,
  turnIndex: number | undefined
): string {
  const cacheKey = 'thought|' + String(turnIndex ?? '') + '|' + content;
  const cached = histProjCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const proj = JSON.stringify({ t: 'thought', c: content, turn: turnIndex });
  if (histProjCache.size >= HIST_PROJ_CACHE_LIMIT) {
    histProjCache.clear();
  }
  histProjCache.set(cacheKey, proj);
  return proj;
}

/* ═══════════════════════════════════════════════════════════════════════
 * R3 片段缓存（对象身份键控）。
 *
 * 工具调用与注入对象不被 normalize 复制（仅 blocks 被 {...b} 复制），
 * 且流式文本帧根本不触碰这些数组——身份缓存可安全跨帧存活。
 * 片段字符串与旧实现中对应投影对象的 JSON.stringify 逐字一致。
 * ═══════════════════════════════════════════════════════════════════════ */

const toolFragCache = new WeakMap<MessageToolCall, string>();

function toolFrag(tc: MessageToolCall): string {
  const cached = toolFragCache.get(tc);
  if (cached !== undefined) return cached;
  const frag = JSON.stringify({
    id: tc.id,
    n: tc.name,
    s: tc.status,
    o: tc.output,
    a: tc.arguments,
    e: tc.explanation,
    t: tc.turnId,
    st: tc.startedAt,
  });
  toolFragCache.set(tc, frag);
  return frag;
}

type InjectionLike = NonNullable<SessionMessage['injections']>[number];

const injFragCache = new WeakMap<InjectionLike, string>();

function injFrag(inj: InjectionLike): string {
  const cached = injFragCache.get(inj);
  if (cached !== undefined) return cached;
  const frag = JSON.stringify({
    id: inj.id,
    s: inj.status,
    te: inj.tokenEstimate ?? 0,
    m: (inj.metadata?.mode as string) || '',
    mod: (inj.metadata?.model as string) || '',
    th: (inj.metadata?.thinking as string) || '',
    ti: inj.title || '',
    su: inj.summary || '',
  });
  injFragCache.set(inj, frag);
  return frag;
}

type BlockLike = NonNullable<SessionMessage['blocks']>[number];

const blockInjFragCache = new WeakMap<BlockLike, string>();

function blockInjectionFrag(b: BlockLike): string {
  const cached = blockInjFragCache.get(b);
  if (cached !== undefined) return cached;
  const inj = b.type === 'context_injection' ? b.injection : undefined;
  const frag = JSON.stringify({
    t: b.type,
    id: b.id,
    s: inj?.status,
    m: (inj?.metadata?.mode as string) || '',
    mod: (inj?.metadata?.model as string) || '',
    th: (inj?.metadata?.thinking as string) || '',
    ti: inj?.title || '',
    su: inj?.summary || '',
  });
  blockInjFragCache.set(b, frag);
  return frag;
}

/* ═══════════════════════════════════════════════════════════════════════
 * R3 数组装配缓存（数组引用键控）。
 *
 * 装配 = 把片段数组 join 成与旧实现等价的 JSON 数组串。键为数组引用本身：
 * 文本帧期间三数组引用恒定 → 装配恒命中；存储提交换新数组时才重装配，
 * 且重装配只 join 已缓存片段（文本/思考片段按内容命中、工具/注入片段
 * 按身份命中），不再逐对象 stringify。
 * ═══════════════════════════════════════════════════════════════════════ */

const EMPTY_ARR: readonly never[] = [];

interface BlocksAssembly {
  /** live（processing）变体装配串 */
  live?: string;
  /** 封口变体装配串 */
  sealed?: string;
  /** 是否存在非空 text 块（与变体无关，一次扫描得出） */
  hasExplicitText?: boolean;
}

const blocksAssemblyCache = new WeakMap<object, BlocksAssembly>();
const toolsAssemblyCache = new WeakMap<object, string>();
const injectionsAssemblyCache = new WeakMap<object, string>();

function buildBlocksAssembly(
  blocks: readonly BlockLike[],
  isLiveProcessing: boolean
): { joined: string; hasExplicitText: boolean } {
  let lastTextIdx = -1;
  let lastThoughtIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (lastTextIdx === -1 && blocks[i]?.type === 'text') lastTextIdx = i;
    if (lastThoughtIdx === -1 && blocks[i]?.type === 'thought')
      lastThoughtIdx = i;
  }

  const blockParts: string[] = [];
  let hasExplicitText = false;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]!;
    if (b.type === 'text') {
      const content = b.content || '';
      if (content.trim().length > 0) hasExplicitText = true;
      if (i === lastTextIdx) {
        blockParts.push(
          isLiveProcessing
            ? JSON.stringify({ t: 'text', last: 1, e: content === '' ? 1 : 0 })
            : histLastTextProj(content)
        );
      } else {
        blockParts.push(histTextProj(content));
      }
      continue;
    }
    if (b.type === 'thought') {
      if (i === lastThoughtIdx && isLiveProcessing) {
        blockParts.push(
          JSON.stringify({
            t: 'thought',
            last: 1,
            e: (b.content || '') === '' ? 1 : 0,
          })
        );
      } else {
        blockParts.push(histThoughtProj(b.content || '', b.turnIndex));
      }
      continue;
    }
    if (b.type === 'context_injection') {
      blockParts.push(blockInjectionFrag(b));
      continue;
    }
    blockParts.push(JSON.stringify({ t: b.type, id: b.id }));
  }

  return { joined: '[' + blockParts.join(',') + ']', hasExplicitText };
}

function blocksAssembly(
  blocks: readonly BlockLike[],
  isLiveProcessing: boolean
): { joined: string; hasExplicitText: boolean } {
  const record = blocksAssemblyCache.get(blocks);
  if (record) {
    const hit = isLiveProcessing ? record.live : record.sealed;
    if (hit !== undefined && record.hasExplicitText !== undefined) {
      return { joined: hit, hasExplicitText: record.hasExplicitText };
    }
  }
  const built = buildBlocksAssembly(blocks, isLiveProcessing);
  const next: BlocksAssembly = record ?? {};
  if (isLiveProcessing) next.live = built.joined;
  else next.sealed = built.joined;
  next.hasExplicitText = built.hasExplicitText;
  blocksAssemblyCache.set(blocks, next);
  return built;
}

function toolsAssembly(tools: readonly MessageToolCall[]): string {
  const cached = toolsAssemblyCache.get(tools);
  if (cached !== undefined) return cached;
  const joined = '[' + tools.map((tc) => toolFrag(tc)).join(',') + ']';
  toolsAssemblyCache.set(tools, joined);
  return joined;
}

function injectionsAssembly(injections: readonly InjectionLike[]): string {
  const cached = injectionsAssemblyCache.get(injections);
  if (cached !== undefined) return cached;
  const joined = '[' + injections.map((inj) => injFrag(inj)).join(',') + ']';
  injectionsAssemblyCache.set(injections, joined);
  return joined;
}

/**
 * 助手消息渲染时间线签名（流式 0 重排与状态跃迁缓存击穿）。
 *
 * D7.5：历史 text/thought 块走子块摘要缓存；尾块（last）瞬时投影。
 * 纯文本流式帧（仅尾块增长、status 保持 processing）签名恒等 → timeline 引用稳定。
 *
 * R3：最终签名为各装配串的长度前缀拼接（无歧义编码，相等性与旧实现的
 * 整体 JSON.stringify 逐项等价），装配串全部走缓存——热路径每帧 O(1)。
 */
export function timelineSignature(msg: SessionMessage): string {
  const isLiveProcessing = msg.status === 'processing';
  const blocks = msg.blocks || EMPTY_ARR;
  const b = blocksAssembly(blocks, isLiveProcessing);
  const t = toolsAssembly(msg.toolCalls || EMPTY_ARR);
  const i = injectionsAssembly(msg.injections || EMPTY_ARR);
  const st = msg.status || 'unknown';

  const head = `v2|${b.joined.length}:${b.joined}|${t.length}:${t}|${i.length}:${i}|${st.length}:${st}`;

  if (blocks.length === 0 || !b.hasExplicitText) {
    const hasText = (msg.text || '').trim() ? '1' : '0';
    const txt = isLiveProcessing ? '' : msg.text || '';
    return `${head}|${hasText}|${txt.length}:${txt}`;
  }

  return head;
}

/* ═══════════════════════════════════════════════════════════════════════
 * R3 身份协调（identity reconciliation）。
 *
 * 背景：签名未命中时 buildAssistantTimeline / partitionTimelineSegments
 * 会整体重建，产出与上一帧语义相同但引用全新的条目/段对象，击穿全部
 * 下游 memo。协调器按 key 匹配上一帧对象，逐字段值比较确认语义未变后
 * 复用旧引用；全部复用且长度一致时直接返回上一帧数组本身，使
 * collapseContextState / partitionTimelineSegments 的 useMemo 输入
 * 引用恒定、整链跳过。比较口径只读不写，任何不确定（序列化失败等）
 * 一律倒向「不复用」（安全方向）。
 * ═══════════════════════════════════════════════════════════════════════ */

let unserializableSeq = 0;

function toolCallFingerprint(tc: MessageToolCall): string {
  try {
    return JSON.stringify(tc) ?? '';
  } catch {
    // 不可序列化（如循环引用）：指纹每次唯一 → 永不误判相等
    unserializableSeq += 1;
    return ` unserializable:${unserializableSeq}`;
  }
}

function toolRenderItemFingerprint(item: ToolRenderItem): string {
  if (item.kind === 'single') {
    return 's:' + toolCallFingerprint(item.tc);
  }
  return (
    'g:' +
    item.id +
    ':' +
    item.label +
    ':' +
    item.tools.map((tc) => toolCallFingerprint(tc)).join(',')
  );
}

function timelineItemEqual(
  a: AssistantTimelineItem,
  b: AssistantTimelineItem
): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case 'thought': {
      const bb = b as TimelineThoughtItem;
      return (
        a.content === bb.content &&
        a.id === bb.id &&
        a.turnIndex === bb.turnIndex &&
        a.startTime === bb.startTime &&
        a.durationMs === bb.durationMs &&
        a.isLive === bb.isLive &&
        a.isStreaming === bb.isStreaming &&
        a.isHistoricalCollapsed === bb.isHistoricalCollapsed
      );
    }
    case 'text': {
      const bb = b as TimelineTextItem;
      return (
        a.content === bb.content &&
        a.turnIndex === bb.turnIndex &&
        a.startTime === bb.startTime &&
        a.durationMs === bb.durationMs &&
        a.isFinal === bb.isFinal
      );
    }
    case 'tools': {
      const bb = b as TimelineToolsItem;
      if (
        a.turnIndex !== bb.turnIndex ||
        a.startTime !== bb.startTime ||
        a.durationMs !== bb.durationMs ||
        a.items.length !== bb.items.length
      ) {
        return false;
      }
      for (let i = 0; i < a.items.length; i += 1) {
        if (
          toolRenderItemFingerprint(a.items[i]!) !==
          toolRenderItemFingerprint(bb.items[i]!)
        ) {
          return false;
        }
      }
      return true;
    }
    case 'injection': {
      const bb = b as TimelineInjectionItem;
      return (
        a.injection === bb.injection &&
        a.turnIndex === bb.turnIndex &&
        a.startTime === bb.startTime &&
        a.durationMs === bb.durationMs
      );
    }
  }
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function metricsEqual(
  a: ProcessSegmentMetrics,
  b: ProcessSegmentMetrics
): boolean {
  if (a === b) return true;
  return (
    a.thoughtCount === b.thoughtCount &&
    a.thoughtDurationMs === b.thoughtDurationMs &&
    a.toolCount === b.toolCount &&
    a.subagentCount === b.subagentCount &&
    a.searchCount === b.searchCount &&
    a.commandCount === b.commandCount &&
    a.readFilesCount === b.readFilesCount &&
    a.editFilesCount === b.editFilesCount &&
    a.injectionCount === b.injectionCount &&
    a.totalDurationMs === b.totalDurationMs &&
    a.hasRunning === b.hasRunning &&
    a.hasError === b.hasError &&
    a.isStreaming === b.isStreaming &&
    a.leadAction === b.leadAction &&
    stringArrayEqual(a.readPaths, b.readPaths) &&
    stringArrayEqual(a.editPaths, b.editPaths)
  );
}

function timelineSegmentEqual(a: TimelineSegment, b: TimelineSegment): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  switch (a.kind) {
    case 'process_section': {
      const bb = b as ProcessTimelineSegment;
      if (
        a.startTime !== bb.startTime ||
        a.endTime !== bb.endTime ||
        a.showWorkTime !== bb.showWorkTime ||
        a.foldable !== bb.foldable ||
        a.defaultExpanded !== bb.defaultExpanded ||
        a.forceExpanded !== bb.forceExpanded ||
        a.isLive !== bb.isLive ||
        a.items.length !== bb.items.length ||
        !metricsEqual(a.metrics, bb.metrics)
      ) {
        return false;
      }
      for (let i = 0; i < a.items.length; i += 1) {
        if (a.items[i] !== bb.items[i]) return false;
      }
      return true;
    }
    case 'text_narrative': {
      const bb = b as TextTimelineSegment;
      return (
        a.item === bb.item &&
        a.isFinalAnswer === bb.isFinalAnswer &&
        a.isStreaming === bb.isStreaming
      );
    }
    case 'state_notice': {
      const bb = b as StateNoticeTimelineSegment;
      return a.item === bb.item;
    }
  }
}

function reconcileList<T>(
  prev: readonly T[] | null | undefined,
  next: readonly T[],
  keyOf: (value: T) => string,
  equal: (a: T, b: T) => boolean
): T[] {
  if (!prev || prev.length === 0) return next as T[];
  if (prev === next) return prev as T[];
  const buckets = new Map<string, T[]>();
  for (const p of prev) {
    const k = keyOf(p);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(p);
    else buckets.set(k, [p]);
  }
  let allReused = prev.length === next.length;
  const out: T[] = new Array(next.length) as T[];
  for (let i = 0; i < next.length; i += 1) {
    const n = next[i]!;
    const bucket = buckets.get(keyOf(n));
    let reused: T | undefined;
    if (bucket) {
      const bi = bucket.findIndex((p) => equal(p, n));
      if (bi >= 0) {
        reused = bucket[bi];
        bucket.splice(bi, 1);
      }
    }
    if (reused !== undefined) {
      out[i] = reused;
    } else {
      out[i] = n;
      allReused = false;
    }
  }
  return allReused ? (prev as T[]) : out;
}

/**
 * 时间线条目身份协调：把 `next` 中与 `prev` 语义等价的条目换回 `prev` 的
 * 对象引用。全部等价时返回 `prev` 数组本身（引用恒定 → 下游整链 memo 命中）。
 */
export function reconcileTimelineItems(
  prev: readonly AssistantTimelineItem[] | null | undefined,
  next: readonly AssistantTimelineItem[]
): AssistantTimelineItem[] {
  return reconcileList(
    prev,
    next,
    (item) => item.kind + ':' + item.key,
    timelineItemEqual
  );
}

/**
 * 时间线分段身份协调：语义未变的段（含 items 逐元素引用一致、metrics
 * 值相等）复用上一帧段对象，FoldableProcessSection 的 memo 只对真正
 * 变化的段失效。前置条件：段内 items 应先经 reconcileTimelineItems
 * 协调（MessageContent 的装配顺序保证），否则 items 引用不同将判不等。
 */
export function reconcileTimelineSegments(
  prev: readonly TimelineSegment[] | null | undefined,
  next: readonly TimelineSegment[]
): TimelineSegment[] {
  return reconcileList(
    prev,
    next,
    (seg) => seg.kind + ':' + seg.id,
    timelineSegmentEqual
  );
}
