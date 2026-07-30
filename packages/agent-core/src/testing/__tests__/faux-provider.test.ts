import { describe, it, expect, vi } from "vitest";
import { FauxAgentProvider } from "../faux-provider";
import type { ProviderStreamEvent } from "@crish/shared-types";

describe("FauxAgentProvider", () => {
  const req = () => ({
    sessionId: "test",
    cwd: "/tmp",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  });

  describe("setEvents", () => {
    it("yields events in order via stream", async () => {
      const p = new FauxAgentProvider("p1");
      const events: ProviderStreamEvent[] = [
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "stop", reason: "stop" },
      ];
      p.setEvents(events);

      const got: ProviderStreamEvent[] = [];
      for await (const e of p.stream(req())) got.push(e);
      expect(got).toEqual(events);
    });
  });

  describe("setError", () => {
    it("throws the error when stream is called", async () => {
      const p = new FauxAgentProvider("p1");
      p.setError(new Error("boom"));

      const iter = p.stream(req())[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow("boom");
    });
  });

  describe("setLatency", () => {
    it("delays stream by the given ms", async () => {
      vi.useFakeTimers();
      const p = new FauxAgentProvider("p1");
      p.setEvents([{ type: "text-delta", text: "x" }]);
      p.setLatency(80);

      const iter = p.stream(req())[Symbol.asyncIterator]();
      const nextPromise = iter.next();
      await vi.advanceTimersByTimeAsync(80);

      const result = await nextPromise;
      expect(result.done).toBe(false);
      expect(result.value).toEqual({ type: "text-delta", text: "x" });
    });
  });

  describe("setFailAfter", () => {
    it("yields only n events then stops", async () => {
      const p = new FauxAgentProvider("p1");
      p.setEvents([
        { type: "text-delta", text: "1" },
        { type: "text-delta", text: "2" },
        { type: "text-delta", text: "3" },
      ]);
      p.setFailAfter(2);

      const got: ProviderStreamEvent[] = [];
      for await (const e of p.stream(req())) got.push(e);
      expect(got).toHaveLength(2);
      expect(got[0]).toEqual({ type: "text-delta", text: "1" });
      expect(got[1]).toEqual({ type: "text-delta", text: "2" });
    });
  });

  describe("reset", () => {
    it("clears events, error, latency, and failAfter", async () => {
      const p = new FauxAgentProvider("p1");
      p.setEvents([{ type: "text-delta", text: "x" }]);
      p.setError(new Error("x"));
      p.setLatency(9999);
      p.setFailAfter(0);
      p.reset();

      // stream yields nothing (events is empty)
      const got: ProviderStreamEvent[] = [];
      for await (const e of p.stream(req())) got.push(e);
      expect(got).toHaveLength(0);
    });
  });
});
