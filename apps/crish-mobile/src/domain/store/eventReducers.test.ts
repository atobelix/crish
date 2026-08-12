// eventReducers 单测：环形裁剪（R2UX-05-09 500 条）/ 去重（M6 §8.3 seq 幂等）/
// 游标（preview 不推进 / 只升不降）/ 过滤（R2UX-05-06 过滤条数据面）/ 稳定排序（seq 升序）
import {
  FEED_RING_MAX,
  advanceCursor,
  appendFeed,
  createWindow,
  deriveErrorLevel,
  filterByRunId,
  filterByTypes,
  filterErrors,
  filterFeed,
  hydrateFeed,
  stableSortBySeq,
  type EventEnvelopeFrame,
  type FeedEntry,
} from './eventReducers';

const NOW = 1_800_000_000_000;

function frame(
  overrides: Partial<EventEnvelopeFrame> & { type: string }
): EventEnvelopeFrame {
  return { sessionId: 's-1', ...overrides };
}

function entry(
  seq: number | undefined,
  overrides: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    type: 'message-end',
    sessionId: 's-1',
    ...(seq !== undefined ? { sequence: seq } : {}),
    receivedAtMs: NOW,
    ...overrides,
  };
}

function seqs(
  window: ReturnType<typeof createWindow>
): Array<number | undefined> {
  return window.entries.map((e) => e.sequence);
}

describe('环形缓冲（F3 §3.4.2 / R2UX-05-09：上限 500 条，超出丢最旧）', () => {
  it('500 条内不裁剪，lastSeq 与 truncatedCount 正确', () => {
    const window = createWindow();
    for (let i = 1; i <= 500; i += 1) {
      expect(
        appendFeed(
          window,
          frame({ type: 'message-end', sequence: i }),
          false,
          NOW
        )
      ).toBe('appended');
    }
    expect(window.entries).toHaveLength(500);
    expect(window.lastSeq).toBe(500);
    expect(window.truncatedCount).toBe(0);
    expect(window.entries[0]!.sequence).toBe(1);
  });

  it('超出 500 条丢最旧：首条前进、truncatedCount 累计（顶部「已收起 N 条」标记）', () => {
    const window = createWindow();
    for (let i = 1; i <= 510; i += 1) {
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: i }),
        false,
        NOW
      );
    }
    expect(window.entries).toHaveLength(FEED_RING_MAX);
    expect(window.entries[0]!.sequence).toBe(11);
    expect(window.entries[FEED_RING_MAX - 1]!.sequence).toBe(510);
    expect(window.truncatedCount).toBe(10);
    expect(window.lastSeq).toBe(510);
  });
});

