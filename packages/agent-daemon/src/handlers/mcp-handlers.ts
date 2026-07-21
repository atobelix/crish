/**
 * MCP Server Handlers
 *
 * Extracted from DaemonRequestHandlers to reduce the monolithic
 * server-handlers.ts. Each handler function takes its dependencies
 * explicitly as parameters.
 */

import type { WebSocket } from 'ws';
import { errorMessage } from '@crish/shared-utils';
import type {
  DaemonCorrelationFields,
  DaemonOutboundMessage,
  ListMcpServersMessage,
  StartMcpServerMessage,
  StopMcpServerMessage,
} from '../types.js';
import type { DaemonRuntimeFactory } from '../server-runtime-factory.js';

interface McpTransport {
  send(ws: WebSocket, message: unknown): boolean;
  sendError(
    ws: WebSocket,
    code: string,
    message: string,
    runId?: string,
    correlation?: DaemonCorrelationFields
  ): boolean;
}

export async function handleStartMcpServer(
  ws: WebSocket,
  msg: StartMcpServerMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: McpTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(
    response: T,
    msg: DaemonCorrelationFields
  ) => T
): Promise<void> {
  try {
    const result = await runtimeFactory.startMcpServer(msg.serverId);
    transport.send(
      ws,
      correlateResponse(
        {
          type: 'mcp-server-started',
          serverId: msg.serverId,
          state: result.state,
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(
      ws,
      'MCP_START_ERROR',
      errorMessage(error),
      undefined,
      msg
    );
  }
}

export async function handleStopMcpServer(
  ws: WebSocket,
  msg: StopMcpServerMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: McpTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(
    response: T,
    msg: DaemonCorrelationFields
  ) => T
): Promise<void> {
  try {
    const result = await runtimeFactory.stopMcpServer(msg.serverId);
    transport.send(
      ws,
      correlateResponse(
        {
          type: 'mcp-server-stopped',
          serverId: msg.serverId,
          state: result.state,
        },
        msg
      )
    );
  } catch (error) {
    transport.sendError(
      ws,
      'MCP_STOP_ERROR',
      errorMessage(error),
      undefined,
      msg
    );
  }
}

export function handleListMcpServers(
  ws: WebSocket,
  msg: ListMcpServersMessage & DaemonCorrelationFields,
  runtimeFactory: DaemonRuntimeFactory,
  transport: McpTransport,
  correlateResponse: <T extends DaemonOutboundMessage>(
    response: T,
    msg: DaemonCorrelationFields
  ) => T
): void {
  try {
    const servers = runtimeFactory.listMcpServers();
    transport.send(
      ws,
      correlateResponse({ type: 'mcp-servers-listed', servers }, msg)
    );
  } catch (error) {
    transport.sendError(
      ws,
      'MCP_LIST_ERROR',
      errorMessage(error),
      undefined,
      msg
    );
  }
}
