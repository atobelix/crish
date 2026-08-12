// eventStore 单测：ingest 入站（preview/去重/游标）/ hydrate / network / 窗口卸载
// （M5 §3.1.1 eventStore 动作面 + R2UX-05-09 内存预算数据面）
import { eventStore, lastSeqOf, windowOf } from './eventStore';
import { FEED_RING_MAX, type EventEnvelopeFrame } from './eventReducers';

const NOW = 1_800_000_000_000;

function frame(
  overrides: Partial<EventEnvelopeFrame> & { type: string }
): EventEnvelopeFrame {
  return { sessionId: 's-1', ...overrides };
}

function resetStore(): void {
  eventStore.setState({ windows: {}, network: 'live' });
}

beforeEach(() => {
  resetStore();
});

describe('ingest（events.push 入站，M6 §10.5）', () => {
  it('正式帧推进游标（resume lastSequences 数据面）', () => {
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-end', sequence: 5 }), false, NOW);
    expect(lastSeqOf('s-1')).toBe(5);
    expect(windowOf('s-1').entries).toHaveLength(1);
  });

  it('preview 帧不推进游标；正式帧同 seq 覆盖', () => {
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-delta', sequence: 7 }), true, NOW);
    expect(lastSeqOf('s-1')).toBe(0);
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-delta', sequence: 7 }), false, NOW);
    expect(lastSeqOf('s-1')).toBe(7);
    expect(windowOf('s-1').entries).toHaveLength(1);
  });

  it('重复 seq 丢弃（幂等重放，E2E-10 同型语义）', () => {
    const state = eventStore.getState();
    state.ingest(
      's-1',
      frame({ type: 'message-end', sequence: 3 }),
      false,
      NOW
    );
    state.ingest(
      's-1',
      frame({ type: 'message-end', sequence: 3 }),
      false,
      NOW
    );
    state.ingest(
      's-1',
      frame({ type: 'message-end', sequence: 2 }),
      false,
      NOW
    );
    expect(windowOf('s-1').entries).toHaveLength(1);
    expect(lastSeqOf('s-1')).toBe(3);
  });

  it('不同会话窗口隔离', () => {
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-end', sequence: 1 }), false, NOW);
    eventStore
      .getState()
      .ingest('s-2', frame({ type: 'message-end', sequence: 9 }), false, NOW);
    expect(lastSeqOf('s-1')).toBe(1);
    expect(lastSeqOf('s-2')).toBe(9);
  });
});

describe('hydrate（events.resume.page 续传）', () => {
  it('续传页合并 + 游标对齐（nextAfterSequence）', () => {
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-end', sequence: 4 }), false, NOW);
    eventStore
      .getState()
      .hydrate(
        's-1',
        [
          frame({ type: 'message-end', sequence: 4 }),
          frame({ type: 'message-end', sequence: 5 }),
        ],
        6,
        NOW
      );
    expect(windowOf('s-1').entries.map((e) => e.sequence)).toEqual([4, 5]);
    expect(lastSeqOf('s-1')).toBe(6);
  });

  it('空洞不补拉：seq ≤ 游标且不在 buffer → 丢弃（M6 §8.3 规则 3）', () => {
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-end', sequence: 4 }), false, NOW);
    eventStore
      .getState()
      .hydrate('s-1', [frame({ type: 'message-end', sequence: 1 })], 4, NOW);
    expect(windowOf('s-1').entries.map((e) => e.sequence)).toEqual([4]);
    expect(lastSeqOf('s-1')).toBe(4);
  });
});

describe('游标对齐与网络相位（F3 §3.2.1）', () => {
  it('setCursor 只升不降（resume.done resumedTo）', () => {
    eventStore.getState().setCursor('s-1', 100);
    expect(lastSeqOf('s-1')).toBe(100);
    eventStore.getState().setCursor('s-1', 50);
    expect(lastSeqOf('s-1')).toBe(100);
  });

  it('network 相位切换（live/reconnecting/offline）', () => {
    expect(eventStore.getState().network).toBe('live');
    eventStore.getState().setNetwork('reconnecting');
    expect(eventStore.getState().network).toBe('reconnecting');
    eventStore.getState().setNetwork('offline');
    expect(eventStore.getState().network).toBe('offline');
    eventStore.getState().setNetwork('live');
  });
});

describe('窗口卸载（R2UX-05-09 内存预算）', () => {
  it('unloadWindow 移除窗口与游标（未建窗幂等）', () => {
    for (let i = 1; i <= FEED_RING_MAX + 5; i += 1) {
      eventStore
        .getState()
        .ingest('s-1', frame({ type: 'message-end', sequence: i }), false, NOW);
    }
    eventStore.getState().unloadWindow('s-1');
    expect(eventStore.getState().windows['s-1']).toBeUndefined();
    expect(lastSeqOf('s-1')).toBe(0);
    // 幂等：未建窗卸载不抛错
    eventStore.getState().unloadWindow('s-1');
    // 卸载后重新 ingest 重建窗口
    eventStore
      .getState()
      .ingest('s-1', frame({ type: 'message-end', sequence: 1 }), false, NOW);
    expect(windowOf('s-1').entries).toHaveLength(1);
  });
});
