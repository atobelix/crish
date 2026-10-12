/**
 * 消息时间线四级因果保序（Causal Total Order SSOT）。
 *
 * 唯一排序四级严格弱序规范：
 * 1. seq（引擎事件/持久化物理序号 engineSequence）
 * 2. ts（精确创建时间戳 timestamp）
 * 3. roleRank（因果角色权重：system=0, user=1, assistant=2, other=3）
 * 4. id（自然数字 ID 比较：如 'hyd-user-2' < 'hyd-user-10'）
 *
 * 消灭「同毫秒时间戳碰撞退化为裸 ID 字典序导致 AI 置顶、用户沉底」缺陷。
 */

/**
 * 因果角色权重：system=0, user=1, assistant=2, other=3。
 * 同一时间戳下严格保证 System < User < Assistant < Other。
 */
export type MessageRoleRank = 0 | 1 | 2 | 3;

/** 排序键定义：seq 缺省时按 MAX_SAFE_INTEGER 归一化（视为无引擎序号） */
export interface MessageOrderKey {
  seq?: number | undefined;
  ts: number;
  roleRank: number; // system=0, user=1, assistant=2, other=3
  id: string;
}

/** 可提取排序键的消息入参形态（兼容 SessionMessage.sender 与 AgentMessage.role） */
export interface MessageOrderSource {
  id?: string | undefined;
  timestamp?: number | undefined;
  seq?: number | undefined;
  engineSequence?: number | undefined;
  role?: string | null | undefined;
  sender?: string | null | undefined;
}

/**
 * 提取角色因果优先权（system=0, user=1, assistant=2, other=3）。
 */
export function getRoleRank(role?: string | null): MessageRoleRank {
  if (!role || typeof role !== 'string') return 3;
  switch (role.trim().toLowerCase()) {
    case 'system':
      return 0;
    case 'user':
      return 1;
    case 'assistant':
      return 2;
    default:
      return 3;
  }
}

export const resolveRoleRank = getRoleRank;

/**
 * 自然数字 ID 比较器（Strict Total Order）。
 * 将连续数字段按无符号自然数大小比较（如 'hyd-user-2' < 'hyd-user-10'），
 * 非数字字符按 UTF-16 码元比较；前导零数值相等时以原始码元序决胜。
 */
export function compareNaturalNumericId(a: string, b: string): number {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  let ia = 0;
  let ib = 0;

  while (ia < lenA && ib < lenB) {
    const ca = a.charCodeAt(ia);
    const cb = b.charCodeAt(ib);
    const isDigA = ca >= 48 && ca <= 57;
    const isDigB = cb >= 48 && cb <= 57;

    if (isDigA && isDigB) {
      let endA = ia + 1;
      while (
        endA < lenA &&
        a.charCodeAt(endA) >= 48 &&
        a.charCodeAt(endA) <= 57
      ) {
        endA++;
      }
      let endB = ib + 1;
      while (
        endB < lenB &&
        b.charCodeAt(endB) >= 48 &&
        b.charCodeAt(endB) <= 57
      ) {
        endB++;
      }

      let nzA = ia;
      while (nzA < endA && a.charCodeAt(nzA) === 48) nzA++;
      let nzB = ib;
      while (nzB < endB && b.charCodeAt(nzB) === 48) nzB++;

      const sigLenA = endA - nzA;
      const sigLenB = endB - nzB;
      if (sigLenA !== sigLenB) {
        return sigLenA < sigLenB ? -1 : 1;
      }
      for (let k = 0; k < sigLenA; k++) {
        const da = a.charCodeAt(nzA + k);
        const db = b.charCodeAt(nzB + k);
        if (da !== db) {
          return da < db ? -1 : 1;
        }
      }

      ia = endA;
      ib = endB;
      continue;
    }

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
    ia++;
    ib++;
  }

  if (ia !== lenA || ib !== lenB) {
    return lenA - ia < lenB - ib ? -1 : 1;
  }

  return a < b ? -1 : 1;
}

/**
 * 从消息对象提取四级全序比较键。
 * - seq：优先取有限 engineSequence，次取有限 seq，缺省为 MAX_SAFE_INTEGER
 * - ts：timestamp 有限正数则用之，否则 0
 * - roleRank：按 role ?? sender 解析因果角色权重（system=0, user=1, assistant=2, other=3）
 * - id：字符串 id，缺省 ''
 */
export function getMessageOrderKey(msg: MessageOrderSource): MessageOrderKey {
  const ts =
    typeof msg.timestamp === 'number' &&
    Number.isFinite(msg.timestamp) &&
    msg.timestamp > 0
      ? msg.timestamp
      : 0;
  const rawSeq =
    typeof msg.engineSequence === 'number' &&
    Number.isFinite(msg.engineSequence)
      ? msg.engineSequence
      : msg.seq;
  const seq =
    typeof rawSeq === 'number' && Number.isFinite(rawSeq)
      ? rawSeq
      : Number.MAX_SAFE_INTEGER;
  const roleRank = getRoleRank(msg.role ?? msg.sender);
  const id = typeof msg.id === 'string' ? msg.id : '';
  return { seq, ts, roleRank, id };
}

export const messageOrderKey = getMessageOrderKey;

/**
 * 四级严格弱序比较器：
 * 1. engineSequence (seq)：小在前（缺省归一化为 MAX_SAFE_INTEGER）
 * 2. timestamp (ts)：小在前
 * 3. roleRank：同毫秒碰撞时按因果角色决胜（System=0 < User=1 < Assistant=2 < Other=3）
 * 4. naturalNumericId：同角色时按自然数字 ID 比较兜底
 */
export function compareMessageOrder(
  a: MessageOrderKey,
  b: MessageOrderKey
): number {
  const seqA =
    typeof a.seq === 'number' && Number.isFinite(a.seq)
      ? a.seq
      : Number.MAX_SAFE_INTEGER;
  const seqB =
    typeof b.seq === 'number' && Number.isFinite(b.seq)
      ? b.seq
      : Number.MAX_SAFE_INTEGER;
  if (seqA !== seqB) {
    return seqA < seqB ? -1 : 1;
  }

  const tsA = typeof a.ts === 'number' && Number.isFinite(a.ts) ? a.ts : 0;
  const tsB = typeof b.ts === 'number' && Number.isFinite(b.ts) ? b.ts : 0;
  if (tsA !== tsB) {
    return tsA < tsB ? -1 : 1;
  }

  const rankA =
    typeof a.roleRank === 'number' && Number.isFinite(a.roleRank)
      ? a.roleRank
      : 3;
  const rankB =
    typeof b.roleRank === 'number' && Number.isFinite(b.roleRank)
      ? b.roleRank
      : 3;
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }

  return compareNaturalNumericId(a.id ?? '', b.id ?? '');
}

/** 列表是否已按 compareMessageOrder 非降序排列 */
export function isSortedByMessageOrder(
  list: readonly MessageOrderSource[]
): boolean {
  for (let i = 1; i < list.length; i++) {
    const prev = getMessageOrderKey(list[i - 1]!);
    const curr = getMessageOrderKey(list[i]!);
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
