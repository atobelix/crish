import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_SESSION_ROW_HEIGHT,
  SIDEBAR_WINDOW_OVERSCAN,
  SIDEBAR_WINDOW_THRESHOLD,
  clampSessionListWindowRange,
  computeSessionListWindow,
  estimateVisibleRowCount,
  expandWindowToIndex,
  maxScrollTopForSessionList,
  measureListOffsetTop,
  normalizeRowHeight,
  normalizeSessionCount,
  normalizeSessionIndex,
  rowIndexAtListScroll,
  scrollTopToRevealIndex,
  sessionListTotalHeight,
  sessionListWindowHeightMatchesCount,
  sessionListWindowRangeEqual,
  sessionListWindowSpanHeight,
  shouldWindowSessionList,
  sliceSessionListWindow,
  windowContainsIndex,
} from './sessionListWindow';

describe('normalize helpers', () => {
  it('normalizeSessionCount clamps non-finite and negative', () => {
    expect(normalizeSessionCount(10.9)).toBe(10);
    expect(normalizeSessionCount(-3)).toBe(0);
    expect(normalizeSessionCount(Number.NaN)).toBe(0);
    expect(normalizeSessionCount(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('normalizeRowHeight rejects zero / negative / NaN', () => {
    expect(normalizeRowHeight(40)).toBe(40);
    expect(normalizeRowHeight(0)).toBe(SIDEBAR_SESSION_ROW_HEIGHT);
    expect(normalizeRowHeight(-8)).toBe(SIDEBAR_SESSION_ROW_HEIGHT);
    expect(normalizeRowHeight(Number.NaN)).toBe(SIDEBAR_SESSION_ROW_HEIGHT);
    expect(normalizeRowHeight(undefined)).toBe(SIDEBAR_SESSION_ROW_HEIGHT);
  });

  it('normalizeSessionIndex requires integer in range', () => {
    expect(normalizeSessionIndex(3, 10)).toBe(3);
    expect(normalizeSessionIndex(3.0, 10)).toBe(3);
    expect(normalizeSessionIndex(3.2, 10)).toBeNull();
    expect(normalizeSessionIndex(-1, 10)).toBeNull();
    expect(normalizeSessionIndex(10, 10)).toBeNull();
    expect(normalizeSessionIndex(null, 10)).toBeNull();
    expect(normalizeSessionIndex(0, 0)).toBeNull();
  });
});

describe('shouldWindowSessionList', () => {
  it('disables when at or below threshold', () => {
    expect(shouldWindowSessionList(SIDEBAR_WINDOW_THRESHOLD)).toBe(false);
    expect(shouldWindowSessionList(10)).toBe(false);
    expect(shouldWindowSessionList(0)).toBe(false);
  });

  it('enables when over threshold', () => {
    expect(shouldWindowSessionList(SIDEBAR_WINDOW_THRESHOLD + 1)).toBe(true);
    expect(shouldWindowSessionList(120)).toBe(true);
  });

  it('disables while searching or dragging (search/drag edge)', () => {
    expect(shouldWindowSessionList(200, { searching: true })).toBe(false);
    expect(shouldWindowSessionList(200, { dragging: true })).toBe(false);
    expect(
      shouldWindowSessionList(200, { searching: true, dragging: true }),
    ).toBe(false);
  });

  it('respects custom threshold and coerces bad count', () => {
    expect(shouldWindowSessionList(5, { threshold: 3 })).toBe(true);
    expect(shouldWindowSessionList(3, { threshold: 3 })).toBe(false);
    expect(shouldWindowSessionList(Number.NaN)).toBe(false);
    expect(shouldWindowSessionList(-100)).toBe(false);
  });
});

describe('estimateVisibleRowCount', () => {
  it('matches ceil(vh/row)+overscan*2', () => {
    const row = SIDEBAR_SESSION_ROW_HEIGHT;
    expect(estimateVisibleRowCount(320, row, SIDEBAR_WINDOW_OVERSCAN)).toBe(
      Math.ceil(320 / row) + SIDEBAR_WINDOW_OVERSCAN * 2,
    );
  });

  it('handles zero/negative rowHeight and viewport safely', () => {
    expect(estimateVisibleRowCount(0, 0, 2)).toBeGreaterThanOrEqual(1);
    expect(estimateVisibleRowCount(-10, -5, -1)).toBeGreaterThanOrEqual(1);
  });
});

describe('computeSessionListWindow', () => {
  const row = SIDEBAR_SESSION_ROW_HEIGHT;

  it('returns full range for short lists', () => {
    const r = computeSessionListWindow({ count: 20, scrollTop: 0, viewportHeight: 400 });
    expect(r).toEqual({
      start: 0,
      end: 20,
      topPad: 0,
      bottomPad: 0,
      windowed: false,
    });
    expect(sessionListWindowHeightMatchesCount(r, 20)).toBe(true);
  });

  it('returns empty full range for count 0', () => {
    const r = computeSessionListWindow({
      count: 0,
      scrollTop: 999,
      viewportHeight: 400,
    });
    expect(r).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
      windowed: false,
    });
    expect(sessionListWindowHeightMatchesCount(r, 0)).toBe(true);
  });

  it('windows 100+ items near top of list', () => {
    const r = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
    });
    expect(r.windowed).toBe(true);
    expect(r.start).toBe(0);
    // viewport 10 rows + overscan*2
    const expectedEnd = Math.min(
      120,
      estimateVisibleRowCount(320, row, SIDEBAR_WINDOW_OVERSCAN),
    );
    expect(r.end).toBe(expectedEnd);
    expect(r.topPad).toBe(0);
    expect(r.bottomPad).toBe((120 - r.end) * row);
    expect(sessionListWindowHeightMatchesCount(r, 120)).toBe(true);
  });

  it('accounts for listOffsetTop (pinned/projects above general)', () => {
    // 滚动容器滚了 200，但列表相对内容顶在 180 → 列表内仅滚了 20
    const r = computeSessionListWindow({
      count: 100,
      scrollTop: 200,
      listOffsetTop: 180,
      viewportHeight: 320,
    });
    const relative = 200 - 180; // 20
    const expectedStart = Math.max(
      0,
      Math.floor(relative / row) - SIDEBAR_WINDOW_OVERSCAN,
    );
    expect(r.start).toBe(expectedStart);
    expect(r.topPad).toBe(expectedStart * row);
    expect(sessionListWindowHeightMatchesCount(r, 100)).toBe(true);
  });

  it('forceFull always returns full range', () => {
    const r = computeSessionListWindow({
      count: 200,
      forceFull: true,
      scrollTop: 5000,
      viewportHeight: 100,
    });
    expect(r.windowed).toBe(false);
    expect(r.start).toBe(0);
    expect(r.end).toBe(200);
  });

  it('clamps at list bottom without empty slice', () => {
    const r = computeSessionListWindow({
      count: 100,
      scrollTop: 100 * row,
      listOffsetTop: 0,
      viewportHeight: 200,
    });
    expect(r.end).toBe(100);
    expect(r.start).toBeLessThan(100);
    expect(r.end - r.start).toBeGreaterThan(0);
    expect(r.bottomPad).toBe(0);
    expect(sessionListWindowHeightMatchesCount(r, 100)).toBe(true);
  });

  it('ensureIndex expands window to cover active row', () => {
    const r = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
      ensureIndex: 100,
    });
    expect(windowContainsIndex(r, 100)).toBe(true);
    expect(r.start).toBeLessThanOrEqual(100);
    expect(r.end).toBeGreaterThan(100);
    expect(sessionListWindowHeightMatchesCount(r, 120)).toBe(true);
  });

  it('ignores out-of-range / fractional ensureIndex', () => {
    const base = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
    });
    const oob = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
      ensureIndex: 999,
    });
    const frac = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
      ensureIndex: 99.7,
    });
    const neg = computeSessionListWindow({
      count: 120,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
      ensureIndex: -1,
    });
    expect(oob).toEqual(base);
    expect(frac).toEqual(base);
    expect(neg).toEqual(base);
  });

  it('span height always equals count * row when windowed mid-list', () => {
    const r = computeSessionListWindow({
      count: 80,
      scrollTop: 20 * row,
      viewportHeight: 320,
      listOffsetTop: 0,
    });
    expect(r.windowed).toBe(true);
    expect(sessionListWindowSpanHeight(r)).toBe(sessionListTotalHeight(80));
  });

  it('survives NaN scroll metrics and zero rowHeight without NaN range', () => {
    const r = computeSessionListWindow({
      count: 100,
      scrollTop: Number.NaN,
      viewportHeight: Number.NaN,
      listOffsetTop: Number.NaN,
      rowHeight: 0,
    });
    expect(Number.isFinite(r.start)).toBe(true);
    expect(Number.isFinite(r.end)).toBe(true);
    expect(Number.isFinite(r.topPad)).toBe(true);
    expect(Number.isFinite(r.bottomPad)).toBe(true);
    expect(r.end).toBeGreaterThan(r.start);
    expect(sessionListWindowHeightMatchesCount(r, 100)).toBe(true);
  });

  it('when viewport fits entire list, windowed is false even above threshold', () => {
    const r = computeSessionListWindow({
      count: SIDEBAR_WINDOW_THRESHOLD + 1,
      scrollTop: 0,
      viewportHeight: 50_000,
      listOffsetTop: 0,
    });
    expect(r.start).toBe(0);
    expect(r.end).toBe(SIDEBAR_WINDOW_THRESHOLD + 1);
    expect(r.windowed).toBe(false);
    expect(sessionListWindowHeightMatchesCount(r, SIDEBAR_WINDOW_THRESHOLD + 1)).toBe(
      true,
    );
  });

  it('threshold boundary: exactly threshold is full; +1 may window', () => {
    const at = computeSessionListWindow({
      count: SIDEBAR_WINDOW_THRESHOLD,
      scrollTop: 0,
      viewportHeight: 200,
    });
    expect(at.windowed).toBe(false);
    expect(at.end).toBe(SIDEBAR_WINDOW_THRESHOLD);

    const over = computeSessionListWindow({
      count: SIDEBAR_WINDOW_THRESHOLD + 1,
      scrollTop: 0,
      viewportHeight: 200,
    });
    // 视口不够装下时才真正 windowed
    expect(over.end).toBeLessThanOrEqual(SIDEBAR_WINDOW_THRESHOLD + 1);
    expect(sessionListWindowHeightMatchesCount(over, SIDEBAR_WINDOW_THRESHOLD + 1)).toBe(
      true,
    );
  });

  it('negative relative scroll (list still below viewport) starts at 0', () => {
    const r = computeSessionListWindow({
      count: 100,
      scrollTop: 0,
      listOffsetTop: 500,
      viewportHeight: 320,
    });
    expect(r.start).toBe(0);
    expect(r.topPad).toBe(0);
  });
});

