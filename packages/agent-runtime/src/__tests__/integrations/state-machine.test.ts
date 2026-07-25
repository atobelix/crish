import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  OAuthStateMachine,
  OAuthStateError,
  OAuthDeadlockError,
} from "../../provider/auth/oauth/state-machine";

describe("OAuthStateMachine - normal lifecycle", () => {
  let machine: OAuthStateMachine;
  let refreshFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    refreshFn = vi.fn();
    machine = new OAuthStateMachine({ refreshTokenFn: refreshFn });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in no-token state", () => {
    expect(machine.getState()).toBe("no-token");
  });

  it("no-token -> has-token via setToken", () => {
    machine.setToken(3600);
    expect(machine.getState()).toBe("has-token");
    expect(machine.getExpiresAt()).toBeGreaterThan(Date.now());
  });

  it("has-token -> token-expired -> refreshing -> has-token via ensureToken", async () => {
    machine.setToken(1);
    vi.advanceTimersByTime(7000);

    refreshFn.mockResolvedValue(7200);
    await machine.ensureToken();

    expect(machine.getState()).toBe("has-token");
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("has-token stays has-token when token is fresh", async () => {
    machine.setToken(3600);
    await machine.ensureToken();
    expect(machine.getState()).toBe("has-token");
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("no-token throws OAuthStateError on ensureToken", async () => {
    await expect(machine.ensureToken()).rejects.toThrow(OAuthStateError);
    await expect(machine.ensureToken()).rejects.toThrow("No token available");
  });

  it("clearToken resets to no-token from error state", () => {
    machine.handleError(new Error("FATAL_ERR"));
    expect(machine.getState()).toBe("error");
    machine.clearToken();
    expect(machine.getState()).toBe("no-token");
    expect(machine.getExpiresAt()).toBe(0);
  });

  it("reset restores initial state", () => {
    machine.setToken(3600);
    machine.reset();
    expect(machine.getState()).toBe("no-token");
    expect(machine.getExpiresAt()).toBe(0);
    expect(machine.getRetryCount()).toBe(0);
  });
});

describe("OAuthStateMachine - 401 error handling -> need-reauth", () => {
  let machine: OAuthStateMachine;

  beforeEach(() => {
    machine = new OAuthStateMachine();
  });

  it("401 from has-token transitions to token-expired", async () => {
    machine.setToken(3600);
    const handled = await machine.handleError(new Error("unauthorized"));
    expect(handled).toBe(true);
    expect(machine.getState()).toBe("token-expired");
  });

  it("auth error from token-expired stays token-expired", async () => {
    machine.setToken(1);
    const result = await machine.handleError(new Error("401 Unauthorized"));
    expect(result).toBe(true);
    expect(machine.getState()).toBe("token-expired");
  });

  it("401 from has-token with invalid_token transitions correctly", async () => {
    machine.setToken(3600);
    const handled = await machine.handleError(new Error("invalid_token"));
    expect(handled).toBe(true);
    expect(machine.getState()).toBe("token-expired");
  });

  it("need-reauth triggered via refresh auth failure", async () => {
    const machine = new OAuthStateMachine({
      refreshTokenFn: () => Promise.reject(new Error("401")),
    });
    machine.setToken(0);
    await expect(machine.ensureToken()).rejects.toThrow();
    expect(machine.getState()).toBe("need-reauth");
  });
});

describe("OAuthStateMachine - deadlock detection", () => {
  it("throws OAuthDeadlockError when transitions exceed threshold in window", async () => {
    const machine = new OAuthStateMachine({
      deadlockWindowMs: 60_000,
      maxTransitionsInWindow: 3,
      refreshTokenFn: () => new Promise(() => {}),
    });

    machine.setToken(0);
    machine.ensureToken();
    await expect(machine.ensureToken()).rejects.toThrow(OAuthDeadlockError);
  });

  it("does not throw when transitions are below threshold", async () => {
    const machine = new OAuthStateMachine({
      deadlockWindowMs: 60_000,
      maxTransitionsInWindow: 10,
      refreshTokenFn: () => Promise.resolve(3600),
    });

    machine.setToken(0);
    await machine.ensureToken();
  });

  it("deadlock message contains transition count", async () => {
    const machine = new OAuthStateMachine({
      deadlockWindowMs: 60_000,
      maxTransitionsInWindow: 3,
      refreshTokenFn: () => new Promise(() => {}),
    });

    machine.setToken(0);
    machine.ensureToken();
    await expect(machine.ensureToken()).rejects.toThrow(/Deadlock detected/);
  });
});

describe("OAuthStateMachine - invalid transition", () => {
  it("throws OAuthStateError for invalid transition", () => {
    const machine = new OAuthStateMachine();
    machine.setToken(3600);

    expect(() => machine.clearToken()).toThrow(OAuthStateError);
    expect(() => machine.clearToken()).toThrow("Invalid transition");
  });
});

describe("OAuthStateMachine - retry with backoff", () => {
  it("retries on transient error and succeeds", async () => {
    vi.useFakeTimers();
    const refreshFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(3600);

    const machine = new OAuthStateMachine({
      refreshTokenFn: refreshFn,
      maxRetries: 3,
    });

    machine.setToken(1);
    vi.advanceTimersByTime(7000);

    const promise = machine.ensureToken();
    await vi.runAllTimersAsync();
    await promise;

    expect(refreshFn).toHaveBeenCalledTimes(2);
    expect(machine.getState()).toBe("has-token");
    vi.useRealTimers();
  });

  it("exhausts retries and transitions to need-reauth", async () => {
    vi.useFakeTimers();
    const refreshFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const machine = new OAuthStateMachine({
      refreshTokenFn: refreshFn,
      maxRetries: 1,
    });

    machine.setToken(1);
    vi.advanceTimersByTime(7000);

    await expect(machine.ensureToken()).rejects.toThrow(OAuthStateError);
    expect(machine.getState()).toBe("need-reauth");
    expect(refreshFn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("aborts immediately on auth error during refresh", async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error("invalid_grant"));

    const machine = new OAuthStateMachine({
      refreshTokenFn: refreshFn,
      maxRetries: 5,
    });

    machine.setToken(1);

    await expect(machine.ensureToken()).rejects.toThrow();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(machine.getState()).toBe("need-reauth");
  });
});

describe("OAuthStateMachine - callbacks", () => {
  it("fires onStateChange on every transition", () => {
    const onStateChange = vi.fn();
    const machine = new OAuthStateMachine({ onStateChange });

    machine.setToken(3600);
    expect(onStateChange).toHaveBeenCalledWith("no-token", "has-token", "setToken");
  });

  it("fires onReauthNeeded when entering need-reauth", async () => {
    const onReauthNeeded = vi.fn();
    const machine = new OAuthStateMachine({
      onReauthNeeded,
      refreshTokenFn: () => Promise.reject(new Error("401")),
    });

    machine.setToken(0);
    await expect(machine.ensureToken()).rejects.toThrow();
    expect(onReauthNeeded).toHaveBeenCalled();
  });

  it("fires onError on fatal error", () => {
    const onError = vi.fn();
    const machine = new OAuthStateMachine({ onError });

    machine.handleError(new Error("FATAL_ERROR"));
    expect(onError).toHaveBeenCalled();
  });
});
