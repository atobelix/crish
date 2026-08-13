// previewFlushScheduler 单测（R2UX-05-02 渲染节流 / F3 §3.4.1 语义）：
// - 帧合并：窗口内同 key 高频帧合并为一次渲染，只回调最新值（同 seq 覆盖语义）；
// - 强制刷新边界：连续帧流中窗口被反复重置时，从本波首帧起 maxWaitMs 内必然渲染；
// - 终值立即：final 帧 / flushNow 同步刷出全部 pending，不留待渲染帧；
// - 多 key 合并保序（Map 插入序）/ drop / reset / 回调 re-entrant 接续。
import {
  PREVIEW_MAX_WAIT_MS,
  PREVIEW_MERGE_WINDOW_MS,
  PreviewFlushScheduler,
} from './previewFlushScheduler';

function makeHarness(
  options: {
    mergeWindowMs?: number;
    maxWaitMs?: number;
  } = {}
) {
  const flushed: Array<[string, string]> = [];
  const scheduler = new PreviewFlushScheduler(
    (key, value) => flushed.push([key, value]),
    options
  );
  return { scheduler, flushed };
}

describe('帧合并（同 seq 高频帧合并为一次渲染，R2UX-05-02）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('窗口内 3 帧合并为 1 次 flush，只回调最新值（全文覆盖语义）', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('seq:10', 't1');
    scheduler.push('seq:10', 't2');
    scheduler.push('seq:10', 't3');
    expect(flushed).toHaveLength(0); // 窗口未到期不渲染
    expect(scheduler.pendingCount()).toBe(1); // 同 key 只保留一份
    expect(scheduler.isScheduled()).toBe(true);
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['seq:10', 't3']]); // 只回调最新值
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('滚动窗口：每帧刷新窗口——末帧到达后 mergeWindowMs 才 flush', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k', 'a');
    jest.advanceTimersByTime(10);
    scheduler.push('k', 'b'); // 窗口重置（滚动）
    jest.advanceTimersByTime(10);
    expect(flushed).toHaveLength(0); // 首帧后的 18ms 已过，但末帧重置了窗口
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS - 10);
    expect(flushed).toEqual([['k', 'b']]);
  });

  it('多 key 同窗口合并，flush 顺序 = Map 插入序（确定性）', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('seq:1', 'a');
    scheduler.push('seq:2', 'b');
    scheduler.push('seq:1', 'a2'); // 同 key 覆盖
    scheduler.push('seq:3', 'c');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([
      ['seq:1', 'a2'],
      ['seq:2', 'b'],
      ['seq:3', 'c'],
    ]);
  });

  it('窗口到期 flush 后，新 push 开启新窗口（波次独立）', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k', 'v1');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    scheduler.push('k', 'v2');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([
      ['k', 'v1'],
      ['k', 'v2'],
    ]);
  });
});

describe('强制刷新边界（maxWaitMs=100：连续帧流保证渲染节奏，T20 ≤100ms）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('帧流持续到达（窗口反复重置）→ maxWaitMs 内必然 flush 一次', () => {
    const { scheduler, flushed } = makeHarness();
    // 每 10ms 一帧、持续 15 帧：滚动窗口永不自然到期
    for (let i = 0; i < 15; i += 1) {
      scheduler.push('seq:5', `frame-${i}`);
      jest.advanceTimersByTime(10);
    }
    // 本波首帧 +100ms（t=100，第 10 次推进期间）强制刷新：交付当时最新值
    // （frame-9）；后续帧（10-14）进入新一波滚动窗口（长流渲染节奏由 maxWait 保证）
    expect(flushed).toEqual([['seq:5', 'frame-9']]);
    expect(scheduler.pendingCount()).toBe(1); // frame-14 待刷
    expect(scheduler.isScheduled()).toBe(true); // 新一波窗口已排程
    // 帧流暂停后按窗口 flush 最新值
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([
      ['seq:5', 'frame-9'],
      ['seq:5', 'frame-14'],
    ]);
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('帧流暂停（窗口自然到期）→ 按窗口 flush，不等待 maxWait', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k', 'v1');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['k', 'v1']]);
    // 窗口 flush 已清空强制刷新边界：继续走不会有第二次回调
    jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS);
    expect(flushed).toHaveLength(1);
  });

  it('maxWaitMs 配置为 0：禁用强制刷新（纯滚动窗口语义）', () => {
    const { scheduler, flushed } = makeHarness({ maxWaitMs: 0 });
    for (let i = 0; i < 12; i += 1) {
      scheduler.push('k', `f-${i}`);
      jest.advanceTimersByTime(10); // 每 10ms 一帧，永不暂停
    }
    expect(flushed).toHaveLength(0); // 无边界兜底：持续帧流不渲染
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['k', 'f-11']]); // 帧流停止后才按窗口 flush
  });
});

