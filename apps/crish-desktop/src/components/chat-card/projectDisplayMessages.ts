/**
 * S-6（FINAL-PLAN §2）：列表展示投影——消息流展示的唯一入口。
 *
 * 顺序：排序（compareMessageOrder）→ 搜索过滤 → S-3 可渲染过滤 → S-5 载体折叠。
 * 先排序后折叠（E4 正确性修正）；不可渲染行（空助手行、只含 S7 旧思考的历史行）
 * 先被滤掉，所以只隔着不可见行的相邻载体会被折叠为一条；隔着用户气泡的载体不合并。
 * 渲染期投影，不改写 store / 持久化数据。
 *
 * R6 增量化：投影是纯透传（条目即 store 消息对象，不克隆），故以「上一轮输入/
 * 输出 + 载体折叠检查点」做增量复用——
 * - 输入数组身份未变 → 直接返回上一轮结果对象；
 * - 折叠（collapseContextState 的 keep:'last' 左折叠）在「干净边界」（上一项为
 *   非载体）处记录检查点，输入仅在中段发生变化时从最近检查点续算，前缀输出
 *   条目逐个复用原引用，未受影响消息不击穿下游 memo；
 * - 搜索命中判定按消息对象身份 WeakMap 缓存（store 消息不可变，身份即版本）；
 * - 计算结果与上一轮逐项等价（display 同引用且 visibleCount 相同）时返回
 *   上一轮结果对象本身，使 useMemo 下游整表跳过。
 * 缓存只有一份（最近一轮）：多投影面交替调用时退化为全量计算，正确性不变
 * （所有复用都以元素身份逐项校验为前提）。
 */
import type { SessionMessage } from '../../store/types';
import { sortMessagesByOrder } from '../../store/storeAccess';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { isRenderableAssistantMessage } from '../../api/toolPresentation';
import {
  dedupeStateCarrierMessages,
  isContextStateCarrierMessage,
} from '../chat-message/contextStateUtils';

export interface DisplayProjection {
  /** 列表实际渲染的消息 */
  display: SessionMessage[];
  /** 投影后、搜索前的条数（空态判定用：全部不可渲染 → 0 → 欢迎面） */
  visibleCount: number;
}

/** 载体判定按消息身份缓存（与 isRenderableAssistantMessage 的既有缓存同假设：store 消息不可变）。 */
const carrierFlagCache = new WeakMap<SessionMessage, boolean>();

function carrierFlag(m: SessionMessage): boolean {
  let v = carrierFlagCache.get(m);
  if (v === undefined) {
    v = isContextStateCarrierMessage(m);
    carrierFlagCache.set(m, v);
  }
  return v;
}

/** 搜索命中按消息身份 + 查询串缓存（逐消息重复 tokenize 的成本一并收敛）。 */
const searchMatchCache = new WeakMap<SessionMessage, Map<string, boolean>>();

function matchesSearch(m: SessionMessage, q: string): boolean {
  let per = searchMatchCache.get(m);
  if (!per) {
    per = new Map<string, boolean>();
    searchMatchCache.set(m, per);
  }
  let v = per.get(q);
  if (v === undefined) {
    v = messageMatchesSearch(m, q);
    per.set(q, v);
  }
  return v;
}

interface DedupeCache {
  input: SessionMessage[];
  output: SessionMessage[];
  /**
   * 干净边界检查点：[已处理输入数, 对应输出长度]，按输入数升序。
   * 边界 i 干净 ⟺ 第 i-1 项为非载体（折叠状态 prevWasState=false，可安全续算）。
   */
  checkpoints: Array<readonly [number, number]>;
}

function buildCheckpoints(
  input: readonly SessionMessage[]
): Array<readonly [number, number]> {
  const checkpoints: Array<readonly [number, number]> = [[0, 0]];
  let outLen = 0;
  let prevWasState = false;
  for (let i = 0; i < input.length; i++) {
    const isState = carrierFlag(input[i]!);
    if (!isState) {
      outLen += 1;
      prevWasState = false;
      checkpoints.push([i + 1, outLen]);
    } else {
      if (!prevWasState) outLen += 1;
      prevWasState = true;
    }
  }
  return checkpoints;
}

function dedupeIncremental(
  input: SessionMessage[],
  cache: DedupeCache | null
): { output: SessionMessage[]; cache: DedupeCache } {
  if (cache) {
    const prev = cache.input;
    const minLen = Math.min(prev.length, input.length);
    let k = 0;
    while (k < minLen && prev[k] === input[k]) k += 1;
    if (k === prev.length && k === input.length) {
      return { output: cache.output, cache };
    }
    // 取 ≤ k 的最大干净边界作为续算点（前缀输出逐项复用原引用）
    let resumeAt = 0;
    let resumeOutLen = 0;
    for (const [cp, outLen] of cache.checkpoints) {
      if (cp > k) break;
      resumeAt = cp;
      resumeOutLen = outLen;
    }
    const suffix = dedupeStateCarrierMessages(input.slice(resumeAt));
    const output =
      resumeOutLen > 0
        ? [...cache.output.slice(0, resumeOutLen), ...suffix]
        : suffix;
    return {
      output,
      cache: { input, output, checkpoints: buildCheckpoints(input) },
    };
  }
  const output = dedupeStateCarrierMessages(input);
  return {
    output,
    cache: { input, output, checkpoints: buildCheckpoints(input) },
  };
}

interface ProjectionCache {
  messages: readonly SessionMessage[];
  query: string;
  result: DisplayProjection;
  allSlot: DedupeCache;
  searchSlot: DedupeCache | null;
  searchQuery: string;
}

let lastCache: ProjectionCache | null = null;

export function projectDisplayMessages(
  messages: readonly SessionMessage[],
  query: string
): DisplayProjection {
  const q = query.trim();
  if (lastCache && lastCache.messages === messages && lastCache.query === q) {
    return lastCache.result;
  }
  const renderable = sortMessagesByOrder(messages as SessionMessage[]).filter(
    (m) => isRenderableAssistantMessage(m)
  );
  const allRes = dedupeIncremental(renderable, lastCache?.allSlot ?? null);
  let searchSlot: DedupeCache | null = null;
  let result: DisplayProjection;
  if (!q) {
    result = {
      display: allRes.output,
      visibleCount: allRes.output.length,
    };
  } else {
    const filtered = renderable.filter((m) => matchesSearch(m, q));
    const prevSlot =
      lastCache && lastCache.searchQuery === q ? lastCache.searchSlot : null;
    const dispRes = dedupeIncremental(filtered, prevSlot);
    searchSlot = dispRes.cache;
    result = {
      display: dispRes.output,
      visibleCount: allRes.output.length,
    };
  }
  // 与上一轮逐项等价时复用结果对象本身（display 引用未变 = 下游整表无变化）
  if (
    lastCache &&
    lastCache.result.display === result.display &&
    lastCache.result.visibleCount === result.visibleCount
  ) {
    result = lastCache.result;
  }
  lastCache = {
    messages,
    query: q,
    result,
    allSlot: allRes.cache,
    searchSlot,
    searchQuery: q,
  };
  return result;
}
