import type { AgentProvider } from "../types";

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
  lastChecked: number;
  latencyMs?: number;
  consecutiveFailures?: number;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface HealthStatusChangeEvent {
  providerId: string;
  previousStatus: HealthStatus;
  currentStatus: HealthStatus;
  result: HealthCheckResult;
  timestamp: number;
}

export interface HealthCheckerOptions {
  intervalMs?: number;
  failureThreshold?: number;
  onStatusChange?: (event: HealthStatusChangeEvent) => void;
}

type HealthListener = (event: HealthStatusChangeEvent) => void;

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

export class HealthChecker {
  private providers = new Map<string, ProviderHealthEntry>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private failureThreshold: number;
  private listeners = new Set<HealthListener>();

  constructor(options: HealthCheckerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    if (options.onStatusChange) {
      this.listeners.add(options.onStatusChange);
    }
  }

  register(providerId: string, provider: AgentProvider): void {
    this.providers.set(providerId, {
      provider,
      status: "unknown",
      lastResult: null,
      consecutiveFailures: 0,
    });
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  getStatus(providerId: string): HealthStatus | undefined {
    return this.providers.get(providerId)?.status;
  }

  getAllStatuses(): Array<{ providerId: string; status: HealthStatus; lastResult: HealthCheckResult | null }> {
    return [...this.providers.entries()].map(([providerId, entry]) => ({
      providerId,
      status: entry.status,
      lastResult: entry.lastResult,
    }));
  }

  onStatusChange(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get registeredCount(): number {
    return this.providers.size;
  }

  start(): void {
    if (this.timerId !== null) return;
    this.timerId = setInterval(() => this.checkAll(), this.intervalMs);
    this.timerId.unref?.();
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  async checkNow(providerId: string): Promise<HealthCheckResult | null> {
    const entry = this.providers.get(providerId);
    if (!entry) return null;
    return this.checkSingle(providerId, entry);
  }

  async checkAll(): Promise<void> {
    for (const [providerId, entry] of this.providers) {
      await this.checkSingle(providerId, entry);
    }
  }

  private async checkSingle(
    providerId: string,
    entry: ProviderHealthEntry,
  ): Promise<HealthCheckResult> {
    const previousStatus = entry.status;

    let result: HealthCheckResult;
    try {
      if (typeof (entry.provider as any).healthCheck === "function") {
        const healthResult = await (entry.provider as any).healthCheck();
        result = {
          healthy: healthResult.healthy !== false,
          message: healthResult.message,
          lastChecked: healthResult.lastChecked ?? Date.now(),
          latencyMs: healthResult.latencyMs,
        };
      } else {
        result = {
          healthy: true,
          lastChecked: Date.now(),
        };
      }
    } catch (err) {
      result = {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        lastChecked: Date.now(),
      };
    }

    if (result.healthy) {
      entry.consecutiveFailures = 0;
    } else {
      entry.consecutiveFailures++;
    }

    result.consecutiveFailures = entry.consecutiveFailures;

    if (!result.healthy && entry.consecutiveFailures >= this.failureThreshold) {
      entry.status = "unhealthy";
    } else if (!result.healthy) {
      entry.status = "degraded";
    } else if (entry.status === "unhealthy" || entry.status === "degraded") {
      entry.status = "healthy";
    } else {
      entry.status = "healthy";
    }

    entry.lastResult = result;

    if (previousStatus !== entry.status) {
      const event: HealthStatusChangeEvent = {
        providerId,
        previousStatus,
        currentStatus: entry.status,
        result,
        timestamp: Date.now(),
      };
      this.emitStatusChange(event);
    }

    return result;
  }

  private emitStatusChange(event: HealthStatusChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }

  dispose(): void {
    this.stop();
    this.providers.clear();
    this.listeners.clear();
  }
}

interface ProviderHealthEntry {
  provider: AgentProvider;
  status: HealthStatus;
  lastResult: HealthCheckResult | null;
  consecutiveFailures: number;
}
