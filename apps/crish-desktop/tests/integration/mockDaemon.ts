/**
 * MockDaemon - 用于测试前端与 Daemon IPC 的连接、断开与事件流并发竞争
 */
export class MockDaemon {
  private connected = true;
  private listeners = new Map<string, Array<(payload: any) => void>>();
  private latency = 0;

  constructor(opts?: { latency?: number }) {
    this.latency = opts?.latency ?? 0;
  }

  on(event: string, handler: (payload: any) => void) {
    const list = this.listeners.get(event) || [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  async send(channel: string, payload: any): Promise<void> {
    if (!this.connected) {
      throw new Error('Connection lost');
    }
    if (this.latency > 0) {
      await new Promise((r) => setTimeout(r, this.latency));
    }
    const handlers = this.listeners.get(channel) || [];
    for (const h of handlers) {
      h(payload);
    }
  }

  simulateDisconnect() {
    this.connected = false;
  }

  simulateReconnect() {
    this.connected = true;
  }

  async *streamEvents(
    channel: string,
    count: number,
    delayMs = 1
  ): AsyncGenerator<{ seq: number; channel: string }> {
    for (let i = 0; i < count; i++) {
      if (!this.connected) {
        throw new Error('Stream disconnected');
      }
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      yield { seq: i, channel };
    }
  }
}
