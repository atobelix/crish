import { describe, expect, it, beforeEach } from "vitest";
import { StreamRecoveryManager, ToolIdempotencyGuard } from "./stream-recovery";
import type { ProviderStreamContractEvent } from "@crish/agent-model";

function textEvent(sequence: number, text: string): ProviderStreamContractEvent {
  return {
    type: "delta",
    sequence,
    delta: { type: "text", text },
  } as ProviderStreamContractEvent;
}

function toolCallEvent(sequence: number, id: string): ProviderStreamContractEvent {
  return {
    type: "tool-call",
    sequence,
    phase: "end",
    toolCall: { id, toolName: "test_tool", argumentsText: "{}", input: {} },
  } as unknown as ProviderStreamContractEvent;
}

describe("StreamRecoveryManager", () => {
  let manager: StreamRecoveryManager;

  beforeEach(() => {
    manager = new StreamRecoveryManager();
  });

  describe("getCursor / updateCursor", () => {
    it("starts with an empty cursor", () => {
      const cursor = manager.getCursor();
      expect(cursor.lastConfirmedSequence).toBe(0);
      expect(cursor.emittedToolCallIds).toEqual([]);
      expect(cursor.receivedBytes).toBe(0);
      expect(cursor.receivedFrames).toBe(0);
    });

    it("updateCursor advances lastConfirmedSequence", () => {
      manager.updateCursor(textEvent(5, "hello"));
      expect(manager.getCursor().lastConfirmedSequence).toBe(5);
    });

    it("updateCursor tracks tool-call ids", () => {
      manager.updateCursor(toolCallEvent(1, "call_abc"));
      const cursor = manager.getCursor();
      expect(cursor.emittedToolCallIds).toContain("call_abc");
    });

    it("updateCursor does not duplicate tool-call ids", () => {
      manager.updateCursor(toolCallEvent(1, "call_abc"));
      manager.updateCursor(toolCallEvent(2, "call_abc"));
      expect(manager.getCursor().emittedToolCallIds).toEqual(["call_abc"]);
    });

    it("getCursor returns a copy, not the internal reference", () => {
      const cursor = manager.getCursor();
      cursor.lastConfirmedSequence = 999;
      expect(manager.getCursor().lastConfirmedSequence).toBe(0);
    });
  });

  describe("decideRetry", () => {
    it("aborts when retry count exceeds maxRetries", () => {
      manager = new StreamRecoveryManager({ maxRetries: 2 });
      manager.decideRetry({ message: "err" });
      manager.decideRetry({ message: "err" });
      const decision = manager.decideRetry({ message: "err" });
      expect(decision.action).toBe("abort");
      expect(decision.reason).toContain("Max retries exceeded");
    });

    it("returns retry for HTTP 429 with Retry-After", () => {
      const decision = manager.decideRetry({ status: 429, message: "rate limited" }, { "retry-after": "5" });
      expect(decision.action).toBe("retry");
      expect(decision.reason).toBe("rate-limit");
      expect(decision.delay).toBeGreaterThan(0);
    });

    it("returns retry for HTTP 429 without Retry-After using backoff", () => {
      const decision = manager.decideRetry({ status: 429, message: "rate limited" });
      expect(decision.action).toBe("retry");
      expect(decision.reason).toBe("rate-limit");
      expect(decision.delay).toBeGreaterThan(0);
    });

    it("returns retry for HTTP 5xx errors", () => {
      const decision = manager.decideRetry({ status: 503, message: "service unavailable" });
      expect(decision.action).toBe("retry");
      expect(decision.reason).toBe("server-error");
    });

    it("returns retry for network errors", () => {
      const decision = manager.decideRetry({ message: "ECONNRESET" });
      expect(decision.action).toBe("retry");
      expect(decision.reason).toBe("network");
    });

    it("includes range hint for network retry when bytes > 0", () => {
      const m = new StreamRecoveryManager({ enableRangeRecovery: true });
      m.updateCursor(textEvent(1, "hello"));
      const cursor = m.getCursor();
      cursor.receivedBytes = 100;
      Object.assign(m, { cursor });
      const decision = m.decideRetry({ message: "socket hang up" });
      expect(decision.action).toBe("retry");
      expect(decision.range?.start).toBe(100);
    });

    it("returns retry for stream interruptions", () => {
      const decision = manager.decideRetry({ message: "stream interrupted" });
      expect(decision.action).toBe("retry");
      expect(decision.reason).toBe("stream-interrupted");
    });

    it("returns abort for non-retryable errors", () => {
      const decision = manager.decideRetry({ message: "invalid authentication credentials" });
      expect(decision.action).toBe("abort");
      expect(decision.reason).toContain("Non-retryable");
    });

    it("backoff delay increases with retry count", () => {
      const d1 = manager.decideRetry({ status: 503, message: "err" });
      const delay1 = d1.delay!;
      const d2 = manager.decideRetry({ status: 503, message: "err" });
      const delay2 = d2.delay!;
      expect(delay2).toBeGreaterThan(delay1);
    });

    it("backoff delay is capped at maxRetryDelayMs", () => {
      const m = new StreamRecoveryManager({ baseRetryDelayMs: 10000, maxRetryDelayMs: 12000 });
      m.decideRetry({ status: 503, message: "err" });
      m.decideRetry({ status: 503, message: "err" });
      const d3 = m.decideRetry({ status: 503, message: "err" });
      expect(d3.delay).toBeLessThanOrEqual(12000);
    });
  });

  describe("deduplicate", () => {
    it("removes duplicate sequences", () => {
      manager.updateCursor(textEvent(1, "first"));
      const events = [textEvent(1, "first"), textEvent(2, "second"), textEvent(1, "first-dup")];
      const deduped = manager.deduplicate(events);
      expect(deduped).toHaveLength(2);
    });

    it("removes duplicate tool-call ids", () => {
      manager.updateCursor(toolCallEvent(1, "call_dup"));
      const events = [toolCallEvent(2, "call_dup"), toolCallEvent(3, "call_new")];
      const deduped = manager.deduplicate(events);
      expect(deduped).toHaveLength(1);
      expect((deduped[0] as any).toolCall.id).toBe("call_new");
    });
  });

  describe("reset", () => {
    it("resets cursor and retry count to initial state", () => {
      manager.updateCursor(textEvent(5, "hello"));
      manager.decideRetry({ status: 503, message: "server error" });
      manager.reset();
      const cursor = manager.getCursor();
      expect(cursor.lastConfirmedSequence).toBe(0);
      expect(cursor.emittedToolCallIds).toEqual([]);
      const decision = manager.decideRetry({ status: 503, message: "server error" });
      expect(decision.action).toBe("retry");
    });
  });

  describe("custom options", () => {
    it("uses defaults when no options provided", () => {
      const m = new StreamRecoveryManager();
      expect(m.getCursor().lastConfirmedSequence).toBe(0);
    });

    it("merges partial options with defaults", () => {
      const m = new StreamRecoveryManager({ maxRetries: 5 });
      m.decideRetry({ status: 503, message: "err" });
      m.decideRetry({ status: 503, message: "err" });
      m.decideRetry({ status: 503, message: "err" });
      m.decideRetry({ status: 503, message: "err" });
      const d5 = m.decideRetry({ status: 503, message: "err" });
      expect(d5.action).toBe("retry");
      const d6 = m.decideRetry({ status: 503, message: "err" });
      expect(d6.action).toBe("abort");
    });
  });
});

