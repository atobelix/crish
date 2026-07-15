// Protocol validators: subagent message family
import type {
  GetSubagentStatusMessage,
  SendToSubagentMessage,
  SubagentEndedMessage,
  SubagentEventMessage,
  SubagentMessageSentMessage,
  SubagentStartedMessage,
  SubagentStatusMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  GET_SUBAGENT_STATUS_FIELDS,
  SEND_TO_SUBAGENT_FIELDS,
  SUBAGENT_ENDED_FIELDS,
  SUBAGENT_EVENT_FIELDS,
  SUBAGENT_MESSAGE_SENT_FIELDS,
  SUBAGENT_STARTED_FIELDS,
  SUBAGENT_STATUS_FIELDS,
  invalid,
  ok,
  optionalString,
  rejectUnknownFields,
  requiredBoolean,
  requiredEnum,
  requiredString,
} from "./common.js";
import { validateAgentEvent } from "./session-events.js";

export function validateSendToSubagentMessage(
  input: UnknownRecord
): ProtocolValidationResult<SendToSubagentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SEND_TO_SUBAGENT_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const message = requiredString(input, "message", "$.message", issues);

  if (issues.length > 0) return invalid("Invalid send-to-subagent message", issues);

  return ok({
    type: "send-to-subagent",
    subagentRunId: subagentRunId as string,
    message: message as string,
  });
}

export function validateGetSubagentStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetSubagentStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_SUBAGENT_STATUS_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-subagent-status message", issues);

  return ok({
    type: "get-subagent-status",
    subagentRunId: subagentRunId as string,
  });
}

export function validateSubagentStartedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentStartedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_STARTED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const description = requiredString(
    input,
    "description",
    "$.description",
    issues
  );
  const mode = requiredString(input, "mode", "$.mode", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) {
    return invalid("Invalid subagent-started message", issues);
  }

  return ok({
    type: "subagent-started",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    description: description as string,
    mode: mode as string,
  });
}

export function validateSubagentEndedMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentEndedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_ENDED_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  const status = requiredEnum(
    input,
    "status",
    "$.status",
    ["completed", "failed"],
    issues
  );
  const summary = requiredString(input, "summary", "$.summary", issues);

  if (issues.length > 0) {
    return invalid("Invalid subagent-ended message", issues);
  }

  return ok({
    type: "subagent-ended",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    status: status as "completed" | "failed",
    summary: summary as string,
  });
}

export function validateSubagentEventMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentEventMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_EVENT_FIELDS, issues);

  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const subagentId = requiredString(
    input,
    "subagentId",
    "$.subagentId",
    issues,
    { nonEmpty: true }
  );
  const subagentRunId = requiredString(
    input,
    "subagentRunId",
    "$.subagentRunId",
    issues,
    { nonEmpty: true }
  );
  const parentToolCallId = requiredString(
    input,
    "parentToolCallId",
    "$.parentToolCallId",
    issues,
    { nonEmpty: true }
  );
  validateAgentEvent(input.event, "$.event", issues);

  if (issues.length > 0) return invalid("Invalid subagent-event message", issues);

  return ok({
    type: "subagent-event",
    runId: runId as string,
    subagentId: subagentId as string,
    subagentRunId: subagentRunId as string,
    parentToolCallId: parentToolCallId as string,
    event: input.event as SubagentEventMessage["event"],
  });
}

export function validateSubagentMessageSentMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentMessageSentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_MESSAGE_SENT_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const accepted = requiredBoolean(input, "accepted", "$.accepted", issues);

  if (issues.length > 0) return invalid("Invalid subagent-message-sent message", issues);

  return ok({
    type: "subagent-message-sent",
    subagentRunId: subagentRunId as string,
    accepted: accepted as boolean,
  });
}

export function validateSubagentStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<SubagentStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SUBAGENT_STATUS_FIELDS, issues);

  const subagentRunId = requiredString(input, "subagentRunId", "$.subagentRunId", issues, {
    nonEmpty: true,
  });
  const status = requiredString(input, "status", "$.status", issues, {
    nonEmpty: true,
  });
  const progress = optionalString(input, "progress", "$.progress", issues);
  const latestError = optionalString(input, "latestError", "$.latestError", issues);

  if (issues.length > 0) return invalid("Invalid subagent-status message", issues);

  return ok({
    type: "subagent-status",
    subagentRunId: subagentRunId as string,
    status: status as string,
    ...(progress !== undefined ? { progress } : {}),
    ...(latestError !== undefined ? { latestError } : {}),
  });
}
