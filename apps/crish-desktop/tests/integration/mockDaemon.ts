export class MockDaemon {
  private handlers: Map<string, (payload: any) => void> = new Map();
  private latency = 0;
  private shouldDisconnectNext = false;

  constructor(options?: { latency?: number }) {
    this.latency = options?.latency ?? 0;
  }

  on(event: string, handler: (payload: any) => void): void {
    this.handlers.set(event, handler);
  }

  async send(event: string, payload: any): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for event: ${event}`);
    if (this.shouldDisconnectNext) throw new Error('Connection lost');
    await new Promise(r => setTimeout(r, this.latency));
    handler(payload);
  }

  simulateDisconnect(): void {
    this.shouldDisconnectNext = true;
  }

  simulateReconnect(): void {
    this.shouldDisconnectNext = false;
  }

  async *streamEvents(event: string, count: number, intervalMs: number = 5): AsyncGenerator<any> {
    for (let i = 0; i < count; i++) {
      if (this.shouldDisconnectNext) throw new Error('Stream interrupted');
      await new Promise(r => setTimeout(r, intervalMs));
      yield { seq: i, event, timestamp: Date.now() };
    }
  }
}
