// 时间分隔行单测（批 B ㉑）：≥5 分钟阈值、首块必出、atMs=0 诚实
// 缺省不触发不推进时钟、无分隔时引用不变。
import type { TimelineBlock } from './buildTimeline';
import type { DisplayBlock } from './groupToolRuns';
import {
  formatTimeSeparator,
  insertTimeSeparators,
  TIME_SEPARATOR_MIN_GAP_MS,
  type TimelineRow,
} from './insertTimeSeparators';

function msg(id: string, atMs: number): DisplayBlock {
  return {
    kind: 'message',
    id,
    role: 'assistant',
    text: id,
    streaming: false,
    atMs,
  } as TimelineBlock as DisplayBlock;
}

function separatorsOf(rows: TimelineRow[]): TimelineRow[] {
  return rows.filter((row) => row.kind === 'timeSeparator');
}

const T0 = 1_700_000_000_000;

describe('insertTimeSeparators', () => {
  it('空输入 → 空输出', () => {
    expect(insertTimeSeparators([])).toEqual([]);
  });

  it('首条带时间的块之前必出一条分隔行', () => {
    const out = insertTimeSeparators([msg('a', T0)]);
    expect(out.map((row) => row.kind)).toEqual(['timeSeparator', 'message']);
    expect(separatorsOf(out)[0]).toMatchObject({
      id: 'time-sep:message:a',
      atMs: T0,
    });
  });

  it('间隔恰达 5 分钟 → 出第二条；差 1ms → 不出', () => {
    const exact = insertTimeSeparators([
      msg('a', T0),
      msg('b', T0 + TIME_SEPARATOR_MIN_GAP_MS),
    ]);
    expect(separatorsOf(exact)).toHaveLength(2);
    const under = insertTimeSeparators([
      msg('a', T0),
      msg('b', T0 + TIME_SEPARATOR_MIN_GAP_MS - 1),
    ]);
    expect(separatorsOf(under)).toHaveLength(1);
  });

  it('时钟以 lastShown 为准滚动：连续小步间隔累计跨过 5 分钟才出', () => {
    const step = 2 * 60 * 1000;
    const out = insertTimeSeparators([
      msg('a', T0),
      msg('b', T0 + step),
      msg('c', T0 + step * 2),
      msg('d', T0 + step * 3),
    ]);
    // a 出首条（时钟 T0）；b 距 T0 2 分钟不出；c 距 T0 4 分钟不出；
    // d 距 T0 6 分钟出第二条
    expect(separatorsOf(out).map((row) => row.atMs)).toEqual([
      T0,
      T0 + step * 3,
    ]);
  });

  it('atMs=0（本地无时间信息）永不触发、也不推进时钟', () => {
    const out = insertTimeSeparators([
      msg('z1', 0),
      msg('a', T0),
      msg('z2', 0),
      msg('b', T0 + TIME_SEPARATOR_MIN_GAP_MS),
    ]);
    expect(separatorsOf(out).map((row) => row.atMs)).toEqual([
      T0,
      T0 + TIME_SEPARATOR_MIN_GAP_MS,
    ]);
    // 全 0 输入 → 无分隔且返回同一引用
    const zeros = [msg('z1', 0), msg('z2', 0)];
    expect(insertTimeSeparators(zeros)).toBe(zeros);
  });

  it('无分隔插入时返回输入原引用（memo 身份纪律）', () => {
    const rows = [msg('a', 0), msg('b', 0)];
    expect(insertTimeSeparators(rows)).toBe(rows);
  });

  it('formatTimeSeparator 输出 MM/DD HH:mm（本地时区构造，跨时区稳定）', () => {
    const at = new Date(2026, 0, 5, 9, 7).getTime();
    expect(formatTimeSeparator(at)).toBe('01/05 09:07');
    const at2 = new Date(2026, 11, 25, 23, 59).getTime();
    expect(formatTimeSeparator(at2)).toBe('12/25 23:59');
  });
});
