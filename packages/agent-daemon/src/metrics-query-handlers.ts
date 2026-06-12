import type { DaemonCorrelationFields, GetMetricsMessage, GetMetricsSnapshotMessage, MetricsResponseMessage } from "./types.js";
import type { FileMetricsStore } from "./metrics-store.js";

export function createGetMetricsResponse(
  store: FileMetricsStore,
  message: (GetMetricsMessage | GetMetricsSnapshotMessage) & DaemonCorrelationFields
): MetricsResponseMessage & DaemonCorrelationFields {
  return {
    type: "metrics-response",
    ...store.query({
      runId: message.runId,
      sessionId: message.sessionId,
      includeRuns: message.includeRuns,
    }),
  };
}