describe('去重与游标（M6 §8.3：seq 单调幂等 + 游标只升不降）', () => {
  it('重复 seq 原地覆盖（at-least-once 重放幂等，M6 §8.3 规则 2 / §10.5 同 seq 覆盖）', () => {
    const window = createWindow();
    expect(
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: 5 }),
        false,
        NOW
      )
    ).toBe('appended');
    // 同 seq 已在 buffer → 原地覆盖（条目数不增，幂等去重）
    expect(
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: 5 }),
        false,
        NOW
      )
    ).toBe('replaced');
    expect(window.entries).toHaveLength(1);
    expect(window.lastSeq).toBe(5);
  });

  it('回退 seq（乱序迟到）丢弃：游标只升不降（M6 §8.3 规则 4）', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-end', sequence: 10 }),
      false,
      NOW
    );
    expect(
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: 3 }),
        false,
        NOW
      )
    ).toBe('duplicate');
    expect(window.lastSeq).toBe(10);
    expect(window.entries).toHaveLength(1);
  });

  it('preview 帧不推进游标（M6 §10.5：sequence 未落库，移动端不推进）', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-delta', sequence: 100 }),
      true,
      NOW
    );
    expect(window.lastSeq).toBe(0);
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0]!.sequence).toBe(100);
  });

  it('preview → 正式帧同 seq 原地覆盖（持久化副本覆盖预览帧，M6 §10.5）+ 推进游标', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-delta', sequence: 100 }),
      true,
      NOW
    );
    expect(
      appendFeed(
        window,
        frame({ type: 'message-delta', sequence: 100 }),
        false,
        NOW
      )
    ).toBe('replaced');
    expect(window.entries).toHaveLength(1);
    expect(window.lastSeq).toBe(100);
    // 保留首次收达时间（本地附加不重置）
    expect(window.entries[0]!.receivedAtMs).toBe(NOW);
  });

  it('preview 与正式帧交错乱序 → 稳定重排为 seq 升序', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-delta', sequence: 105 }),
      true,
      NOW
    );
    appendFeed(
      window,
      frame({ type: 'message-end', sequence: 104 }),
      false,
      NOW
    );
    expect(seqs(window)).toEqual([104, 105]);
    expect(window.lastSeq).toBe(104);
  });

  it('无 sequence 帧（legacy/畸形）：追加展示但不记游标（M6 §7.3 Delta 不记游标）', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-delta', sequence: 10 }),
      false,
      NOW
    );
    appendFeed(window, frame({ type: 'message-delta' }), false, NOW);
    expect(window.entries).toHaveLength(2);
    expect(window.lastSeq).toBe(10);
  });

  it('被环形淘汰后的重复 seq 丢弃（buffer 已无该 seq，靠游标判重）', () => {
    const window = createWindow();
    for (let i = 1; i <= 501; i += 1) {
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: i }),
        false,
        NOW
      );
    }
    expect(
      appendFeed(
        window,
        frame({ type: 'message-end', sequence: 1 }),
        false,
        NOW
      )
    ).toBe('duplicate');
    expect(window.entries).toHaveLength(FEED_RING_MAX);
  });
});

describe('hydrate（events.resume.page 续传页合并，M6 §4.1.3）', () => {
  it('续传页与现有 buffer 合并：seq 去重 + 游标取较大者', () => {
    const window = createWindow();
    appendFeed(window, frame({ type: 'message-end', sequence: 2 }), false, NOW);
    appendFeed(window, frame({ type: 'message-end', sequence: 3 }), false, NOW);
    hydrateFeed(
      window,
      [
        frame({ type: 'message-end', sequence: 2 }),
        frame({ type: 'message-end', sequence: 3 }),
        frame({ type: 'message-end', sequence: 4 }),
      ],
      5,
      NOW
    );
    expect(seqs(window)).toEqual([2, 3, 4]);
    expect(window.lastSeq).toBe(5);
  });

  it('空洞不补拉：seq ≤ 游标且不在 buffer（已消费/空洞）→ 丢弃（M6 §8.3 规则 3 空洞容忍）', () => {
    const window = createWindow();
    appendFeed(window, frame({ type: 'message-end', sequence: 2 }), false, NOW);
    appendFeed(window, frame({ type: 'message-end', sequence: 3 }), false, NOW);
    hydrateFeed(window, [frame({ type: 'message-end', sequence: 1 })], 3, NOW);
    expect(seqs(window)).toEqual([2, 3]);
    expect(window.lastSeq).toBe(3);
  });

  it('游标只升不降：低于现有游标的 cursor 不覆盖', () => {
    const window = createWindow();
    appendFeed(
      window,
      frame({ type: 'message-end', sequence: 10 }),
      false,
      NOW
    );
    hydrateFeed(window, [frame({ type: 'message-end', sequence: 11 })], 3, NOW);
    expect(window.lastSeq).toBe(11);
  });

  it('advanceCursor（resume.done resumedTo）只升不降', () => {
    const window = createWindow();
    advanceCursor(window, 50);
    expect(window.lastSeq).toBe(50);
    advanceCursor(window, 20);
    expect(window.lastSeq).toBe(50);
  });
});

