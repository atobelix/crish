import type { SecretValue } from "./types";

export type CredentialStatus = "ok" | "exhausted" | "dead";
export type CredentialAuthType = "api-key" | "bearer" | "basic" | "oauth" | "custom";
export type PoolSelectionStrategy = "round-robin" | "random" | "least-used";

export interface PooledCredential {
  provider: string;
  id: string;
  authType: CredentialAuthType;
  accessToken: SecretValue;
  refreshToken?: SecretValue;
  status: CredentialStatus;
  lastError?: string;
  lastErrorAt?: number;
  expiresAt?: number;
  usageCount: number;
  cooldownUntil: number;
}

export interface CredentialPoolOptions {
  strategy?: PoolSelectionStrategy;
  cooldownMs?: number;
  exhaustedCooldownMs?: number;
  deadCooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_EXHAUSTED_COOLDOWN_MS = 300_000;
const DEFAULT_DEAD_COOLDOWN_MS = 3_600_000;

export class CredentialPool {
  private credentials: PooledCredential[] = [];
  private strategy: PoolSelectionStrategy;
  private cooldownMs: number;
  private exhaustedCooldownMs: number;
  private deadCooldownMs: number;
  private rrIndex = 0;

  constructor(options: CredentialPoolOptions = {}) {
    this.strategy = options.strategy ?? "round-robin";
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.exhaustedCooldownMs = options.exhaustedCooldownMs ?? DEFAULT_EXHAUSTED_COOLDOWN_MS;
    this.deadCooldownMs = options.deadCooldownMs ?? DEFAULT_DEAD_COOLDOWN_MS;
  }

  register(cred: Omit<PooledCredential, "usageCount" | "cooldownUntil">): void {
    const existing = this.credentials.find(
      (c) => c.provider === cred.provider && c.id === cred.id
    );
    if (existing) {
      existing.accessToken = cred.accessToken;
      if (cred.refreshToken !== undefined) existing.refreshToken = cred.refreshToken;
      existing.authType = cred.authType;
      existing.status = cred.status;
      if (cred.expiresAt !== undefined) existing.expiresAt = cred.expiresAt;
      return;
    }
    this.credentials.push({
      ...cred,
      usageCount: 0,
      cooldownUntil: 0,
    });
  }

  unregister(provider: string, id: string): void {
    this.credentials = this.credentials.filter(
      (c) => !(c.provider === provider && c.id === id)
    );
  }

  select(): PooledCredential | null {
    const now = Date.now();
    const eligible = this.credentials.filter((c) => c.cooldownUntil <= now && c.status !== "dead");

    if (eligible.length === 0) return null;

    switch (this.strategy) {
      case "round-robin": {
        const idx = this.rrIndex % eligible.length;
        this.rrIndex++;
        return eligible[idx] ?? null;
      }
      case "random": {
        const idx = Math.floor(Math.random() * eligible.length);
        return eligible[idx] ?? null;
      }
      case "least-used": {
        return eligible.sort((a, b) => a.usageCount - b.usageCount)[0] ?? null;
      }
    }
  }

  get(provider: string, id: string): PooledCredential | undefined {
    return this.credentials.find((c) => c.provider === provider && c.id === id);
  }

  recordSuccess(provider: string, id: string): void {
    const cred = this.get(provider, id);
    if (!cred) return;
    cred.usageCount++;
    cred.status = "ok";
    delete cred.lastError;
    delete cred.lastErrorAt;
    cred.cooldownUntil = 0;
  }

  recordFailure(provider: string, id: string, error?: string): void {
    const cred = this.get(provider, id);
    if (!cred) return;
    cred.usageCount++;
    cred.lastError = error ?? "unknown_error";
    cred.lastErrorAt = Date.now();

    if (cred.status === "dead") return;

    const cooldownForStatus =
      cred.status === "exhausted" ? this.exhaustedCooldownMs : this.cooldownMs;

    cred.cooldownUntil = Date.now() + cooldownForStatus;

    if (cred.status === "ok") {
      cred.status = "exhausted";
    }
  }

  markDead(provider: string, id: string, reason?: string): void {
    const cred = this.get(provider, id);
    if (!cred) return;
    cred.status = "dead";
    cred.lastError = reason ?? "marked_dead";
    cred.lastErrorAt = Date.now();
    cred.cooldownUntil = Date.now() + this.deadCooldownMs;
  }

  revive(provider: string, id: string): void {
    const cred = this.get(provider, id);
    if (!cred) return;
    cred.status = "ok";
    delete cred.lastError;
    delete cred.lastErrorAt;
    cred.cooldownUntil = 0;
  }

  refreshToken(provider: string, id: string, newToken: SecretValue, expiresInMs?: number): void {
    const cred = this.get(provider, id);
    if (!cred) return;
    cred.accessToken = newToken;
    if (expiresInMs !== undefined) {
      cred.expiresAt = Date.now() + expiresInMs;
    }
    cred.status = "ok";
    cred.cooldownUntil = 0;
  }

  getAvailableCount(): number {
    const now = Date.now();
    return this.credentials.filter(
      (c) => c.cooldownUntil <= now && c.status !== "dead"
    ).length;
  }

  getStats(): CredentialPoolStats {
    const total = this.credentials.length;
    const ok = this.credentials.filter((c) => c.status === "ok").length;
    const exhausted = this.credentials.filter((c) => c.status === "exhausted").length;
    const dead = this.credentials.filter((c) => c.status === "dead").length;
    const avgUsage =
      total > 0
        ? this.credentials.reduce((sum, c) => sum + c.usageCount, 0) / total
        : 0;

    return { total, ok, exhausted, dead, avgUsageCount: avgUsage };
  }

  list(): PooledCredential[] {
    return [...this.credentials];
  }

  clear(): void {
    this.credentials = [];
    this.rrIndex = 0;
  }
}

export interface CredentialPoolStats {
  total: number;
  ok: number;
  exhausted: number;
  dead: number;
  avgUsageCount: number;
}