describe('终值立即刷新（final / flushNow，F3 §3.4.1 终态强制 flushNow）', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('final 帧到达：pending 立即同步刷出，不留待渲染帧', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('seq:9', '预览文本');
    scheduler.push('seq:9', '最终全文', { final: true });
    expect(flushed).toEqual([['seq:9', '最终全文']]); // 同步回调
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
    // 窗口早已被 final 清掉：推进时间无副作用
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS * 2);
    expect(flushed).toHaveLength(1);
  });

  it('final 帧同时刷出其它流式 key 的 pending（终值不延迟，批次整体落盘）', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('seq:1', 'a1');
    scheduler.push('seq:2', 'b1');
    scheduler.push('seq:2', '终值', { final: true });
    expect(flushed).toEqual([
      ['seq:1', 'a1'],
      ['seq:2', '终值'],
    ]);
  });

  it('手动 flushNow：立即清空全部 pending（终态 / unmount 显式路径）', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k1', 'v1');
    scheduler.push('k2', 'v2');
    scheduler.flushNow();
    expect(flushed).toEqual([
      ['k1', 'v1'],
      ['k2', 'v2'],
    ]);
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('mergeWindowMs ≤ 0：同步路径——每次 push 立即 flush（测试旁路）', () => {
    const { scheduler, flushed } = makeHarness({ mergeWindowMs: 0 });
    scheduler.push('k', 'v1');
    scheduler.push('k', 'v2');
    expect(flushed).toEqual([
      ['k', 'v1'],
      ['k', 'v2'],
    ]);
  });
});

describe('drop / reset / 回调 re-entrant', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('drop：移除指定 key；pending 空则取消定时器，窗口过期不回调', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k', 'v');
    scheduler.drop('k');
    expect(scheduler.pendingCount()).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
    jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS * 2);
    expect(flushed).toHaveLength(0);
  });

  it('drop 只移除指定 key，其余 key 继续合并', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('a', '1');
    scheduler.push('b', '2');
    scheduler.drop('a');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['b', '2']]);
  });

  it('reset：清空 pending 与定时器且不回调；实例可继续复用', () => {
    const { scheduler, flushed } = makeHarness();
    scheduler.push('k', 'v');
    scheduler.reset();
    expect(scheduler.pendingCount()).toBe(0);
    jest.advanceTimersByTime(PREVIEW_MAX_WAIT_MS * 2);
    expect(flushed).toHaveLength(0);
    scheduler.push('k', 'v2');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['k', 'v2']]); // reset 后实例可复用
  });

  it('flush 回调内 push：收尾自动接续下一窗口，不丢帧', () => {
    const flushed: Array<[string, string]> = [];
    const scheduler = new PreviewFlushScheduler((key, value) => {
      flushed.push([key, value]);
      // 回调内 re-entrant push（模拟 setState → 重渲染推新帧）
      if (value === 'v1') {
        scheduler.push(key, 'v2');
      }
    });
    scheduler.push('k', 'v1');
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([['k', 'v1']]); // 首窗 flush v1
    // re-entrant 推入的 v2 已接续到下一窗口（flushNow 收尾自动排程）
    expect(scheduler.pendingCount()).toBe(1);
    expect(scheduler.isScheduled()).toBe(true);
    jest.advanceTimersByTime(PREVIEW_MERGE_WINDOW_MS);
    expect(flushed).toEqual([
      ['k', 'v1'],
      ['k', 'v2'],
    ]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('flush 回调抛错：失败项与其后未刷项回填（错误上抛）', () => {
    const flushed: string[] = [];
    const scheduler = new PreviewFlushScheduler((key, value) => {
      if (value === 'bad') throw new Error('flush 失败');
      flushed.push(value);
    });
    scheduler.push('k1', 'ok1');
    scheduler.push('k2', 'bad');
    scheduler.push('k3', 'ok3');
    expect(() => scheduler.flushNow()).toThrow('flush 失败');
    // k2（失败项）与 k3（其后未刷项）回填；k1 已成功
    expect(flushed).toEqual(['ok1']);
    expect(scheduler.pendingCount()).toBe(2);
  });
});
