import type { AgentProviderRequest } from "../types";
import type {
  ProviderStreamContractEvent,
} from "../provider-stream-contract";

export interface FauxProviderOptions {
  id?: string;
  events?: ProviderStreamContractEvent[];
  error?: Error | null;
  latencyMs?: number;
  failAfter?: number;
}

export interface FauxHealthCheckResult {
  healthy: boolean;
  message?: string;
  lastChecked: number;
  latencyMs?: number;
}

export class FauxProvider {
  readonly id: string;
  private events: ProviderStreamContractEvent[] = [];
  private error: Error | null = null;
  private latencyMs = 0;
  private failAfter: number | undefined;
  private _initialized = false;
  private _disposed = false;
  private healthStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
  private healthCheckCountValue = 0;

  constructor(idOrOptions: string | FauxProviderOptions = "faux") {
    if (typeof idOrOptions === "string") {
      this.id = idOrOptions;
    } else {
      this.id = idOrOptions.id ?? "faux";
      if (idOrOptions.events) this.events = [...idOrOptions.events];
      this.error = idOrOptions.error ?? null;
      this.latencyMs = idOrOptions.latencyMs ?? 0;
      this.failAfter = idOrOptions.failAfter;
    }
  }

  setEvents(events: ProviderStreamContractEvent[]): void {
    this.events = events;
  }

  addEvent(event: ProviderStreamContractEvent): void {
    this.events.push(event);
  }

  setError(error: Error | null): void {
    this.error = error;
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  setFailAfter(n: number | undefined): void {
    this.failAfter = n;
  }

  setHealthStatus(status: "healthy" | "degraded" | "unhealthy"): void {
    this.healthStatus = status;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get healthCheckCount(): number {
    return this.healthCheckCountValue;
  }

  reset(): void {
    this.events = [];
    this.error = null;
    this.latencyMs = 0;
    this.failAfter = undefined;
    this._initialized = false;
    this._disposed = false;
    this.healthStatus = "healthy";
    this.healthCheckCountValue = 0;
  }

  async init(): Promise<void> {
    if (this._disposed) throw new Error("FauxProvider is disposed");
    this._initialized = true;
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    this._initialized = false;
  }

  async healthCheck(): Promise<FauxHealthCheckResult> {
    this.healthCheckCountValue++;
    const result: FauxHealthCheckResult = {
      healthy: false,
      lastChecked: Date.now(),
    };
    if (this._disposed) {
      result.message = "Provider is disposed";
      return result;
    }
    if (this.error) {
      result.message = this.error.message;
      return result;
    }
    if (this.latencyMs > 0) {
      result.latencyMs = this.latencyMs;
    }
    result.healthy = this.healthStatus === "healthy";
    if (this.healthStatus !== "healthy") {
      result.message = `Health status: ${this.healthStatus}`;
    }
    return result;
  }

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamContractEvent> {
    if (this._disposed) throw new Error("FauxProvider is disposed");
    if (request.signal.aborted) return;
    if (this.error) throw this.error;
    if (this.latencyMs > 0) await this.sleep(this.latencyMs);

    const limit =
      this.failAfter !== undefined
        ? Math.min(this.failAfter, this.events.length)
        : this.events.length;

    for (let i = 0; i < limit; i++) {
      if (request.signal.aborted) return;
      const event = this.events[i]!;
      yield event;
      if (
        event.type === "error" ||
        (event.type === "end" && event.finishReason === "error")
      ) {
        break;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