describe('稳定排序（seq 升序；无 seq 帧尾部保持到达序）', () => {
  it('有 seq 条目升序，同 seq 保持原相对序（稳定）', () => {
    const a = entry(2, { receivedAtMs: NOW + 1 });
    const b = entry(1, { receivedAtMs: NOW + 2 });
    const c = entry(2, { receivedAtMs: NOW + 3 });
    const sorted = stableSortBySeq([a, b, c]);
    expect(sorted.map((e) => e.sequence)).toEqual([1, 2, 2]);
    expect(sorted[1]).toBe(a);
    expect(sorted[2]).toBe(c);
  });

  it('无 seq 帧置于尾部且保持到达序', () => {
    const a = entry(1);
    const b = entry(undefined, { receivedAtMs: NOW + 1 });
    const c = entry(undefined, { receivedAtMs: NOW + 2 });
    const sorted = stableSortBySeq([b, a, c]);
    expect(sorted).toHaveLength(3);
    expect(sorted[0]).toBe(a);
    expect(sorted[1]).toBe(b);
    expect(sorted[2]).toBe(c);
  });
});

describe('过滤（R2UX-05-06 过滤条数据面）', () => {
  it('deriveErrorLevel：五类错误源（F3 §5.1 错误高亮清单）', () => {
    expect(deriveErrorLevel(frame({ type: 'runtime-error' }))).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'run-terminal', terminal: 'failed' }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'run-terminal', terminal: 'completed' }))
    ).toBe(false);
    expect(
      deriveErrorLevel(frame({ type: 'tool-end', result: { isError: true } }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'tool-end', result: { isError: false } }))
    ).toBe(false);
    expect(deriveErrorLevel(frame({ type: 'task-failed' }))).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'security-audit', decision: 'blocked' }))
    ).toBe(true);
    expect(
      deriveErrorLevel(frame({ type: 'security-audit', decision: 'approved' }))
    ).toBe(false);
    expect(deriveErrorLevel(frame({ type: 'message-end' }))).toBe(false);
  });

  it('filterErrors：只看错误', () => {
    const items = [
      entry(1, { type: 'runtime-error' }),
      entry(2, { type: 'message-end' }),
      entry(3, { type: 'task-failed' }),
    ];
    const filtered = filterErrors(items);
    expect(filtered.map((e) => e.type)).toEqual([
      'runtime-error',
      'task-failed',
    ]);
  });

  it('filterByRunId：只看当前 run（无 runId 会话级/数据面条目隐藏，F3 §5.1 分组规则）', () => {
    const items = [
      entry(1, { type: 'agent-start', runId: 'r-1' }),
      entry(2, { type: 'message-end', runId: 'r-1' }),
      entry(3, { type: 'message-end', runId: 'r-2' }),
      entry(4, { type: 'task-started' }),
    ];
    const filtered = filterByRunId(items, 'r-1');
    expect(filtered.map((e) => e.runId)).toEqual(['r-1', 'r-1']);
  });

  it('filterByTypes：kind 白名单（只看工具）', () => {
    const items = [
      entry(1, { type: 'tool-start' }),
      entry(2, { type: 'message-end' }),
      entry(3, { type: 'task-started' }),
    ];
    const filtered = filterByTypes(
      items,
      new Set(['tool-start', 'tool-end', 'task-started'])
    );
    expect(filtered.map((e) => e.type)).toEqual(['tool-start', 'task-started']);
  });

  it('filterFeed：三维度组合（错误 ∧ run ∧ 类型），空白名单不过滤', () => {
    const items = [
      entry(1, { type: 'runtime-error', runId: 'r-1' }),
      entry(2, { type: 'runtime-error', runId: 'r-2' }),
      entry(3, { type: 'message-end', runId: 'r-1' }),
    ];
    const filtered = filterFeed(items, { errorsOnly: true, runId: 'r-1' });
    expect(filtered.map((e) => e.sequence)).toEqual([1]);
    // 无过滤条件 → 原样
    expect(filterFeed(items, {})).toHaveLength(3);
    expect(filterFeed(items, { typeWhitelist: new Set() })).toHaveLength(3);
  });
});
