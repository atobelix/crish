/**
 * Run Lifecycle - Streaming & Event Dispatch
 * Handles stream backpressure, pause/resume, event sink creation, and mutation lease listing.
 */

import type { WebSocket } from "ws";
import type { JsonObject } from "@crish/shared-types";
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  ListMutationLeasesMessage,
} from "../../../types.js";
import type { DaemonRuntimeFactory } from "../../../server-runtime-factory.js";
import { StreamBackpressureRegistry } from "../../../stream-backpressure.js";
import {
  DaemonMessageTransport,
  RunEventSink,
  correlateResponse,
  createRunEventSink as createRunEventSinkFn,
} from "../run-tool-executor.js";
import type { OrchestratedRunInput } from "./run-start.js";

export function handlePauseStream(
  backpressure: StreamBackpressureRegistry,
  runId: string
): void {
  if (!runId) return;
  backpressure.pause(runId);
  console.info(`[Daemon] Stream paused for run ${runId}`);
}

export function handleResumeStream(
  backpressure: StreamBackpressureRegistry,
  activeRunSockets: Map<string, WebSocket | undefined>,
  transport: DaemonMessageTransport,
  runId: string
): void {
  if (!runId) return;
  const buffered = backpressure.resume(runId);
  const ws = activeRunSockets.get(runId);
  for (const message of buffered) {
    const outbound = message as DaemonOutboundMessage;
    if (ws && ws.readyState === ws.OPEN) {
      transport.send(ws, outbound);
    } else {
      transport.broadcast(outbound);
    }
  }
  if (buffered.length > 0) {
    console.info(
      `[Daemon] Stream resumed for run ${runId}; flushed ${buffered.length} buffered message(s)`
    );
  } else {
    console.info(`[Daemon] Stream resumed for run ${runId}`);
  }
}

export function handleListMutationLeasesResponse(
  runtimeFactory: DaemonRuntimeFactory,
  transport: DaemonMessageTransport,
  ws: WebSocket,
  msg: ListMutationLeasesMessage & DaemonCorrelationFields
): void {
  const leases = runtimeFactory.listMutationLeases();
  transport.send(
    ws,
    correlateResponse(
      {
        type: "mutation-leases-listed",
        leases,
      },
      msg
    )
  );
}

export function createRunEventSinkForInput(
  input: OrchestratedRunInput,
  transport: DaemonMessageTransport,
  backpressure: StreamBackpressureRegistry,
  activeRunSockets: Map<string, WebSocket | undefined>,
  recordDiagnostic?: (input: {
    code: string;
    message: string;
    source: "daemon" | "websocket" | "client" | "event-store" | "provider" | "mcp";
    severity?: "warning" | "error";
    detail?: string;
    metadata?: JsonObject;
  }) => void
): RunEventSink {
  return createRunEventSinkFn(
    input,
    transport,
    backpressure,
    activeRunSockets,
    recordDiagnostic
  );
}
