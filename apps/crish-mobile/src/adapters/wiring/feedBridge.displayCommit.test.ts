// FeedBridge 展示合帧单测（R4 远程 WS 展示合帧，Q4/F4）：
// - preview 展示帧（不推进游标）入有界缓冲按窗口合并提交，连续帧一次通知；
// - 正式帧/终态副作用/相位断线/卸载 flush 原序立即，游标推进与 gap/resume 不延迟；
// - 跨会话独立：A 会话待合帧不被 B 会话的终态冲刷带走；
// - 背压有界：每会话待合帧到顶立即冲刷，无无限队列。
import { act } from '@testing-library/react-native';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';
import { WsGateway } from '@/network/WsGateway';
import type { SessionIndexEntry } from '@crish/shared-types';
import { eventStore, lastSeqOf, windowOf } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { FeedBridge } from './feedBridge';

/** 合帧窗口设为极大值：测试内定时器不触发，冲刷只由 cap/显式 flush 驱动 */
const HUGE_WINDOW_MS = 60_000;

function frame(kind: string, body: unknown): InboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: `m-in-${Math.random().toString(36).slice(2)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body: body as JsonValue,
  };
}

function previewPush(
  sessionId: string,
  sequence: number,
  text: string
): InboundEnvelope {
  return frame('events.push', {
    event: { type: 'message-delta', sessionId, sequence, text },
    preview: true,
  });
}

function realPush(
  sessionId: string,
  sequence: number,
  overrides: Record<string, unknown>
): InboundEnvelope {
  return frame('events.push', {
    event: { type: 'message-delta', sessionId, sequence, ...overrides },
  });
}

function sessionEntry(id: string): SessionIndexEntry {
  return { id, updatedAt: 1 };
}

function resetStores(): void {
  eventStore.setState({ windows: {}, network: 'live', ownerDeviceId: null });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
}

beforeEach(() => {
  resetStores();
});

describe('R4 展示合帧：preview 帧有界缓冲（连续帧一次通知）', () => {
  it('连续 preview 帧合并：窗口内到 cap 才一次提交，其余待合（fail-first：逐帧通知为红）', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    const listener = jest.fn();
    const unsub = eventStore.subscribe(listener);
    bridge.attach();

    await act(async () => {
      for (let i = 1; i <= 10; i += 1) {
        gateway.dispatchFrame(previewPush('s-1', i, `t${i}`));
      }
    });

    // 背压有界：第 8 帧到 cap 立即冲刷一次；第 9、10 帧仍在待合缓冲（窗口未到期）
    expect(listener).toHaveBeenCalledTimes(1);
    expect(windowOf('s-1').entries).toHaveLength(8);

    unsub();
    bridge.detach();
  });

  it('显式断线 flush：待合帧全部落店，最终内容无丢失且原序不变', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    bridge.attach();

    await act(async () => {
      for (let i = 1; i <= 10; i += 1) {
        gateway.dispatchFrame(previewPush('s-1', i, `t${i}`));
      }
    });
    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });

    const entries = windowOf('s-1').entries;
    expect(entries).toHaveLength(10);
    expect(entries.map((e) => e['text'])).toEqual([
      't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10',
    ]);
    // preview 不推进游标（M6 §10.5）
    expect(lastSeqOf('s-1')).toBe(0);

    bridge.detach();
  });

  it('背压有界：30 帧产生 3 次 cap 冲刷，无无限队列', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    const listener = jest.fn();
    const unsub = eventStore.subscribe(listener);
    bridge.attach();

    await act(async () => {
      for (let i = 1; i <= 30; i += 1) {
        gateway.dispatchFrame(previewPush('s-1', i, `t${i}`));
      }
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(windowOf('s-1').entries).toHaveLength(24);

    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });
    expect(windowOf('s-1').entries).toHaveLength(30);

    unsub();
    bridge.detach();
  });
});

describe('R4 展示合帧：正式帧与终态不延迟', () => {
  it('正式帧同步提交并推进游标（不进合帧缓冲）', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    const listener = jest.fn();
    const unsub = eventStore.subscribe(listener);
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(realPush('s-1', 1, { text: 'real-1' }));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(windowOf('s-1').entries).toHaveLength(1);
    expect(lastSeqOf('s-1')).toBe(1);

    unsub();
    bridge.detach();
  });

  it('终态帧先冲刷待合 preview 再立即落店（同 seq 由正式帧覆盖）', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    const listener = jest.fn();
    const unsub = eventStore.subscribe(listener);
    sessionStore.getState().upsert(sessionEntry('s-1'));
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(realPush('s-1', 1, { text: 'real-1' }));
      // 同 seq 连续 delta：缓冲层合并为一条最新内容
      gateway.dispatchFrame(previewPush('s-1', 2, 'delta-a'));
      gateway.dispatchFrame(previewPush('s-1', 2, 'delta-b'));
      gateway.dispatchFrame(previewPush('s-1', 2, 'delta-c'));
    });
    // 待合期间数据面不含 preview，游标不动
    expect(listener).toHaveBeenCalledTimes(1);
    expect(windowOf('s-1').entries).toHaveLength(1);

    await act(async () => {
      gateway.dispatchFrame(
        frame('events.push', {
          event: {
            type: 'message-end',
            sessionId: 's-1',
            sequence: 2,
            text: 'real-final',
            message: { role: 'assistant' },
          },
        })
      );
    });

    // 终态帧同步落店：先冲 preview（1 次提交），再正式帧 append + unread 副作用
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    const entries = windowOf('s-1').entries;
    expect(entries).toHaveLength(2);
    expect(entries[1]!['text']).toBe('real-final');
    expect(lastSeqOf('s-1')).toBe(2);

    unsub();
    bridge.detach();
  });

  it('断线相位切换 flush：待合帧立即落店', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(realPush('s-1', 1, { text: 'real-1' }));
      gateway.dispatchFrame(previewPush('s-1', 2, 'pending-1'));
    });
    expect(windowOf('s-1').entries).toHaveLength(1);

    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });
    expect(windowOf('s-1').entries).toHaveLength(2);
    expect(lastSeqOf('s-1')).toBe(1);

    bridge.detach();
  });

  it('detach flush：卸载前待合帧落店，不丢内容', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(previewPush('s-1', 1, 'pending-1'));
    });
    expect(windowOf('s-1').entries).toHaveLength(0);

    bridge.detach();
    expect(windowOf('s-1').entries).toHaveLength(1);
    expect(windowOf('s-1').entries[0]!['text']).toBe('pending-1');
  });
});

describe('R4 展示合帧：跨会话独立与 gap/drain 共存', () => {
  it('多会话独立：B 会话终态不冲刷 A 会话待合帧', async () => {
    const gateway = new WsGateway();
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(previewPush('s-a', 1, 'a-1'));
      gateway.dispatchFrame(previewPush('s-a', 2, 'a-2'));
      gateway.dispatchFrame(realPush('s-b', 1, { text: 'b-real' }));
    });

    // B 正式帧同步落店；A 待合帧不被带走
    expect(windowOf('s-b').entries).toHaveLength(1);
    expect(windowOf('s-a').entries).toHaveLength(0);

    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });
    expect(windowOf('s-a').entries).toHaveLength(2);

    bridge.detach();
  });

  it('gap/resume/stash 与合帧共存：补洞后按序落店，正式帧覆盖 preview', async () => {
    const gateway = new WsGateway();
    const sendSpy = jest.fn();
    gateway.attachSend(sendSpy);
    const bridge = new FeedBridge({ gateway, displayCommitWindowMs: HUGE_WINDOW_MS });
    bridge.attach();

    await act(async () => {
      gateway.dispatchFrame(realPush('s-1', 1, { text: 'real-1' }));
      // seq 3 空洞：preview 高帧暂存并触发 resume 补洞
      gateway.dispatchFrame(previewPush('s-1', 3, 'gap-preview'));
      // seq 2 到达闭合空洞 → drain stash
      gateway.dispatchFrame(realPush('s-1', 2, { text: 'real-2' }));
    });

    expect(
      sendSpy.mock.calls.some((call) =>
        JSON.stringify(call[0]).includes('events.resume')
      )
    ).toBe(true);
    // drain 出的 preview 进待合缓冲，数据面暂时只有 1、2
    expect(windowOf('s-1').entries.map((e) => e['sequence'])).toEqual([1, 2]);

    await act(async () => {
      bridge.handlePhaseChange('reconnecting');
    });
    expect(windowOf('s-1').entries.map((e) => e['sequence'])).toEqual([1, 2, 3]);
    expect(windowOf('s-1').entries[2]!['text']).toBe('gap-preview');

    // 正式 seq 3 到达：先冲缓冲再落店，preview 被正式帧覆盖，游标推进
    await act(async () => {
      gateway.dispatchFrame(realPush('s-1', 3, { text: 'real-3' }));
    });
    expect(windowOf('s-1').entries[2]!['text']).toBe('real-3');
    expect(lastSeqOf('s-1')).toBe(3);

    bridge.detach();
  });
});
