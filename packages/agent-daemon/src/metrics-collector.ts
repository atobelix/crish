import type { AgentEvent } from "@crish/shared-types";
import type { OrchestratorEvent } from "@crish/agent-orchestrator";
import type { FileMetricsStore } from "./metrics-store.js";

export class DaemonMetricsCollector {
  constructor(private readonly store: FileMetricsStore) {}

  recordOrchestratorEvent(event: OrchestratorEvent): Promise<void> | void {
    if (event.type === "run-started" && event.runId) {
      this.store.recordRunStarted({
        runId: event.runId,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
      });
      return;
    }

    if ((event.type === "run-cancel-requested" || event.type === "run-cancelled") && event.runId) {
      return this.store.recordRunLifecycle({
        runId: event.runId,
        sessionId: event.sessionId,
        eventType: event.type,
        timestamp: event.timestamp,
      });
    }

    if (event.type !== "runtime-event" || !event.runId) return;
    const agentEvent = readAgentEvent(event.payload.event);
    if (!agentEvent) return;
    return this.recordAgentEvent({
      runId: event.runId,
      sessionId: event.sessionId,
      event: agentEvent,
    });
  }

  recordAgentEvent(input: { runId: string; sessionId: string; event: AgentEvent }): Promise<void> {
    return this.store.recordAgentEvent(input);
  }
}

function readAgentEvent(value: unknown): AgentEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof (value as { type?: unknown }).type === "string" ? (value as AgentEvent) : undefined;
}
