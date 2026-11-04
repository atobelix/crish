// 时间分隔行（批 B ㉑）：相邻可见块的时间间隔 ≥ 5 分钟才在流中插入
// 一条居中时间行（Cherry 同口径）；首条带时间的块之前也出一条——
// 会话的时间起点要可见。纯函数，jest 直测。
// 数据面口径：块的 atMs 来自事件接收时刻；本地线程块 atMs = 0 表示
// 「无时间信息」（U2 诚实缺省）——atMs ≤ 0 的块永不触发分隔行、也
// 不推进时钟，本地模式因此天然无分隔行，绝不编造时间。
import type { DisplayBlock } from './groupToolRuns';

/** 时间分隔行（呈现行，不是会话数据块） */
export interface TimeSeparatorBlock {
  kind: 'timeSeparator';
  /** `time-sep:<触发块 kind>:<触发块 id>`，随触发块稳定 */
  id: string;
  atMs: number;
}

/** 时间线行单源类型（展示块 | 时间分隔行）：FlatList 数据与各宿主 listRef 共用 */
export type TimelineRow = DisplayBlock | TimeSeparatorBlock;

/** 分隔行最小间隔：5 分钟 */
export const TIME_SEPARATOR_MIN_GAP_MS = 5 * 60 * 1000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 分隔行文案 `MM/DD HH:mm`（本地时区，与 formatClock 同口径） */
export function formatTimeSeparator(atMs: number): string {
  const date = new Date(atMs);
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(
    date.getHours()
  )}:${pad2(date.getMinutes())}`;
}

export function insertTimeSeparators(
  rows: readonly DisplayBlock[]
): TimelineRow[] {
  let lastShownAtMs = Number.NEGATIVE_INFINITY;
  let out: TimelineRow[] | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.atMs > 0 && row.atMs - lastShownAtMs >= TIME_SEPARATOR_MIN_GAP_MS) {
      if (out === null) out = rows.slice(0, index) as TimelineRow[];
      out.push({
        kind: 'timeSeparator',
        id: `time-sep:${row.kind}:${row.id}`,
        atMs: row.atMs,
      });
      lastShownAtMs = row.atMs;
    }
    if (out !== null) out.push(row);
  }
  // 无分隔行时原样返回输入（引用不变，memo / FlatList data 身份不无谓失效）
  return out ?? (rows as TimelineRow[]);
}
