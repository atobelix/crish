import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_PROTOCOL_VERSION,
  type OrchestratorEvent,
} from "../types";

describe("orchestrator event type validation", () => {
  it("accepts a well-formed session-created event", () => {
    const event: OrchestratorEvent = {
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      id: "event_1",
      sequence: 1,
      type: "session-created",
      sessionId: "session_a",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {
        session: {
          id: "session_a",
          cwd: "/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "open",
        },
      },
    };
    expect(event.id).toBe("event_1");
    expect(event.type).toBe("session-created");
  });

  it("accepts all known event types", () => {
    const types = [
      "session-created",
      "conversation-rewind-audit",
      "session-leaf-moved",
      "pending-input-created",
      "pending-input-cancelled",
      "pending-input-dispatched",
      "run-queued",
      "run-started",
      "goal-round-started",
      "goal-round-completed",
      "goal-continuation-decided",
      "runtime-event",
      "run-cancel-requested",
      "run-cancelled",
      "run-completed",
      "run-failed",
    ] as const;
    for (const type of types) {
      const event: OrchestratorEvent = {
        protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
        id: `event_${type}`,
        sequence: 1,
        type,
        sessionId: "session_a",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { ok: true },
      };
      expect(event.type).toBe(type);
    }
  });
});
