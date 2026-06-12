import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_PROTOCOL_VERSION, type OrchestratorEvent } from "@crish/agent-orchestrator";
import { DaemonEventStore } from "./server-event-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("DaemonEventStore", () => {
  it("writes and reads events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-event-store-test-"));
    try {
      const store = new DaemonEventStore(join(dir, "events.jsonl"));
      const event: OrchestratorEvent = {
        protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
        id: "evt_1",
        sequence: 1,
        type: "run-started",
        sessionId: "session_1",
        timestamp: new Date().toISOString(),
        payload: {},
      };
      await store.append(event);
      const events = await store.readAll();
      expect(events.length).toBe(1);
      expect(events[0].id).toBe("evt_1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined failure when healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-event-store-health-"));
    try {
      const store = new DaemonEventStore(join(dir, "health.jsonl"));
      expect(store.getFailure()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
