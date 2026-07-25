import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { ChatGPTAccountPool, type ChatGPTAccount } from "../../provider/auth/oauth/chatgpt-pool";

function makeAccount(overrides: Partial<ChatGPTAccount> = {}): ChatGPTAccount {
  const now = Date.now();
  return {
    id: overrides.id ?? "acc_default",
    label: overrides.label ?? "Default",
    accessToken: "at_default",
    expiresAt: now + 3600_000,
    status: "active",
    lastUsedAt: 0,
    usageScore: 0,
    errorCount: 0,
    poolWeight: 1,
    ...overrides,
  };
}

describe("ChatGPTAccountPool - add / remove", () => {
  let pool: ChatGPTAccountPool;

  beforeEach(() => {
    pool = new ChatGPTAccountPool("https://app.example.com/callback");
  });

  it("adds accounts and lists them", () => {
    pool.addAccount(makeAccount({ id: "a1", label: "Account 1" }));
    pool.addAccount(makeAccount({ id: "a2", label: "Account 2" }));
    expect(pool.listAccounts()).toHaveLength(2);
    expect(pool.getAccount("a1")?.label).toBe("Account 1");
  });

  it("removes accounts by id", () => {
    pool.addAccount(makeAccount({ id: "a1" }));
    pool.addAccount(makeAccount({ id: "a2" }));
    pool.removeAccount("a1");
    expect(pool.listAccounts()).toHaveLength(1);
    expect(pool.getAccount("a1")).toBeUndefined();
  });

  it("returns undefined for unknown account", () => {
    expect(pool.getAccount("nonexistent")).toBeUndefined();
  });

  it("removeAccount on empty pool does not throw", () => {
    expect(() => pool.removeAccount("ghost")).not.toThrow();
  });
});

describe("ChatGPTAccountPool - selection strategy: lowest-usage", () => {
  let pool: ChatGPTAccountPool;

  beforeEach(() => {
    pool = new ChatGPTAccountPool("https://app.example.com/callback");
    pool.addAccount(makeAccount({ id: "a1", usageScore: 50 }));
    pool.addAccount(makeAccount({ id: "a2", usageScore: 10 }));
    pool.addAccount(makeAccount({ id: "a3", usageScore: 80 }));
  });

  it("selects the account with the lowest usage score", () => {
    const selected = pool.selectAccount();
    expect(selected?.id).toBe("a2");
  });

  it("returns null when no eligible accounts", () => {
    const emptyPool = new ChatGPTAccountPool("https://app.example.com/callback");
    expect(emptyPool.selectAccount()).toBeNull();
  });

  it("skips accounts in cooldown", () => {
    pool.addAccount(makeAccount({ id: "cooling_acc", usageScore: 0, status: "cooling" }));
    const selected = pool.selectAccount();
    expect(selected?.id).not.toBe("cooling_acc");
    expect(selected?.id).toBe("a2");
  });

  it("skips accounts with future cooldownUntil", () => {
    pool.addAccount(
      makeAccount({ id: "cooldown_acc", usageScore: 0, cooldownUntil: Date.now() + 999_999 }),
    );
    const selected = pool.selectAccount();
    expect(selected?.id).not.toBe("cooldown_acc");
    expect(selected?.id).toBe("a2");
  });

  it("includes accounts whose cooldown has expired", () => {
    pool.addAccount(
      makeAccount({ id: "expired_cooldown", usageScore: 2, cooldownUntil: Date.now() - 1000 }),
    );
    const selected = pool.selectAccount();
    expect(selected?.id).toBe("expired_cooldown");
  });

  it("recordUsage increases usageScore", () => {
    pool.recordUsage("a1");
    expect(pool.getAccount("a1")!.usageScore).toBe(55);
  });

  it("recordUsage caps at 100", () => {
    pool.addAccount(makeAccount({ id: "maxed", usageScore: 99 }));
    pool.recordUsage("maxed");
    expect(pool.getAccount("maxed")!.usageScore).toBe(100);
    pool.recordUsage("maxed");
    expect(pool.getAccount("maxed")!.usageScore).toBe(100);
  });
});

