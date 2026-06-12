import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_PROTOCOL_VERSION, type OrchestratorEvent } from "./types";
import { createCommandEnvelope, createEventEnvelope, replayEventsAfterLastEventId } from "./protocol";

describe("protocol helpers", () => {
  it("creates versioned command and event envelopes", () => {
    const command = createCommandEnvelope({
      id: "command_1",
      type: "start-run",
      timestamp: "2026-01-01T00:00:00.000Z",
      correlationId: "request_1",
      payload: {
        id: "run_a",
        sessionId: "session_a",
        cwd: "C:/tmp",
        input: "hello"
      }
    });
    const event = createEventEnvelope({
      id: "event_1",
      sequence: 1,
      type: "run-started",
      sessionId: "session_a",
      runId: "run_a",
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: { ok: true }
    });

    expect(command.protocolVersion).toBe(ORCHESTRATOR_PROTOCOL_VERSION);
    expect(command.type).toBe("start-run");
    expect(command.correlationId).toBe("request_1");
    expect(event).toMatchObject({
      protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
      id: "event_1",
      sequence: 1,
      type: "run-started",
      sessionId: "session_a",
      runId: "run_a"
    });
  });

  it("replays events after lastEventId using sequence order", () => {
    const events = [
      event("event_3", 3),
      event("event_1", 1),
      event("event_2", 2),
      event("event_4", 4)
    ];

    expect(replayEventsAfterLastEventId(events, "event_2").map((item) => item.id)).toEqual(["event_3", "event_4"]);
    expect(replayEventsAfterLastEventId(events, "missing").map((item) => item.id)).toEqual(["event_1", "event_2", "event_3", "event_4"]);
  });
});

function event(id: string, sequence: number): OrchestratorEvent {
  return {
    protocolVersion: ORCHESTRATOR_PROTOCOL_VERSION,
    id,
    sequence,
    type: "runtime-event",
    sessionId: "session_a",
    runId: "run_a",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {}
  };
}
