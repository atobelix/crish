/**
 * Background Task Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from "ws";
import { errorMessage } from "@crish/shared-utils";
import type {
  CancelBackgroundTaskMessage,
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  GetBackgroundTaskHistoryMessage,
  ListBackgroundTasksMessage,
  StartBackgroundTaskMessage,
} from "../types.js";
import type { DaemonBackgroundTaskManager } from "../background-task-manager.js";
import { DaemonBackgroundTaskError, daemonBackgroundDiagnostics } from "../background-task-manager.js";

interface BackgroundTaskTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(ws: WebSocket, code: string, message: string, runId?: string, correlation?: DaemonCorrelationFields): boolean;
}

function sendBackgroundTaskError(
  ws: WebSocket,
  error: unknown,
  transport: BackgroundTaskTransport,
  correlation?: DaemonCorrelationFields
): void {
  if (error instanceof DaemonBackgroundTaskError) {
    transport.sendError(ws, error.code, error.message, undefined, correlation);
    return;
  }
  transport.sendError(ws, "BACKGROUND_TASK_ERROR", errorMessage(error), undefined, correlation);
}

export function handleListBackgroundTasks(
  ws: WebSocket,
  msg: ListBackgroundTasksMessage & DaemonCorrelationFields,
  backgroundTasks: DaemonBackgroundTaskManager,
  transport: BackgroundTaskTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const tasks = backgroundTasks.list({
      ...(msg.includeHistory !== undefined ? { includeHistory: msg.includeHistory } : {}),
      ...(msg.state !== undefined ? { state: msg.state } : {}),
      ...(msg.limit !== undefined ? { limit: msg.limit } : {}),
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "background-tasks-listed",
          tasks,
          diagnostics: daemonBackgroundDiagnostics(tasks),
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}

export async function handleStartBackgroundTask(
  ws: WebSocket,
  msg: StartBackgroundTaskMessage & DaemonCorrelationFields,
  backgroundTasks: DaemonBackgroundTaskManager,
  transport: BackgroundTaskTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): Promise<void> {
  try {
    const task = await backgroundTasks.start({
      command: msg.command,
      ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
      ...(msg.workspaceRoot !== undefined ? { workspaceRoot: msg.workspaceRoot } : {}),
      ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
      ...(msg.maxOutputBytes !== undefined ? { maxOutputBytes: msg.maxOutputBytes } : {}),
      ...(msg.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: msg.heartbeatIntervalMs } : {}),
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "background-task-started",
          task,
          diagnostics: daemonBackgroundDiagnostics([task]),
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}

export function handleCancelBackgroundTask(
  ws: WebSocket,
  msg: CancelBackgroundTaskMessage & DaemonCorrelationFields,
  backgroundTasks: DaemonBackgroundTaskManager,
  transport: BackgroundTaskTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const task = backgroundTasks.cancel(msg.taskId);
    transport.send(
      ws,
      correlateResponse(
        {
          type: "background-task-cancelled",
          task,
          diagnostics: daemonBackgroundDiagnostics([task]),
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}

export function handleGetBackgroundTaskHistory(
  ws: WebSocket,
  msg: GetBackgroundTaskHistoryMessage & DaemonCorrelationFields,
  backgroundTasks: DaemonBackgroundTaskManager,
  transport: BackgroundTaskTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(response: T, msg: DaemonCorrelationFields) => T
): void {
  try {
    const tasks = backgroundTasks.history({
      ...(msg.state !== undefined ? { state: msg.state } : {}),
      ...(msg.limit !== undefined ? { limit: msg.limit } : {}),
    });
    transport.send(
      ws,
      correlateResponse(
        {
          type: "background-task-history",
          tasks,
          diagnostics: daemonBackgroundDiagnostics(tasks),
        },
        msg
      )
    );
  } catch (error) {
    sendBackgroundTaskError(ws, error, transport, msg);
  }
}
