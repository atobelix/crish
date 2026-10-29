// 中继 WebSocket 适配器：对上层伪装成标准 WebSocket，实际先申请 client
// 票据、连接 relay，等待 host peer 在线后才触发 onopen；数据帧自动包/解
// relay.data 信封。
import type { WsSocket } from '@/network/ReconnectingWsClient';

export interface RelayTicketEndpoint {
  url: string;
  ticket: string;
}

export type RelayTicketProvider = () => Promise<RelayTicketEndpoint>;

const PEER_WAIT_MS = 20_000;

export class RelaySocket implements WsSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private ticketTimer: ReturnType<typeof setTimeout> | null = null;
  private opened = false;
  private closed = false;
  private closeNotified = false;
  private readonly queue: string[] = [];

  constructor(
    private readonly ticketProvider: RelayTicketProvider,
    private readonly peerWaitMs = PEER_WAIT_MS
  ) {
    void this.connect();
  }

  send(data: string): void {
    if (!this.opened) {
      this.queue.push(data);
      return;
    }
    this.sendRelayPayload(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.ws?.close();
    this.ws = null;
    this.notifyClose();
  }

  private async connect(): Promise<void> {
    try {
      const endpoint = await this.ticketProvider();
      if (this.closed) return;
      const separator = endpoint.url.includes('?') ? '&' : '?';
      const url = `${endpoint.url}${separator}ticket=${encodeURIComponent(
        endpoint.ticket
      )}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => this.handleNativeOpen();
      ws.onmessage = (event) => this.handleNativeMessage(event.data);
      ws.onerror = () => this.fail();
      ws.onclose = () => this.handleNativeClose();
      this.ticketTimer = setTimeout(() => {
        if (!this.opened) this.fail();
      }, this.peerWaitMs);
    } catch {
      this.fail();
    }
  }

  private handleNativeOpen(): void {
    // relay 连接已建立；等待 relay.peer online 后再向业务层宣告 open，
    // 避免 App 在 host 尚未接通时发送订阅帧。
  }

  private handleNativeMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object') return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof message['type'] === 'string' ? message['type'] : '';
    switch (type) {
      case 'relay.ready':
        return;
      case 'relay.peer': {
        const online = message['state'] === 'online';
        if (online) {
          this.markOpened();
        } else if (this.opened) {
          this.fail();
        }
        return;
      }
      case 'relay.data': {
        if (!this.opened) return;
        const payload = message['payload'];
        this.onmessage?.({ data: JSON.stringify(payload ?? null) });
        return;
      }
      case 'relay.ping': {
        const ts = typeof message['ts'] === 'number' ? message['ts'] : 0;
        this.sendRaw({ type: 'relay.pong', ts });
        return;
      }
      case 'relay.pong':
        return;
      case 'relay.error': {
        const code = typeof message['code'] === 'string' ? message['code'] : '';
        if (code === 'replaced' || code === 'peer.offline') {
          this.fail();
        } else {
          console.warn(`[relay] ${code}`);
        }
        return;
      }
      default:
        return;
    }
  }

  private markOpened(): void {
    if (this.opened || this.closed) return;
    this.opened = true;
    this.clearTimer();
    this.onopen?.();
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (frame !== undefined) this.sendRelayPayload(frame);
    }
  }

  private sendRelayPayload(raw: string): void {
    const native = this.ws;
    if (!native || native.readyState !== 1) {
      this.queue.push(raw);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    this.sendRaw({ type: 'relay.data', payload });
  }

  private sendRaw(value: unknown): void {
    const native = this.ws;
    if (!native || native.readyState !== 1) return;
    native.send(JSON.stringify(value));
  }

  private handleNativeClose(): void {
    this.clearTimer();
    this.ws = null;
    this.notifyClose();
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    this.onerror?.();
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.opened = false;
    this.onclose?.();
  }

  private clearTimer(): void {
    if (this.ticketTimer !== null) {
      clearTimeout(this.ticketTimer);
      this.ticketTimer = null;
    }
  }
}
