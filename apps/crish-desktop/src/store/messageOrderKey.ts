/**
 * 消息时间线 canonical order（D1 SSOT）。
 *
 * 唯一排序真理：seq（可选 engineSequence）→ ts → id。
 * 消灭「纯 append 导致重排」：所有新消息插入必须经 compareMessageOrder
 * 二分定位，禁止第二条独立 order list。
 */

/** 排序键：seq 缺省为 MAX_SAFE_INTEGER（视为无引擎序号） */
export type MessageOrderKey = { seq: number; ts: number; id: string };

/**
 * 从消息对象提取 order key。
 * - ts：timestamp 有限正数则用之，否则 0
 * - seq：对象上可选 engineSequence（有限数）否则 MAX_SAFE_INTEGER
 * - id：字符串 id，缺省 ''
 */
export function messageOrderKey(m: {
  timestamp?: number;
  id?: string;
  engineSequence?: number;
}): MessageOrderKey {
  const ts =
    typeof m.timestamp === 'number' &&
    Number.isFinite(m.timestamp) &&
    m.timestamp > 0
      ? m.timestamp
      : 0;
  const rawSeq = m.engineSequence;
  const seq =
    typeof rawSeq === 'number' && Number.isFinite(rawSeq)
      ? rawSeq
      : Number.MAX_SAFE_INTEGER;
  const id = typeof m.id === 'string' ? m.id : '';
  return { seq, ts, id };
}

/**
 * 比较：先比 seq（小在前；双方同为 MAX_SAFE_INTEGER 时视为相等），
 * 再比 ts（小在前），再比 id（localeCompare 稳定 tiebreak）。
 */
export function compareMessageOrder(a: MessageOrderKey, b: MessageOrderKey): number {
  // 双方同为 MAX_SAFE_INTEGER 时 a.seq === b.seq，自然落到 ts
  if (a.seq !== b.seq) {
    return a.seq < b.seq ? -1 : 1;
  }
  if (a.ts !== b.ts) {
    return a.ts < b.ts ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

/** 列表是否已按 compareMessageOrder 非降序排列 */
export function isSortedByMessageOrder(
  list: readonly { timestamp?: number; id?: string }[]
): boolean {
  for (let i = 1; i < list.length; i++) {
    const prev = messageOrderKey(list[i - 1]!);
    const curr = messageOrderKey(list[i]!);
    if (compareMessageOrder(prev, curr) > 0) return false;
  }
  return true;
}

/**
 * 二分找第一个严格大于 item 的位置（插入点，保持非降序）。
 * list 必须已按 compareMessageOrder 排序。
 */
export function findInsertIndex(
  list: readonly MessageOrderKey[],
  item: MessageOrderKey
): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareMessageOrder(list[mid]!, item) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
