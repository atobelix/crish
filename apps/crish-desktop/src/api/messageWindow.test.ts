import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  EXPAND_OLDER_STEP,
  MESSAGE_JUMP_CONTEXT,
  MESSAGE_VIEWPORT_OVERSCAN,
  THINKING_DOM_CHAR_CAP,
  TOOL_OUTPUT_DOM_CHAR_CAP,
  budgetDomText,
  clampExpandedOlder,
  collectMustIncludeIndices,
  computeMessageViewportSlice,
  expandOlderStepCount,
  expandedOlderForPendingApprovals,
  expandedOlderForPinIds,
  expandedOlderForPinJump,
  expandedOlderToInclude,
  expandedOlderToIncludeMany,
  expandedOlderToIncludeWithContext,
  expandedOlderToShowAll,
  findIndicesByIds,
  findMatchIndices,
  findPendingApprovalIndices,
  indicesMissingFromWindow,
  messageWindowContainsId,
  messageWindowContainsIndex,
  nextExpandedOlder,
  normalizeMessageCount,
  normalizeNonNegInt,
  normalizeRecentCount,
  resolveExpandedForIncludes,
  resolveExpandedForKeepAlive,
  shouldOfferShowAllOlder,
  uniqueSortedIndices,
  windowMessages,
} from './messageWindow';

describe('windowMessages', () => {
  const msgs = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }));

  it('returns all when length <= recentCount', () => {
    const short = msgs.slice(0, 10);
    const r = windowMessages(short, { recentCount: 80 });
    expect(r.visible).toHaveLength(10);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasOlder).toBe(false);
    expect(r.startIndex).toBe(0);
    expect(r.visibleCount).toBe(10);
    expect(r.totalCount).toBe(10);
  });

  it('windows long lists to recent tail', () => {
    const r = windowMessages(msgs, { recentCount: 80, expandedOlder: 0 });
    expect(r.visible).toHaveLength(80);
    expect(r.hiddenCount).toBe(40);
    expect(r.hasOlder).toBe(true);
    expect(r.startIndex).toBe(40);
    expect(r.visible[0].id).toBe('m40');
    expect(r.visible[r.visible.length - 1].id).toBe('m119');
    expect(r.effectiveExpanded).toBe(0);
  });

  it('expandedOlder reveals more history', () => {
    const r = windowMessages(msgs, { recentCount: 80, expandedOlder: 40 });
    expect(r.visible).toHaveLength(120);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasOlder).toBe(false);
  });

  it('showAll bypasses window', () => {
    const r = windowMessages(msgs, { showAll: true, recentCount: 5 });
    expect(r.visible).toHaveLength(120);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasOlder).toBe(false);
    expect(r.visibleCount).toBe(120);
  });

  it('mustIncludeIndices auto-raises effectiveExpanded with context', () => {
    // index 5 with context 4 → target 1 → need = 120 - 80 - 1 = 39
    const r = windowMessages(msgs, {
      recentCount: 80,
      expandedOlder: 0,
      mustIncludeIndices: [5],
      includeContext: 4,
    });
    expect(r.hasOlder).toBe(true);
    expect(r.startIndex).toBeLessThanOrEqual(5 - 4);
    expect(r.startIndex).toBe(1);
    expect(r.effectiveExpanded).toBe(39);
    expect(r.visible.some((m) => m.id === 'm5')).toBe(true);
  });

  it('mustIncludeIndices with zero context covers exact index', () => {
    const r = windowMessages(msgs, {
      recentCount: 80,
      mustIncludeIndices: [5],
      includeContext: 0,
    });
    // need = 120 - 80 - 5 = 35
    expect(r.startIndex).toBe(5);
    expect(r.effectiveExpanded).toBe(35);
  });

  it('DEFAULT_RECENT_MESSAGE_COUNT is 80', () => {
    expect(DEFAULT_RECENT_MESSAGE_COUNT).toBe(80);
  });

  it('computeMessageViewportSlice treats NaN/negative count as empty full slice', () => {
    expect(computeMessageViewportSlice({ count: Number.NaN })).toMatchObject({
      start: 0,
      end: 0,
      windowed: false,
    });
    expect(computeMessageViewportSlice({ count: -5 })).toMatchObject({
      start: 0,
      end: 0,
      windowed: false,
    });
  });

  it('empty list', () => {
    const r = windowMessages([], { showAll: true });
    expect(r).toMatchObject({
      visible: [],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
      visibleCount: 0,
      totalCount: 0,
    });
  });
});