describe('expandWindowToIndex / windowContainsIndex / clamp', () => {
  it('expands only when needed', () => {
    const base = computeSessionListWindow({
      count: 100,
      scrollTop: 0,
      viewportHeight: 320,
      listOffsetTop: 0,
    });
    expect(windowContainsIndex(base, 0)).toBe(true);
    const same = expandWindowToIndex(base, 1, 100);
    expect(same).toEqual(base);

    const expanded = expandWindowToIndex(base, 90, 100);
    expect(windowContainsIndex(expanded, 90)).toBe(true);
    expect(expanded.end).toBeGreaterThan(base.end);
    expect(sessionListWindowHeightMatchesCount(expanded, 100)).toBe(true);
  });

  it('expands even when windowed=false but range incomplete (defensive)', () => {
    const broken: ReturnType<typeof computeSessionListWindow> = {
      start: 0,
      end: 10,
      topPad: 0,
      bottomPad: 90 * SIDEBAR_SESSION_ROW_HEIGHT,
      windowed: false,
    };
    const fixed = expandWindowToIndex(broken, 50, 100);
    expect(windowContainsIndex(fixed, 50)).toBe(true);
    expect(fixed.windowed).toBe(true);
    expect(sessionListWindowHeightMatchesCount(fixed, 100)).toBe(true);
  });

  it('windowContainsIndex rejects fractional and negative indices', () => {
    const range = { start: 0, end: 10 };
    expect(windowContainsIndex(range, 5)).toBe(true);
    expect(windowContainsIndex(range, 10)).toBe(false);
    expect(windowContainsIndex(range, -1)).toBe(false);
    expect(windowContainsIndex(range, 1.5)).toBe(false);
    expect(windowContainsIndex(range, Number.NaN)).toBe(false);
  });

  it('clampSessionListWindowRange fixes inverted / empty slices and pads', () => {
    const inverted = clampSessionListWindowRange({ start: 40, end: 10 }, 50);
    expect(inverted.start).toBeLessThan(inverted.end);
    expect(sessionListWindowHeightMatchesCount(inverted, 50)).toBe(true);

    const empty = clampSessionListWindowRange({ start: 20, end: 20 }, 50);
    expect(empty.end - empty.start).toBe(1);
    expect(sessionListWindowHeightMatchesCount(empty, 50)).toBe(true);

    const zero = clampSessionListWindowRange({ start: 0, end: 5 }, 0);
    expect(zero).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
      windowed: false,
    });
  });
});

