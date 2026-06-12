/**
 * Artifact / Memory / Checkpoint Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  DeleteMemoryMessage,
  GetArtifactContentMessage,
  GetCheckpointDiffMessage,
  ListArtifactsMessage,
  ListCheckpointsMessage,
  ListMemoriesMessage,
  RestoreCheckpointMessage,
} from "../types.js";
import type { DaemonRuntimeFactory } from "../server-runtime-factory.js";
import { DaemonUnsupportedCapabilityError } from "../server-runtime-factory.js";

interface ArtifactTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

function sendCapabilityError(
  ws: WebSocket,
  error: unknown,
  fallbackCode: string,
  transport: ArtifactTransport,
  correlation?: DaemonCorrelationFields
): void {
  if (error instanceof DaemonUnsupportedCapabilityError) {
    transport.sendError(ws, error.code, error.message, undefined, correlation);
    return;
  }
  transport.sendError(ws, fallbackCode, errorMessage(error), undefined, correlation);
}

export async function handleListArtifacts(
  ws: WebSocket,
  msg: ListArtifactsMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const artifacts = await runtimeFactory.listArtifacts(msg.sessionId);
    transport.send(
      ws,
      correlateResponse(
        { type: "artifacts-listed", artifacts },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "ARTIFACT_LIST_ERROR", transport, msg);
  }
}

export async function handleGetArtifactContent(
  ws: WebSocket,
  msg: GetArtifactContentMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const content = await runtimeFactory.getArtifactContent(msg.artifactUri);
    transport.send(
      ws,
      correlateResponse(
        { type: "artifact-content", artifactUri: msg.artifactUri, ...content },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "ARTIFACT_CONTENT_ERROR", transport, msg);
  }
}

export async function handleListMemories(
  ws: WebSocket,
  msg: ListMemoriesMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const memories = await runtimeFactory.listMemories(msg.scope);
    transport.send(
      ws,
      correlateResponse(
        { type: "memories-listed", memories },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "MEMORY_LIST_ERROR", transport, msg);
  }
}

export async function handleDeleteMemory(
  ws: WebSocket,
  msg: DeleteMemoryMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    await runtimeFactory.deleteMemory(msg.memoryId);
    transport.send(
      ws,
      correlateResponse(
        { type: "memory-deleted", memoryId: msg.memoryId },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "MEMORY_DELETE_ERROR", transport, msg);
  }
}

export async function handleListCheckpoints(
  ws: WebSocket,
  msg: ListCheckpointsMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const checkpoints = await runtimeFactory.listCheckpoints(msg.runId, msg.sessionId);
    transport.send(
      ws,
      correlateResponse(
        { type: "checkpoints-listed", checkpoints },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_LIST_ERROR", transport, msg);
  }
}

export async function handleRestoreCheckpoint(
  ws: WebSocket,
  msg: RestoreCheckpointMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const result = await runtimeFactory.restoreCheckpoint(msg.checkpointId);
    transport.send(
      ws,
      correlateResponse(
        { type: "checkpoint-restored", checkpointId: msg.checkpointId, runId: result.runId },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_RESTORE_ERROR", transport, msg);
  }
}

export async function handleGetCheckpointDiff(
  ws: WebSocket,
  msg: GetCheckpointDiffMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: ArtifactTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const files = await runtimeFactory.getCheckpointDiff(msg.checkpointId);
    transport.send(
      ws,
      correlateResponse(
        { type: "checkpoint-diff", checkpointId: msg.checkpointId, files },
        msg
      )
    );
  } catch (error) {
    sendCapabilityError(ws, error, "CHECKPOINT_DIFF_ERROR", transport, msg);
  }
}
