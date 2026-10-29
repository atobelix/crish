// RelaySocket 协议适配：票据 → relay.ready/peer → 业务帧透明收发。
import { RelaySocket } from './RelaySocket';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
    MockWebSocket;
});

afterEach(() => {
  (globalThis as unknown as { WebSocket: typeof OriginalWebSocket }).WebSocket =
    OriginalWebSocket;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RelaySocket', () => {
  it('等待 host online 后才 onopen，并自动包/解 relay.data', async () => {
    const socket = new RelaySocket(async () => ({
      url: 'wss://relay.example/v1/relay',
      ticket: 't-1',
    }));
    await flush();
    const native = MockWebSocket.instances[0]!;
    expect(native.url).toContain('ticket=t-1');
    const opened = jest.fn();
    const messages: unknown[] = [];
    socket.onopen = opened;
    socket.onmessage = (event) => messages.push(event.data);

    native.open();
    native.receive({ type: 'relay.ready', role: 'client' });
    expect(opened).not.toHaveBeenCalled();
    native.receive({ type: 'relay.peer', state: 'online' });
    expect(opened).toHaveBeenCalledTimes(1);

    native.receive({
      type: 'relay.data',
      payload: { v: 1, kind: 'heartbeat', body: {} },
    });
    expect(JSON.parse(String(messages[0]))).toEqual({
      v: 1,
      kind: 'heartbeat',
      body: {},
    });

    socket.send(JSON.stringify({ v: 1, kind: 'events.subscribe', body: {} }));
    expect(JSON.parse(native.sent[0]!)).toEqual({
      type: 'relay.data',
      payload: { v: 1, kind: 'events.subscribe', body: {} },
    });

    native.receive({ type: 'relay.ping', ts: 7 });
    expect(JSON.parse(native.sent[1]!)).toEqual({ type: 'relay.pong', ts: 7 });
    socket.close();
  });

  it('peer offline 后触发 close，驱动上层重连', async () => {
    const socket = new RelaySocket(async () => ({
      url: 'wss://relay.example/v1/relay',
      ticket: 't-2',
    }));
    await flush();
    const native = MockWebSocket.instances[0]!;
    const closed = jest.fn();
    socket.onopen = jest.fn();
    socket.onclose = closed;
    native.open();
    native.receive({ type: 'relay.peer', state: 'online' });
    native.receive({ type: 'relay.peer', state: 'offline' });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('票据申请失败触发 error + close', async () => {
    const socket = new RelaySocket(async () => {
      throw new Error('ticket failed');
    });
    const errored = jest.fn();
    const closed = jest.fn();
    socket.onerror = errored;
    socket.onclose = closed;
    await flush();
    expect(errored).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });
});