describe('nextExpandedOlder / show-all helpers', () => {
  it('adds step capped by hiddenCount', () => {
    expect(nextExpandedOlder(0, 100, 40)).toBe(40);
    expect(nextExpandedOlder(0, 10, 40)).toBe(10);
    expect(nextExpandedOlder(40, 0, 40)).toBe(40);
  });

  it('hardens NaN / negative expand inputs', () => {
    expect(nextExpandedOlder(Number.NaN, 100, 40)).toBe(40);
    expect(nextExpandedOlder(-5, 10, 40)).toBe(10);
    expect(nextExpandedOlder(3, Number.NaN, 40)).toBe(3);
    expect(expandOlderStepCount(Number.NaN)).toBe(0);
    expect(expandOlderStepCount(-8)).toBe(0);
    expect(shouldOfferShowAllOlder(Number.NaN)).toBe(false);
  });

  it('expandedOlderToShowAll covers full history', () => {
    expect(expandedOlderToShowAll(120, 80)).toBe(40);
    expect(expandedOlderToShowAll(50, 80)).toBe(0);
    expect(expandedOlderToShowAll(0, 80)).toBe(0);
  });

  it('expandOlderStepCount and shouldOfferShowAllOlder', () => {
    expect(expandOlderStepCount(100)).toBe(EXPAND_OLDER_STEP);
    expect(expandOlderStepCount(12)).toBe(12);
    expect(expandOlderStepCount(0)).toBe(0);
    expect(shouldOfferShowAllOlder(100)).toBe(true);
    expect(shouldOfferShowAllOlder(EXPAND_OLDER_STEP)).toBe(false);
    expect(shouldOfferShowAllOlder(10)).toBe(false);
  });

  it('windowMessages clamps oversized expandedOlder in effectiveExpanded', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    const r = windowMessages(msgs, { recentCount: 80, expandedOlder: 9999 });
    expect(r.visible).toHaveLength(100);
    expect(r.hiddenCount).toBe(0);
    expect(r.effectiveExpanded).toBe(20); // max = 100 - 80
  });
});

describe('expandedOlderToInclude', () => {
  it('returns current when already in default window', () => {
    // len=100, recent=80 → start=20; index 50 is inside
    expect(expandedOlderToInclude(50, 100, 80, 0)).toBe(0);
  });

  it('expands enough to cover an early index', () => {
    // need startIndex <= 5 → expanded >= 100 - 80 - 5 = 15
    expect(expandedOlderToInclude(5, 100, 80, 0)).toBe(15);
  });

  it('is monotonic over currentExpanded', () => {
    expect(expandedOlderToInclude(5, 100, 80, 40)).toBe(40);
  });

  it('no-ops for empty / OOB', () => {
    expect(expandedOlderToInclude(0, 0, 80, 3)).toBe(3);
    expect(expandedOlderToInclude(-1, 10, 80, 2)).toBe(2);
    expect(expandedOlderToInclude(99, 10, 80, 2)).toBe(2);
  });

  it('hardens NaN currentExpanded and fractional index', () => {
    expect(expandedOlderToInclude(5, 100, 80, Number.NaN)).toBe(15);
    // floor(5.9) → 5 → need 15
    expect(expandedOlderToInclude(5.9, 100, 80, 0)).toBe(15);
    expect(expandedOlderToInclude(Number.NaN, 100, 80, 7)).toBe(7);
  });
});

