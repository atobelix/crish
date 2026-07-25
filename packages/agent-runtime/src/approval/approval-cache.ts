import type { PermissionDecision } from "@crish/shared-types";

export interface ApprovalCacheOptions {
  defaultTtlMs?: number;
}

interface CacheEntry {
  decision: PermissionDecision;
  expiresAt: number;
}

export class ApprovalCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ApprovalCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 30_000;
  }

  get(intentKey: string, sessionId?: string): PermissionDecision | undefined {
    this.evictExpired();
    const cacheKey = sessionId ? `${sessionId}:${intentKey}` : intentKey;
    const entry = this.store.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(cacheKey);
      return undefined;
    }
    return entry.decision;
  }

  set(intentKey: string, decision: PermissionDecision, ttlMs?: number, sessionId?: string): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const cacheKey = sessionId ? `${sessionId}:${intentKey}` : intentKey;
    this.store.set(cacheKey, {
      decision,
      expiresAt: Date.now() + ttl,
    });
  }

  has(intentKey: string): boolean {
    return this.get(intentKey) !== undefined;
  }

  delete(intentKey: string): boolean {
    return this.store.delete(intentKey);
  }

  clear(): void {
    this.store.clear();
  }

  getSize(): number {
    this.evictExpired();
    return this.store.size;
  }

  startAutoCleanup(intervalMs: number = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.evictExpired(), intervalMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  stopAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
