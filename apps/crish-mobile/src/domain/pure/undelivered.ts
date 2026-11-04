// 未送达行规格化（批 C 03-4）：outbox 未送达状态 → 每会话一行的呈现投影（纯函数）
// - 分组：按审批归属会话聚合（sessionId 由接线层经 approvalStore
//   pending/history 以 toolCallId 连接得到；连接不到 → null 组，只进
//   汇总计数、不挂任何会话现场——不伪造归属）；
// - 原因收敛为 7 类家族：与本地 13 类封闭分类（LocalChatErrorKind）
//   同概念同名——endpointUnavailable / stream / network / unknown 直接
//   复用正典键名；changed / sessionGone / unsendable 是送达域独有概念
//   （本地分类无对应物），不另造平行命名体系；
// - 动作裁决：「重发也没用」的家族（changed / sessionGone / unsendable）
//   给编辑，其余给重发；
// - 送达转绿：status='sent'（命令回执已达桌面，两阶段确认的后半段是
//   内部收敛，不占行）的条目按 updatedAtMs 起算 DELIVERED_FLASH_MS
//   原地转绿，窗口过后不再成行（恰 2000ms 退场由本投影的 nowMs 判定）。
import { isTtlExpired, type OutboxItem } from '../data/outbox';

/** 送达转绿停留时长（深比 03-4 规格：恰 2000ms） */
export const DELIVERED_FLASH_MS = 2_000;

/** 7 类原因家族（键名口径见文件头注） */
export type UndeliveredFamily =
  | 'changed'
  | 'sessionGone'
  | 'unsendable'
  | 'stream'
  | 'endpointUnavailable'
  | 'network'
  | 'unknown';

/** 家族呈现文案（只承载真实原因，不加复述性标签） */
export const UNDELIVERED_FAMILY_LABEL: Record<UndeliveredFamily, string> = {
  changed: '该决策已在别处处理',
  sessionGone: '原审批已不存在',
  unsendable: '决策已过期',
  stream: '送达被中断',
  endpointUnavailable: '桌面端不可用',
  network: '连接不可用',
  unknown: '送达失败',
};

/** 家族优先级（数值小者先判、组级取最严重者） */
const FAMILY_PRIORITY: Record<UndeliveredFamily, number> = {
  changed: 0,
  sessionGone: 1,
  unsendable: 2,
  stream: 3,
  endpointUnavailable: 4,
  network: 5,
  unknown: 6,
};

/** 重发无用的家族 → 编辑；其余 → 重发 */
const EDIT_FAMILIES: ReadonlySet<UndeliveredFamily> = new Set([
  'changed',
  'sessionGone',
  'unsendable',
]);

/**
 * outbox 条目与审批面的连接结果（VM 构造）：
 * - sessionId：归属会话（pending.request.sessionId / history.sessionId）；
 * - settled：'pending' 审批仍在待批面；'changed' 历史记录显示该审批已
 *   由别处（桌面端/自动过期/不同决策）落定；'missing' 待批与历史均无
 *   此审批（已不存在）；settled 只取可验证事实，不推测。
 */
export interface UndeliveredJoin {
  sessionId: string | null;
  settled: 'pending' | 'changed' | 'missing';
}

// 失败串分类词表（lastError 为网关/桌面错误 message 的自由文本，按
// 子串匹配；命中顺序 stream → endpointUnavailable → network，未命中
// 归 unknown 诚实兜底，不编造原因）。
const INTERRUPT_PATTERNS = [
  '中断',
  '断开',
  'aborted',
  'abort',
  'econnreset',
  'reset',
  'closed',
];
const PEER_PATTERNS = [
  '对端',
  '桌面端',
  'peer',
  'no route',
  'not subscribed',
  '未订阅',
  'device offline',
  '设备离线',
  'endpoint',
];
const NETWORK_PATTERNS = [
  '连接',
  '网络',
  '超时',
  'timeout',
  'timed out',
  'network',
  'offline',
  'dns',
  'socket',
  'econn',
  'unreachable',
  'fetch',
];

function containsAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => haystack.includes(p));
}