describe('expandedOlderToIncludeWithContext / Many', () => {
  it('pulls start further back by contextBefore', () => {
    // index 20, context 4 → target 16 → need = 100 - 80 - 16 = 4
    expect(expandedOlderToIncludeWithContext(20, 100, 80, 0, 4)).toBe(4);
    // without context: need = 100 - 80 - 20 = 0
    expect(expandedOlderToInclude(20, 100, 80, 0)).toBe(0);
  });

  it('defaults context to MESSAGE_JUMP_CONTEXT', () => {
    const withDefault = expandedOlderToIncludeWithContext(20, 100, 80, 0);
    const withExplicit = expandedOlderToIncludeWithContext(
      20,
      100,
      80,
      0,
      MESSAGE_JUMP_CONTEXT,
    );
    expect(withDefault).toBe(withExplicit);
  });

  it('Many takes the max need across indices', () => {
    // earliest index dominates
    expect(expandedOlderToIncludeMany([50, 5, 30], 100, 80, 0, 0)).toBe(15);
  });

  it('Many with context expands more than bare index', () => {
    const bare = expandedOlderToIncludeMany([10], 100, 80, 0, 0);
    const withCtx = expandedOlderToIncludeMany([10], 100, 80, 0, 4);
    expect(withCtx).toBeGreaterThan(bare);
    // target 6 → need 100-80-6 = 14
    expect(withCtx).toBe(14);
  });

  it('Many no-ops on empty indices', () => {
    expect(expandedOlderToIncludeMany([], 100, 80, 7)).toBe(7);
  });
});

describe('find* indices helpers (approval / pin / search)', () => {
  const messages = [
    { id: 'a', toolCalls: [{ status: 'success' as const }] },
    { id: 'b', toolCalls: [{ status: 'pending_approval' as const }] },
    { id: 'c', toolCalls: [] as { status: string }[] },
    {
      id: 'd',
      toolCalls: [
        { status: 'success' as const },
        { status: 'pending_approval' as const },
      ],
    },
    { id: 'e' },
  ];

  it('findPendingApprovalIndices lists all pending rows', () => {
    expect(findPendingApprovalIndices(messages)).toEqual([1, 3]);
  });

  it('findIndicesByIds preserves message order', () => {
    expect(findIndicesByIds(messages, ['d', 'a', 'missing', 'b'])).toEqual([0, 1, 3]);
  });

  it('findMatchIndices uses predicate', () => {
    expect(findMatchIndices(messages, (m) => m.id === 'c' || m.id === 'e')).toEqual([
      2, 4,
    ]);
  });

  it('expand path: pending + pins + search → single expandedOlder', () => {
    const pending = findPendingApprovalIndices(messages);
    const pins = findIndicesByIds(messages, ['a']);
    const search = findMatchIndices(messages, (m) => m.id === 'e');
    // earliest is pin index 0 with context 0
    const expanded = expandedOlderToIncludeMany(
      [...pending, ...pins, ...search],
      100, // pretend long list length for need math; helpers clamp OOB
      80,
      0,
      0,
    );
    // indices 0,1,3,4 — but totalLength 100 means index 4 needs 100-80-4=16
    // wait messages only has 5 items but totalLength is independent in the API
    // index 0 → need 100-80-0 = 20
    expect(expanded).toBe(20);
  });
});

