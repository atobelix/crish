// Protocol validators: MCP server message family
import type {
  ListMcpServersMessage,
  McpServerStartedMessage,
  McpServerStoppedMessage,
  McpServersListedMessage,
  StartMcpServerMessage,
  StopMcpServerMessage,
} from "../../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../common.js";
import {
  EMPTY_COMMAND_FIELDS,
  MCP_SERVERS_LISTED_FIELDS,
  MCP_SERVER_CONTROL_FIELDS,
  MCP_SERVER_RECORD_FIELDS,
  MCP_SERVER_STARTED_FIELDS,
  MCP_SERVER_STOPPED_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredString,
} from "../common.js";

export function validateStartMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StartMcpServerMessage> {
  return validateMcpServerControlMessage(input, "start-mcp-server");
}

export function validateStopMcpServerMessage(
  input: UnknownRecord
): ProtocolValidationResult<StopMcpServerMessage> {
  return validateMcpServerControlMessage(input, "stop-mcp-server");
}

export function validateMcpServerControlMessage<TType extends "start-mcp-server" | "stop-mcp-server">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVER_CONTROL_FIELDS, issues);

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
  } as TType extends "start-mcp-server" ? StartMcpServerMessage : StopMcpServerMessage);
}

export function validateListMcpServersMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMcpServersMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-mcp-servers message", issues);

  return ok({ type: "list-mcp-servers" });
}

export function validateMcpServersListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServersListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MCP_SERVERS_LISTED_FIELDS, issues);

  const servers = requiredArray(input, "servers", "$.servers", issues);
  servers?.forEach((server, index) =>
    validateMcpServerRecord(server, `$.servers[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid mcp-servers-listed message", issues);

  return ok({
    type: "mcp-servers-listed",
    servers: servers as McpServersListedMessage["servers"],
  });
}

export function validateMcpServerStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStartedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-started");
}

export function validateMcpServerStoppedMessage(
  input: UnknownRecord
): ProtocolValidationResult<McpServerStoppedMessage> {
  return validateMcpServerStateMessage(input, "mcp-server-stopped");
}

export function validateMcpServerStateMessage<TType extends "mcp-server-started" | "mcp-server-stopped">(
  input: UnknownRecord,
  type: TType
): ProtocolValidationResult<TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(
    input,
    type === "mcp-server-started" ? MCP_SERVER_STARTED_FIELDS : MCP_SERVER_STOPPED_FIELDS,
    issues
  );

  const serverId = requiredString(input, "serverId", "$.serverId", issues, {
    nonEmpty: true,
  });
  const state = requiredString(input, "state", "$.state", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid(`Invalid ${type} message`, issues);

  return ok({
    type,
    serverId: serverId as string,
    state: state as string,
  } as TType extends "mcp-server-started" ? McpServerStartedMessage : McpServerStoppedMessage);
}

export function validateMcpServerRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MCP_SERVER_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  requiredString(value, "state", `${path}.state`, issues, { nonEmpty: true });
  if ("transport" in value) optionalString(value, "transport", `${path}.transport`, issues, { nonEmpty: true });
  if ("cachedToolCount" in value) optionalInteger(value, "cachedToolCount", `${path}.cachedToolCount`, issues, { min: 0 });
  if ("lastError" in value) optionalString(value, "lastError", `${path}.lastError`, issues);
  if ("startedAt" in value) optionalString(value, "startedAt", `${path}.startedAt`, issues, { nonEmpty: true });
}