describe('scrollTopToRevealIndex / maxScroll / rowIndex', () => {
  const row = SIDEBAR_SESSION_ROW_HEIGHT;

  it('nearest keeps scroll when already visible', () => {
    const st = scrollTopToRevealIndex({
      index: 2,
      count: 50,
      viewportHeight: 320,
      listOffsetTop: 0,
      scrollTop: 0,
      align: 'nearest',
    });
    expect(st).toBe(0);
  });

  it('nearest scrolls down when row below viewport', () => {
    const st = scrollTopToRevealIndex({
      index: 40,
      count: 50,
      viewportHeight: 200,
      listOffsetTop: 0,
      scrollTop: 0,
      align: 'nearest',
    });
    expect(st).toBeGreaterThan(0);
    expect(st).toBe(40 * row + row - 200);
  });

  it('start aligns row top', () => {
    const st = scrollTopToRevealIndex({
      index: 10,
      count: 50,
      viewportHeight: 200,
      listOffsetTop: 50,
      align: 'start',
    });
    expect(st).toBe(50 + 10 * row);
  });

  it('center clamps to max scroll near list end', () => {
    const max = maxScrollTopForSessionList({
      count: 20,
      viewportHeight: 200,
      listOffsetTop: 0,
    });
    const st = scrollTopToRevealIndex({
      index: 19,
      count: 20,
      viewportHeight: 200,
      listOffsetTop: 0,
      align: 'center',
    });
    expect(st).toBeLessThanOrEqual(max);
    expect(st).toBeGreaterThanOrEqual(0);
  });

  it('invalid index returns clamped current scroll', () => {
    expect(
      scrollTopToRevealIndex({
        index: -1,
        count: 10,
        viewportHeight: 200,
        scrollTop: 40,
      }),
    ).toBe(40);
    expect(
      scrollTopToRevealIndex({
        index: 0,
        count: 0,
        viewportHeight: 200,
        scrollTop: 99,
      }),
    ).toBe(0); // empty list maxScroll=0
  });

  it('rowIndexAtListScroll maps offset and clamps', () => {
    expect(rowIndexAtListScroll(0, 100)).toBe(0);
    expect(rowIndexAtListScroll(row * 5 + 1, 100)).toBe(5);
    expect(rowIndexAtListScroll(-100, 100)).toBe(0);
    expect(rowIndexAtListScroll(1e9, 100)).toBe(99);
    expect(rowIndexAtListScroll(0, 0)).toBe(-1);
    expect(rowIndexAtListScroll(Number.NaN, 50)).toBe(0);
  });

  it('maxScrollTopForSessionList is non-negative and accounts for offset', () => {
    expect(
      maxScrollTopForSessionList({ count: 10, viewportHeight: 500, listOffsetTop: 0 }),
    ).toBe(0);
    expect(
      maxScrollTopForSessionList({
        count: 100,
        viewportHeight: 200,
        listOffsetTop: 80,
      }),
    ).toBe(80 + 100 * row - 200);
  });
});