describe('collectMustIncludeIndices / uniqueSortedIndices', () => {
  const messages = [
    { id: 'a', toolCalls: [{ status: 'success' as const }] },
    { id: 'b', toolCalls: [{ status: 'pending_approval' as const }] },
    { id: 'c', toolCalls: [] as { status: string }[] },
    {
      id: 'd',
      toolCalls: [
        { status: 'success' as const },
        { status: 'pending_approval' as const },
      ],
    },
    { id: 'e' },
  ];

  it('uniqueSortedIndices dedupes and sorts', () => {
    expect(uniqueSortedIndices([3, 1, 3, -1, 2, Number.NaN, 1])).toEqual([1, 2, 3]);
    expect(uniqueSortedIndices([])).toEqual([]);
  });

  it('uniqueSortedIndices drops OOB when maxExclusive given', () => {
    expect(uniqueSortedIndices([0, 4, 5, 99], 5)).toEqual([0, 4]);
    expect(uniqueSortedIndices([0, 1], 0)).toEqual([]);
  });

  it('collects approvals + pins + earliest search hit', () => {
    const idx = collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      pinIds: ['e', 'a', 'missing'],
      match: (m) => m.id === 'c' || m.id === 'e',
      matchOnlyFirst: true,
    });
    // pending 1,3; pins 0,4; search first hit 2
    expect(idx).toEqual([0, 1, 2, 3, 4]);
  });

  it('matchOnlyFirst false includes all search hits only when no other sources', () => {
    const idx = collectMustIncludeIndices(messages, {
      match: (m) => m.id === 'c' || m.id === 'e',
      matchOnlyFirst: false,
    });
    expect(idx).toEqual([2, 4]);
  });

  it('drops OOB extraIndices against messages.length', () => {
    const idx = collectMustIncludeIndices(messages, {
      extraIndices: [1, 99, -3, 2.8],
    });
    expect(idx).toEqual([1, 2]);
  });

  it('empty messages → []', () => {
    expect(
      collectMustIncludeIndices([], { includePendingApprovals: true, pinIds: ['a'] }),
    ).toEqual([]);
  });
});