/** 单条目原因家族分类（连接事实优先于错误串推断） */
export function classifyUndeliveredItem(
  item: OutboxItem,
  join: UndeliveredJoin,
  nowMs: number
): UndeliveredFamily {
  if (join.settled === 'changed') return 'changed';
  if (join.settled === 'missing') return 'sessionGone';
  if (isTtlExpired(item, nowMs)) return 'unsendable';
  if (item.status === 'failed') {
    const haystack = (item.lastError ?? '').toLowerCase();
    if (containsAny(haystack, INTERRUPT_PATTERNS)) return 'stream';
    if (containsAny(haystack, PEER_PATTERNS)) return 'endpointUnavailable';
    if (containsAny(haystack, NETWORK_PATTERNS)) return 'network';
    return 'unknown';
  }
  // pending（从未送出：离线入队 / 排队等待）= 连接不可用面
  return 'network';
}

/** 每会话一行（未送达组）：sent 条目不入组（已送达，走转绿投影） */
export interface UndeliveredGroup {
  sessionId: string | null;
  items: readonly OutboxItem[];
  /** 组级家族 = 组内最严重（优先级最高）者 */
  family: UndeliveredFamily;
  action: 'resend' | 'edit';
  /** 决定组级家族的条目（编辑动作的定位目标） */
  representative: OutboxItem;
}

/** outbox 全量 → 每会话一行的未送达组（组内保 FIFO，组间按最早条目排序） */
export function groupUndelivered(
  items: readonly OutboxItem[],
  joinOf: (item: OutboxItem) => UndeliveredJoin,
  nowMs: number
): UndeliveredGroup[] {
  const bySession = new Map<string | null, OutboxItem[]>();
  for (const item of items) {
    if (item.status === 'sent') continue;
    const { sessionId } = joinOf(item);
    const bucket = bySession.get(sessionId);
    if (bucket) bucket.push(item);
    else bySession.set(sessionId, [item]);
  }
  const groups: UndeliveredGroup[] = [];
  for (const [sessionId, bucket] of bySession) {
    let family: UndeliveredFamily = 'unknown';
    let representative = bucket[0]!;
    for (const item of bucket) {
      const f = classifyUndeliveredItem(item, joinOf(item), nowMs);
      if (FAMILY_PRIORITY[f] < FAMILY_PRIORITY[family]) {
        family = f;
        representative = item;
      }
    }
    groups.push({
      sessionId,
      items: bucket,
      family,
      action: EDIT_FAMILIES.has(family) ? 'edit' : 'resend',
      representative,
    });
  }
  groups.sort(
    (a, b) =>
      a.representative.createdAtMs - b.representative.createdAtMs ||
      (a.sessionId ?? '').localeCompare(b.sessionId ?? '')
  );
  return groups;
}

/** 送达转绿投影：某会话最近一条 sent 条目仍在 2000ms 窗口内 → 转绿行 */
export interface DeliveredFlash {
  sessionId: string | null;
  /** 送达时刻（markSent 的 updatedAtMs） */
  sentAtMs: number;
  /** 退场时刻 = sentAtMs + DELIVERED_FLASH_MS */
  expiresAtMs: number;
}

/**
 * 转绿行派生（纯 nowMs 判定，恰 2000ms 退场）：同一会话多条 sent 取
 * 最近一条；该会话同时有未送达条目时未送达行优先（调用方裁决，
 * 本函数只报事实）。
 */
export function deriveDeliveredFlashes(
  items: readonly OutboxItem[],
  joinOf: (item: OutboxItem) => UndeliveredJoin,
  nowMs: number
): DeliveredFlash[] {
  const latestBySession = new Map<string | null, number>();
  for (const item of items) {
    if (item.status !== 'sent') continue;
    const { sessionId } = joinOf(item);
    const prev = latestBySession.get(sessionId);
    if (prev === undefined || item.updatedAtMs > prev) {
      latestBySession.set(sessionId, item.updatedAtMs);
    }
  }
  const flashes: DeliveredFlash[] = [];
  for (const [sessionId, sentAtMs] of latestBySession) {
    const expiresAtMs = sentAtMs + DELIVERED_FLASH_MS;
    if (nowMs < expiresAtMs && sentAtMs <= nowMs) {
      flashes.push({ sessionId, sentAtMs, expiresAtMs });
    }
  }
  return flashes;
}
