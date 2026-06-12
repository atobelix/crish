import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@crish/agent-orchestrator";
import { DaemonMetricsCollector } from "./metrics-collector";

describe("DaemonMetricsCollector", () => {
  it("aggregates runtime events from orchestrator events by run and session", async () => {
    const records: unknown[] = [];
    const collector = new DaemonMetricsCollector({
      recordRunStarted(input: unknown) {
        records.push({ kind: "run-started", input });
      },
      async recordAgentEvent(input: unknown) {
        records.push({ kind: "agent-event", input });
      },
      async recordRunLifecycle(input: unknown) {
        records.push({ kind: "run-lifecycle", input });
      },
    } as any);

    await collector.recordOrchestratorEvent(orchestratorEvent("run-started", {}));
    await collector.recordOrchestratorEvent(orchestratorEvent("run-cancel-requested", { reason: "test" }));
    await collector.recordOrchestratorEvent(orchestratorEvent("run-cancelled", { reason: "test" }));
    await collector.recordOrchestratorEvent(
      orchestratorEvent("runtime-event", {
        event: {
          type: "provider-diagnostic",
          sessionId: "session_1",
          timestamp: "2026-06-08T00:00:01.000Z",
          diagnostic: {
            phase: "model-selected",
            providerId: "flowbit",
            configuredModel: "mimo-v2.5",
            actualModel: "mimo-v2.5",
          },
        },
      })
    );

    expect(records).toEqual([
      {
        kind: "run-started",
        input: {
          runId: "run_1",
          sessionId: "session_1",
          timestamp: "2026-06-08T00:00:00.000Z",
        },
      },
      {
        kind: "run-lifecycle",
        input: {
          runId: "run_1",
          sessionId: "session_1",
          eventType: "run-cancel-requested",
          timestamp: "2026-06-08T00:00:00.000Z",
        },
      },
      {
        kind: "run-lifecycle",
        input: {
          runId: "run_1",
          sessionId: "session_1",
          eventType: "run-cancelled",
          timestamp: "2026-06-08T00:00:00.000Z",
        },
      },
      {
        kind: "agent-event",
        input: expect.objectContaining({
          runId: "run_1",
          sessionId: "session_1",
          event: expect.objectContaining({ type: "provider-diagnostic" }),
        }),
      },
    ]);
  });
});

function orchestratorEvent(type: OrchestratorEvent["type"], payload: Record<string, unknown>): OrchestratorEvent {
  return {
    protocolVersion: 1,
    id: `event_${type}`,
    sequence: 1,
    type,
    sessionId: "session_1",
    runId: "run_1",
    timestamp: "2026-06-08T00:00:00.000Z",
    payload,
  } as OrchestratorEvent;
}