describe('clampExpandedOlder / messageWindowContainsIndex / resolve', () => {
  it('clampExpandedOlder caps by total - recent', () => {
    expect(clampExpandedOlder(100, 120, 80)).toBe(40);
    expect(clampExpandedOlder(5, 120, 80)).toBe(5);
    expect(clampExpandedOlder(10, 50, 80)).toBe(0);
    expect(clampExpandedOlder(-3, 100, 80)).toBe(0);
    expect(clampExpandedOlder(9, 0, 80)).toBe(0);
  });

  it('messageWindowContainsIndex uses start + visibleCount', () => {
    const w = windowMessages(
      Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` })),
      { recentCount: 80, expandedOlder: 0 },
    );
    // start=20, visible=80
    expect(messageWindowContainsIndex(w, 19)).toBe(false);
    expect(messageWindowContainsIndex(w, 20)).toBe(true);
    expect(messageWindowContainsIndex(w, 99)).toBe(true);
    expect(messageWindowContainsIndex(w, 100)).toBe(false);
  });

  it('messageWindowContainsId + indicesMissingFromWindow', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    const w = windowMessages(msgs, { recentCount: 80, expandedOlder: 0 });
    expect(messageWindowContainsId(msgs, w, 'm50')).toBe(true);
    expect(messageWindowContainsId(msgs, w, 'm5')).toBe(false);
    expect(messageWindowContainsId(msgs, w, 'missing')).toBe(false);
    expect(indicesMissingFromWindow(w, [5, 50, 3, 99, 200])).toEqual([3, 5]);
  });

  it('resolveExpandedForIncludes matches includeMany + clamp', () => {
    // index 5, context 0 → need 100-80-5=15
    expect(resolveExpandedForIncludes([5], 100, 80, 0, 0)).toBe(15);
    // overshoot clamp: total 90 recent 80 → max 10
    expect(resolveExpandedForIncludes([0], 90, 80, 0, 0)).toBe(10);
  });

  it('expandedOlderForPinJump expands to pin id', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    // pin m5, context 0 → need 15
    expect(expandedOlderForPinJump(msgs, 'm5', 0, 80, 0)).toBe(15);
    // missing id
    expect(expandedOlderForPinJump(msgs, 'nope', 3, 80, 0)).toBe(3);
    // already expanded enough is monotonic (within max = total-recent = 20)
    expect(expandedOlderForPinJump(msgs, 'm5', 18, 80, 0)).toBe(18);
    // overshoot currentExpanded is clamped via resolveExpandedForIncludes
    expect(expandedOlderForPinJump(msgs, 'm5', 40, 80, 0)).toBe(20);
  });

  it('expandedOlderForPinIds takes earliest pin; default context overscans', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    // pins m30 (in window) + m10 → earliest 10 with context 4 → target 6 → need 14
    expect(expandedOlderForPinIds(msgs, ['m30', 'm10'], 0, 80, 4)).toBe(14);
    expect(expandedOlderForPinIds(msgs, [], 12, 80, 0)).toBe(12);
    expect(expandedOlderForPinIds(msgs, ['nope'], 40, 80, 0)).toBe(20); // clamp only
  });

  it('expandedOlderForPendingApprovals covers pending rows with context', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      toolCalls:
        i === 8 ? [{ status: 'pending_approval' as const }] : undefined,
    }));
    // index 8, context 4 → target 4 → need 100-80-4 = 16
    expect(expandedOlderForPendingApprovals(msgs, 0, 80, 4)).toBe(16);
    // no pending → clamp only
    const clean = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    expect(expandedOlderForPendingApprovals(clean, 50, 80, 4)).toBe(20);
  });

  it('windowMessages mustInclude covers pin+approval via collect', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      toolCalls:
        i === 3
          ? [{ status: 'pending_approval' as const }]
          : undefined,
    }));
    const must = collectMustIncludeIndices(msgs, {
      includePendingApprovals: true,
      pinIds: ['m1'],
    });
    const r = windowMessages(msgs, {
      recentCount: 80,
      expandedOlder: 0,
      mustIncludeIndices: must,
      includeContext: 0,
    });
    // earliest is pin index 1 → need 100-80-1=19
    expect(r.startIndex).toBeLessThanOrEqual(1);
    expect(r.effectiveExpanded).toBe(19);
    expect(messageWindowContainsIndex(r, 1)).toBe(true);
    expect(messageWindowContainsIndex(r, 3)).toBe(true);
    expect(messageWindowContainsId(msgs, r, 'm1')).toBe(true);
    expect(messageWindowContainsId(msgs, r, 'm3')).toBe(true);
    expect(indicesMissingFromWindow(r, must)).toEqual([]);
  });

  it('dual-path: keepAlive resolve === windowMessages mustInclude raise', () => {
    const msgs = Array.from({ length: 120 }, (_, i) => ({
      id: `m${i}`,
      toolCalls:
        i === 2 || i === 7
          ? [{ status: 'pending_approval' as const }]
          : undefined,
    }));
    const keep = resolveExpandedForKeepAlive(msgs, {
      includePendingApprovals: true,
      pinIds: ['m4'],
      match: (m) => m.id === 'm0' || m.id === 'm50',
      matchOnlyFirst: true,
      currentExpanded: 0,
      recentCount: 80,
      contextBefore: 4,
    });
    // pending 2,7; pin 4; search first m0 → indices include 0 → with ctx target 0
    expect(keep.indices[0]).toBe(0);
    expect(keep.expandedOlder).toBe(40); // 120-80-0 = 40, clamped max 40

    const viaMust = windowMessages(msgs, {
      recentCount: 80,
      expandedOlder: 0,
      mustIncludeIndices: keep.indices,
      includeContext: 4,
    });
    const viaState = windowMessages(msgs, {
      recentCount: 80,
      expandedOlder: keep.expandedOlder,
    });
    expect(viaMust.effectiveExpanded).toBe(keep.expandedOlder);
    expect(viaState.effectiveExpanded).toBe(keep.expandedOlder);
    expect(viaMust.startIndex).toBe(viaState.startIndex);
    for (const idx of keep.indices) {
      expect(messageWindowContainsIndex(viaMust, idx)).toBe(true);
      expect(messageWindowContainsIndex(viaState, idx)).toBe(true);
    }
    expect(indicesMissingFromWindow(viaMust, keep.indices)).toEqual([]);
  });

  it('expand step then pin jump still covers pin (monotonic)', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    let expanded = 0;
    // one step: hidden was 20 → expand 20? wait recent 80 → hidden 20, step min(40,20)=20
    const first = windowMessages(msgs, { recentCount: 80, expandedOlder: expanded });
    expanded = nextExpandedOlder(expanded, first.hiddenCount);
    expect(expanded).toBe(20);
    // pin m5 with context 0 needs 15; already at 20 → stay 20
    expanded = expandedOlderForPinJump(msgs, 'm5', expanded, 80, 0);
    expect(expanded).toBe(20);
    const w = windowMessages(msgs, { recentCount: 80, expandedOlder: expanded });
    expect(messageWindowContainsId(msgs, w, 'm5')).toBe(true);
  });
});

describe('budgetDomText', () => {
  it('passes short text through', () => {
    expect(budgetDomText('hello', 100)).toEqual({
      text: 'hello',
      truncated: false,
      originalLength: 5,
    });
  });

  it('truncates long thinking / tool blobs', () => {
    const long = 'x'.repeat(THINKING_DOM_CHAR_CAP + 50);
    const r = budgetDomText(long, THINKING_DOM_CHAR_CAP);
    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(THINKING_DOM_CHAR_CAP + 50);
    expect(r.text.endsWith('…（已截断）')).toBe(true);
    expect(r.text.length).toBeLessThan(long.length);
  });

  it('tool cap constant is sane', () => {
    expect(TOOL_OUTPUT_DOM_CHAR_CAP).toBeGreaterThan(THINKING_DOM_CHAR_CAP);
  });
});

describe('computeMessageViewportSlice (lightweight overscan)', () => {
  it('returns full for short lists', () => {
    const r = computeMessageViewportSlice({ count: 20, scrollTop: 0, viewportHeight: 600 });
    expect(r.windowed).toBe(false);
    expect(r.start).toBe(0);
    expect(r.end).toBe(20);
  });

  it('windows long lists with overscan', () => {
    const r = computeMessageViewportSlice({
      count: 200,
      scrollTop: 0,
      viewportHeight: 600,
      estimatedRowHeight: 100,
      overscan: MESSAGE_VIEWPORT_OVERSCAN,
    });
    expect(r.windowed).toBe(true);
    expect(r.start).toBe(0);
    // ceil(600/100) + overscan*2 = 6 + 12 = 18
    expect(r.end).toBe(6 + MESSAGE_VIEWPORT_OVERSCAN * 2);
    expect(r.topPad).toBe(0);
    expect(r.bottomPad).toBeGreaterThan(0);
  });

  it('forceFull disables windowing', () => {
    const r = computeMessageViewportSlice({
      count: 200,
      forceFull: true,
      scrollTop: 5000,
      viewportHeight: 400,
    });
    expect(r.windowed).toBe(false);
    expect(r.start).toBe(0);
    expect(r.end).toBe(200);
  });

  it('scroll advances start', () => {
    const r = computeMessageViewportSlice({
      count: 200,
      scrollTop: 5000,
      viewportHeight: 600,
      estimatedRowHeight: 100,
      overscan: 2,
    });
    // floor(5000/100)-2 = 48
    expect(r.start).toBe(48);
    expect(r.topPad).toBe(48 * 100);
  });

  it('hardens NaN metrics so start/end/pad stay finite', () => {
    const r = computeMessageViewportSlice({
      count: 200,
      scrollTop: Number.NaN,
      viewportHeight: Number.NaN,
      estimatedRowHeight: Number.NaN,
      overscan: Number.NaN,
      threshold: Number.NaN,
    });
    expect(Number.isFinite(r.start)).toBe(true);
    expect(Number.isFinite(r.end)).toBe(true);
    expect(Number.isFinite(r.topPad)).toBe(true);
    expect(Number.isFinite(r.bottomPad)).toBe(true);
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.end).toBeGreaterThanOrEqual(r.start);
    expect(r.end).toBeLessThanOrEqual(200);
  });

  it('rejects non-positive row height / viewport (fallback defaults)', () => {
    const r = computeMessageViewportSlice({
      count: 200,
      scrollTop: 0,
      viewportHeight: -10,
      estimatedRowHeight: 0,
      overscan: -3,
    });
    expect(r.windowed).toBe(true);
    expect(r.start).toBe(0);
    expect(Number.isFinite(r.end)).toBe(true);
    expect(r.end).toBeGreaterThan(0);
  });
});

describe('residual hardening after BY (finite / integer contract)', () => {
  it('normalizeRecentCount / NonNegInt / MessageCount', () => {
    expect(normalizeRecentCount(undefined)).toBe(DEFAULT_RECENT_MESSAGE_COUNT);
    expect(normalizeRecentCount(Number.NaN)).toBe(DEFAULT_RECENT_MESSAGE_COUNT);
    expect(normalizeRecentCount(80.9)).toBe(80);
    expect(normalizeRecentCount(0)).toBe(1);
    expect(normalizeRecentCount(-4)).toBe(1);
    expect(normalizeNonNegInt(Number.NaN)).toBe(0);
    expect(normalizeNonNegInt(-2)).toBe(0);
    expect(normalizeNonNegInt(3.7)).toBe(3);
    expect(normalizeMessageCount(Number.NaN)).toBe(0);
    expect(normalizeMessageCount(12.8)).toBe(12);
    expect(normalizeMessageCount(-1)).toBe(0);
  });

  it('clampExpandedOlder never returns NaN for dirty recent/total', () => {
    expect(clampExpandedOlder(10, Number.NaN, 80)).toBe(0);
    expect(clampExpandedOlder(10, 100, Number.NaN)).toBe(10);
    expect(clampExpandedOlder(Number.NaN, 100, Number.NaN)).toBe(0);
    expect(clampExpandedOlder(40.9, 100.2, 80.7)).toBe(20); // floor → max 100-80=20
    expect(Number.isFinite(clampExpandedOlder(5, Number.POSITIVE_INFINITY, 80))).toBe(true);
  });

  it('fractional recent/expanded keeps visibleCount === visible.length', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    const r = windowMessages(msgs, { recentCount: 80.7, expandedOlder: 5.9 });
    expect(Number.isInteger(r.startIndex)).toBe(true);
    expect(Number.isInteger(r.visibleCount)).toBe(true);
    expect(r.visible).toHaveLength(r.visibleCount);
    expect(r.hiddenCount).toBe(r.startIndex);
    // recent 80 + expanded 5 = 85 → start 15
    expect(r.startIndex).toBe(15);
    expect(r.effectiveExpanded).toBe(5);
  });

  it('expandedOlderToShowAll hardens NaN total/recent', () => {
    expect(expandedOlderToShowAll(Number.NaN, 80)).toBe(0);
    expect(expandedOlderToShowAll(120, Number.NaN)).toBe(40); // recent → DEFAULT 80
    expect(expandedOlderToShowAll(120.9, 80.2)).toBe(40);
  });

  it('resolveExpandedForIncludes with NaN recent does not leak NaN', () => {
    const v = resolveExpandedForIncludes([5], 100, Number.NaN, 0, 0);
    expect(Number.isFinite(v)).toBe(true);
    // recent defaults to 80 → need 100-80-5 = 15
    expect(v).toBe(15);
  });

  it('messageWindowContainsIndex rejects fractional indices', () => {
    const w = {
      startIndex: 20,
      visibleCount: 80,
      totalCount: 100,
    };
    expect(messageWindowContainsIndex(w, 20)).toBe(true);
    expect(messageWindowContainsIndex(w, 20.5)).toBe(false);
    expect(messageWindowContainsIndex(w, 19.999)).toBe(false);
  });

  it('budgetDomText fail-open on non-finite / negative cap', () => {
    const long = 'y'.repeat(100);
    expect(budgetDomText(long, Number.NaN)).toEqual({
      text: long,
      truncated: false,
      originalLength: 100,
    });
    expect(budgetDomText(long, -1)).toEqual({
      text: long,
      truncated: false,
      originalLength: 100,
    });
    // finite fractional cap floors
    const r = budgetDomText(long, 10.9);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('y'.repeat(10))).toBe(true);
  });

  it('nextExpandedOlder floors fractional inputs', () => {
    expect(nextExpandedOlder(1.9, 10.2, 4.8)).toBe(5); // 1 + min(4,10)
    // ∞ current → 0 (non-finite), then + min(step, hidden)
    expect(nextExpandedOlder(Number.POSITIVE_INFINITY, 10, 40)).toBe(10);
  });
});
