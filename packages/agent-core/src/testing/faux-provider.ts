import type { HealthCheckResult, ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from '../core/runtime-options';

export class FauxAgentProvider implements AgentProvider {
  readonly id: string;
  private events: ProviderStreamEvent[] = [];
  private error: Error | null = null;
  private latencyMs = 0;
  private failAfter: number | undefined;

  constructor(id: string) {
    this.id = id;
  }

  setEvents(events: ProviderStreamEvent[]): void {
    this.events = events;
  }

  setError(error: Error): void {
    this.error = error;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  setFailAfter(n: number): void {
    this.failAfter = n;
  }

  async init(): Promise<void> {
    // no-op for testing
  }

  async dispose(): Promise<void> {
    // no-op for testing
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, status: "healthy", lastCheckedAt: Date.now() };
  }

  reset(): void {
    this.events = [];
    this.error = null;
    this.latencyMs = 0;
    this.failAfter = undefined;
  }

  async *stream(
    _request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    if (this.error) throw this.error;
    if (this.latencyMs > 0) await sleep(this.latencyMs);

    const limit =
      this.failAfter !== undefined
        ? Math.min(this.failAfter, this.events.length)
        : this.events.length;

    for (let i = 0; i < limit; i++) {
      const event = this.events[i]!;
      yield event;

      if (event.type === "stop" && event.reason === "error") {
        break;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
