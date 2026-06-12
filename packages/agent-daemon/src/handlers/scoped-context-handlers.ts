/**
 * Scoped Context Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  DeleteScopedContextMessage,
  GetScopedContextMessage,
  ResolveScopedContextMessage,
  UpsertScopedContextMessage,
} from "../types.js";
import type { ScopedContextStore } from "../scoped-context-store.js";
import {
  createDeleteScopedContextResponse,
  createGetScopedContextResponse,
  createResolveScopedContextResponse,
  createUpsertScopedContextResponse,
} from "../scoped-context-query-handlers.js";

interface ScopedContextTransport {
  send(ws: WebSocket, message: unknown): boolean;
}

export async function handleGetScopedContext(
  ws: WebSocket,
  msg: GetScopedContextMessage & DaemonCorrelationFields,
  store: ScopedContextStore,
  transport: ScopedContextTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const response = await createGetScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse(response, msg));
}

export async function handleUpsertScopedContext(
  ws: WebSocket,
  msg: UpsertScopedContextMessage & DaemonCorrelationFields,
  store: ScopedContextStore,
  transport: ScopedContextTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const response = await createUpsertScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse(response, msg));
}

export async function handleDeleteScopedContext(
  ws: WebSocket,
  msg: DeleteScopedContextMessage & DaemonCorrelationFields,
  store: ScopedContextStore,
  transport: ScopedContextTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const response = await createDeleteScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse(response, msg));
}

export async function handleResolveScopedContext(
  ws: WebSocket,
  msg: ResolveScopedContextMessage & DaemonCorrelationFields,
  store: ScopedContextStore,
  transport: ScopedContextTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  const response = await createResolveScopedContextResponse(store, msg);
  transport.send(ws, correlateResponse(response, msg));
}
