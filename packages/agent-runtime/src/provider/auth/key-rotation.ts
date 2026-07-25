import type { SecretValue } from "./types";
import { parseRetryAfterMs } from "../../openai-retry";

export const MAX_COOLDOWN_MS = 600_000;

export type RotationStrategy = "round-robin" | "least-used";

export interface KeyEntry {
  id: string;
  key: SecretValue;
  cooldownUntil: number;
  usageCount: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface KeyRotationManagerOptions {
  strategy?: RotationStrategy;
  maxCooldownMs?: number;
}

export class KeyRotationManager {
  private keys: KeyEntry[] = [];
  private strategy: RotationStrategy;
  private maxCooldownMs: number;
  private rrIndex = 0;

  constructor(options: KeyRotationManagerOptions = {}) {
    this.strategy = options.strategy ?? "round-robin";
    this.maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
  }

  addKey(id: string, key: SecretValue): void {
    const existing = this.keys.find((k) => k.id === id);
    if (existing) {
      existing.key = key;
      return;
    }
    this.keys.push({ id, key, cooldownUntil: 0, usageCount: 0 });
  }

  removeKey(id: string): void {
    this.keys = this.keys.filter((k) => k.id !== id);
  }

  getKey(id: string): KeyEntry | undefined {
    return this.keys.find((k) => k.id === id);
  }

  selectKey(): KeyEntry | null {
    const now = Date.now();
    const available = this.keys.filter((k) => k.cooldownUntil <= now);

    if (available.length === 0) return null;

    switch (this.strategy) {
      case "round-robin": {
        const idx = this.rrIndex % available.length;
        this.rrIndex++;
        return available[idx] ?? null;
      }
      case "least-used": {
        return available.sort((a, b) => a.usageCount - b.usageCount)[0] ?? null;
      }
    }
  }

  recordSuccess(keyId: string): void {
    const entry = this.keys.find((k) => k.id === keyId);
    if (entry) {
      entry.usageCount++;
      entry.cooldownUntil = 0;
      delete entry.lastError;
      delete entry.lastErrorAt;
    }
  }

  recordFailure(keyId: string, retryAfterValue?: string | null): void {
    const entry = this.keys.find((k) => k.id === keyId);
    if (!entry) return;

    entry.usageCount++;
    entry.lastError = `429: rate-limited`;
    entry.lastErrorAt = Date.now();

    const parsed = parseRetryAfterMs(retryAfterValue ?? null);
    const cooldown = parsed !== undefined ? parsed : 60_000;
    entry.cooldownUntil = Date.now() + Math.min(cooldown, this.maxCooldownMs);
  }

  setCooldown(keyId: string, durationMs: number): void {
    const entry = this.keys.find((k) => k.id === keyId);
    if (entry) {
      entry.cooldownUntil = Date.now() + Math.min(durationMs, this.maxCooldownMs);
    }
  }

  getAvailableCount(): number {
    const now = Date.now();
    return this.keys.filter((k) => k.cooldownUntil <= now).length;
  }

  listKeys(): KeyEntry[] {
    return [...this.keys];
  }

  reset(): void {
    this.keys = [];
    this.rrIndex = 0;
  }
}