describe('sessionListTotalHeight / range equal', () => {
  it('total height is count * row', () => {
    expect(sessionListTotalHeight(10)).toBe(10 * SIDEBAR_SESSION_ROW_HEIGHT);
    expect(sessionListTotalHeight(0)).toBe(0);
    expect(sessionListTotalHeight(-5)).toBe(0);
    expect(sessionListTotalHeight(3, 0)).toBe(3 * SIDEBAR_SESSION_ROW_HEIGHT);
  });

  it('sessionListWindowRangeEqual compares fields', () => {
    const a = computeSessionListWindow({ count: 80, scrollTop: 0, viewportHeight: 400 });
    const b = { ...a };
    expect(sessionListWindowRangeEqual(a, b)).toBe(true);
    expect(sessionListWindowRangeEqual(a, { ...a, start: a.start + 1 })).toBe(false);
    expect(sessionListWindowRangeEqual(a, { ...a, windowed: !a.windowed })).toBe(false);
  });
});

describe('sliceSessionListWindow', () => {
  it('slices items for mid-list scroll with stable ascending order', () => {
    const items = Array.from({ length: 80 }, (_, i) => `s${i}`);
    const r = sliceSessionListWindow(items, {
      scrollTop: 20 * SIDEBAR_SESSION_ROW_HEIGHT,
      viewportHeight: 320,
      listOffsetTop: 0,
    });
    expect(r.items[0]).toBe(`s${r.start}`);
    expect(r.items).toHaveLength(r.end - r.start);
    expect(r.items.length).toBeLessThan(80);
    // 稳定顺序：切片下标严格升序，与源数组一致
    for (let i = 0; i < r.items.length; i++) {
      expect(r.items[i]).toBe(items[r.start + i]);
    }
  });

  it('empty / short list returns all items unwindowed', () => {
    expect(sliceSessionListWindow([], { scrollTop: 0, viewportHeight: 400 }).items).toEqual(
      [],
    );
    const short = ['a', 'b', 'c'];
    const r = sliceSessionListWindow(short, {
      scrollTop: 0,
      viewportHeight: 400,
    });
    expect(r.windowed).toBe(false);
    expect(r.items).toEqual(short);
  });
});

describe('measureListOffsetTop', () => {
  it('derives content offset from rects + scrollTop', () => {
    const scrollEl = {
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 50 }),
    };
    const listEl = {
      getBoundingClientRect: () => ({ top: 80 }),
    };
    // 100 + (80 - 50) = 130
    expect(measureListOffsetTop(scrollEl, listEl)).toBe(130);
  });

  it('treats non-finite scrollTop as 0', () => {
    const scrollEl = {
      scrollTop: Number.NaN,
      getBoundingClientRect: () => ({ top: 10 }),
    };
    const listEl = {
      getBoundingClientRect: () => ({ top: 30 }),
    };
    expect(measureListOffsetTop(scrollEl, listEl)).toBe(20);
  });
});