describe("ToolIdempotencyGuard", () => {
  let guard: ToolIdempotencyGuard;

  beforeEach(() => {
    guard = new ToolIdempotencyGuard();
  });

  it("shouldExecute returns true the first time for an id", () => {
    expect(guard.shouldExecute("call_1")).toBe(true);
  });

  it("shouldExecute returns false for duplicate ids", () => {
    guard.shouldExecute("call_1");
    expect(guard.shouldExecute("call_1")).toBe(false);
  });

  it("shouldExecute returns true for different ids", () => {
    guard.shouldExecute("call_1");
    expect(guard.shouldExecute("call_2")).toBe(true);
  });

  it("restore adds previously executed ids", () => {
    guard.restore(["call_1", "call_2"]);
    expect(guard.shouldExecute("call_1")).toBe(false);
    expect(guard.shouldExecute("call_2")).toBe(false);
    expect(guard.shouldExecute("call_3")).toBe(true);
  });

  it("snapshot returns the list of executed ids", () => {
    guard.shouldExecute("call_1");
    guard.shouldExecute("call_2");
    expect(guard.snapshot()).toEqual(["call_1", "call_2"]);
  });

  it("snapshot is a copy of internal state", () => {
    guard.shouldExecute("call_1");
    const snap = guard.snapshot();
    snap.push("call_2");
    expect(guard.snapshot()).toEqual(["call_1"]);
  });

  it("restore handles empty array", () => {
    guard.restore([]);
    expect(guard.shouldExecute("call_1")).toBe(true);
  });
});