describe("ChatGPTAccountPool - failure recording and cooldown", () => {
  let pool: ChatGPTAccountPool;

  beforeEach(() => {
    pool = new ChatGPTAccountPool("https://app.example.com/callback");
  });

  it("applies cooldown on auth failure", () => {
    pool.addAccount(makeAccount({ id: "a1" }));
    pool.recordFailure("a1", "auth");
    const account = pool.getAccount("a1")!;
    expect(account.errorCount).toBe(1);
    expect(account.cooldownUntil).toBeGreaterThan(Date.now());
    expect(account.cooldownUntil).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 100);
  });

  it("applies cooldown on quota failure (1 hour)", () => {
    pool.addAccount(makeAccount({ id: "a1" }));
    pool.recordFailure("a1", "quota");
    const cooldown = pool.getAccount("a1")!.cooldownUntil!;
    expect(cooldown - Date.now()).toBeGreaterThan(59 * 60 * 1000);
  });

  it("applies short cooldown on timeout", () => {
    pool.addAccount(makeAccount({ id: "a1" }));
    pool.recordFailure("a1", "timeout");
    const cooldown = pool.getAccount("a1")!.cooldownUntil!;
    expect(cooldown - Date.now()).toBeLessThanOrEqual(60 * 1000);
  });

  it("marks account as error after 3 auth failures", () => {
    pool.addAccount(makeAccount({ id: "a1" }));
    pool.recordFailure("a1", "auth");
    pool.recordFailure("a1", "auth");
    expect(pool.getAccount("a1")!.status).toBe("active");
    pool.recordFailure("a1", "auth");
    expect(pool.getAccount("a1")!.status).toBe("error");
  });

  it("does not throw on failure for unknown account", () => {
    expect(() => pool.recordFailure("ghost", "server")).not.toThrow();
  });
});

describe("ChatGPTAccountPool - getAvailableCount and getPoolStats", () => {
  let pool: ChatGPTAccountPool;

  beforeEach(() => {
    pool = new ChatGPTAccountPool("https://app.example.com/callback");
  });

  it("getAvailableCount returns zero for empty pool", () => {
    expect(pool.getAvailableCount()).toBe(0);
  });

  it("getAvailableCount counts only active non-cooldown accounts", () => {
    pool.addAccount(makeAccount({ id: "a1", usageScore: 10 }));
    pool.addAccount(makeAccount({ id: "a2", usageScore: 20, status: "error" }));
    pool.addAccount(makeAccount({ id: "a3", usageScore: 30, cooldownUntil: Date.now() + 999_999 }));
    pool.addAccount(makeAccount({ id: "a4", usageScore: 40, status: "cooling" }));
    expect(pool.getAvailableCount()).toBe(1);
  });

  it("getPoolStats returns correct totals and averages", () => {
    pool.addAccount(makeAccount({ id: "a1", usageScore: 10, status: "active" }));
    pool.addAccount(makeAccount({ id: "a2", usageScore: 20, status: "active" }));
    pool.addAccount(makeAccount({ id: "a3", usageScore: 0, status: "error" }));
    pool.addAccount(makeAccount({ id: "a4", usageScore: 50, status: "cooling" }));

    const stats = pool.getPoolStats();
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(2);
    expect(stats.error).toBe(1);
    expect(stats.cooling).toBe(1);
    expect(stats.avgUsageScore).toBe(20);
  });

  it("getPoolStats handles empty pool gracefully", () => {
    const stats = pool.getPoolStats();
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.avgUsageScore).toBe(0);
  });
});

describe("ChatGPTAccountPool - refreshAccount", () => {
  let pool: ChatGPTAccountPool;

  beforeEach(() => {
    pool = new ChatGPTAccountPool("https://app.example.com/callback");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when account has no refreshToken", async () => {
    pool.addAccount(makeAccount({ id: "a1", refreshToken: undefined }));
    expect(await pool.refreshAccount("a1")).toBe(false);
  });

  it("returns false for unknown account", async () => {
    expect(await pool.refreshAccount("ghost")).toBe(false);
  });
});
