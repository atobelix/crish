// relay 装配预算测试（CON-1 三层预算对齐）：ensureRelayObservationWiring
// 给 ReconnectingWsClient 注入的握手看门狗必须覆盖「票据 HTTP 25s + peer
// 等待 20s」= 45s，重试上限放大为 10。缺省 8s/5 次在弱网下会被三层预算
// 互相掐断：看门狗从工厂返回 socket 起算，票据还没回来就记一次失败，
// 约 1–2 分钟耗尽重试进 dead（审计 A.4）。
import {
  ensureRelayObservationWiring,
  resetObservationWiringForTest,
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_MAX_RETRIES,
} from './observationWiring';
import type { WsSocket } from '@/network/ReconnectingWsClient';

/** mock WebSocket：close() 同步触发 onclose（对齐 RN 真实行为）。 */
class FakeSocket implements WsSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  send(): void {
    // 测试不发帧
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function relayWiringWith(sockets: FakeSocket[]) {
  return ensureRelayObservationWiring({
    url: 'relay://d-1',
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  resetObservationWiringForTest();
});

afterEach(() => {
  resetObservationWiringForTest();
  jest.useRealTimers();
});

describe('relay 装配预算（CON-1）', () => {
  it('预算常量：看门狗 = 票据 25s + peer 等待 20s = 45s；重试上限 10', () => {
    expect(RELAY_CONNECT_TIMEOUT_MS).toBe(45_000);
    expect(RELAY_MAX_RETRIES).toBe(10);
  });

  it('握手看门狗 45s：缺省 8s 点不误杀慢握手，45s 到点才放弃', () => {
    const sockets: FakeSocket[] = [];
    const wiring = relayWiringWith(sockets);
    expect(wiring.client.phase).toBe('connecting');
    expect(sockets).toHaveLength(1);

    jest.advanceTimersByTime(8_000);
    expect(sockets[0]!.closed).toBe(false);
    jest.advanceTimersByTime(RELAY_CONNECT_TIMEOUT_MS - 8_000 - 1);
    expect(sockets[0]!.closed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(sockets[0]!.closed).toBe(true);
  });

  it('重试上限 10：连续 10 次失败仍在重连，第 11 次才进 dead', () => {
    const sockets: FakeSocket[] = [];
    const wiring = relayWiringWith(sockets);

    // 每轮：当前 socket 立即失败 → 退避（≤30s 封顶 + ≤1s 抖动）→ 下一 socket。
    // 退避窗口 31s < 看门狗 45s，不会混入看门狗失败。
    for (let round = 0; round < 10; round++) {
      sockets[sockets.length - 1]!.close();
      jest.advanceTimersByTime(31_000);
    }
    expect(sockets).toHaveLength(11);
    expect(wiring.client.phase).not.toBe('dead');

    sockets[sockets.length - 1]!.close();
    expect(wiring.client.phase).toBe('dead');
  });
});
