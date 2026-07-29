// Protocol validators: lifecycle message family (artifacts, memories, checkpoints)
import type {
  ArtifactContentMessage,
  ArtifactsListedMessage,
  CheckpointDiffMessage,
  CheckpointRestoredMessage,
  CheckpointsListedMessage,
  DeleteMemoryMessage,
  GetArtifactContentMessage,
  GetCheckpointDiffMessage,
  ListArtifactsMessage,
  ListCheckpointsMessage,
  ListMemoriesMessage,
  MemoriesListedMessage,
  MemoryDeletedMessage,
  RestoreCheckpointMessage,
} from "../../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../common.js";
import {
  ARTIFACTS_LISTED_FIELDS,
  ARTIFACT_CONTENT_FIELDS,
  ARTIFACT_RECORD_FIELDS,
  CHANGED_FILE_RECORD_FIELDS,
  CHECKPOINTS_LISTED_FIELDS,
  CHECKPOINT_DIFF_FIELDS,
  CHECKPOINT_RECORD_FIELDS,
  CHECKPOINT_RESTORED_FIELDS,
  DELETE_MEMORY_FIELDS,
  GET_ARTIFACT_CONTENT_FIELDS,
  GET_CHECKPOINT_DIFF_FIELDS,
  LIST_ARTIFACTS_FIELDS,
  LIST_CHECKPOINTS_FIELDS,
  LIST_MEMORIES_FIELDS,
  MEMORIES_LISTED_FIELDS,
  MEMORY_DELETED_FIELDS,
  MEMORY_RECORD_FIELDS,
  RESTORE_CHECKPOINT_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalInteger,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredString,
} from "../common.js";

export function validateListArtifactsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListArtifactsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_ARTIFACTS_FIELDS, issues);

  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-artifacts message", issues);

  return ok({
    type: "list-artifacts",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateGetArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-artifact-content message", issues);

  return ok({
    type: "get-artifact-content",
    artifactUri: artifactUri as string,
  });
}

export function validateListMemoriesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMemoriesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MEMORIES_FIELDS, issues);

  const scope = optionalString(input, "scope", "$.scope", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-memories message", issues);

  return ok({
    type: "list-memories",
    ...(scope !== undefined ? { scope } : {}),
  });
}

export function validateDeleteMemoryMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteMemoryMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_MEMORY_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-memory message", issues);

  return ok({
    type: "delete-memory",
    memoryId: memoryId as string,
  });
}

export function validateListCheckpointsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListCheckpointsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_CHECKPOINTS_FIELDS, issues);

  const runId = optionalString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });
  const sessionId = optionalString(input, "sessionId", "$.sessionId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-checkpoints message", issues);

  return ok({
    type: "list-checkpoints",
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export function validateRestoreCheckpointMessage(
  input: UnknownRecord
): ProtocolValidationResult<RestoreCheckpointMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESTORE_CHECKPOINT_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid restore-checkpoint message", issues);

  return ok({
    type: "restore-checkpoint",
    checkpointId: checkpointId as string,
  });
}

export function validateGetCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetCheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-checkpoint-diff message", issues);

  return ok({
    type: "get-checkpoint-diff",
    checkpointId: checkpointId as string,
  });
}

export function validateArtifactsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACTS_LISTED_FIELDS, issues);

  const artifacts = requiredArray(input, "artifacts", "$.artifacts", issues);
  artifacts?.forEach((artifact, index) =>
    validateArtifactRecord(artifact, `$.artifacts[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid artifacts-listed message", issues);

  return ok({
    type: "artifacts-listed",
    artifacts: artifacts as ArtifactsListedMessage["artifacts"],
  });
}

export function validateArtifactContentMessage(
  input: UnknownRecord
): ProtocolValidationResult<ArtifactContentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, ARTIFACT_CONTENT_FIELDS, issues);

  const artifactUri = requiredString(input, "artifactUri", "$.artifactUri", issues, {
    nonEmpty: true,
  });
  const content = requiredString(input, "content", "$.content", issues);
  const mimeType = optionalString(input, "mimeType", "$.mimeType", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid artifact-content message", issues);

  return ok({
    type: "artifact-content",
    artifactUri: artifactUri as string,
    content: content as string,
    ...(mimeType !== undefined ? { mimeType } : {}),
  });
}

export function validateMemoriesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoriesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORIES_LISTED_FIELDS, issues);

  const memories = requiredArray(input, "memories", "$.memories", issues);
  memories?.forEach((memory, index) =>
    validateMemoryRecord(memory, `$.memories[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid memories-listed message", issues);

  return ok({
    type: "memories-listed",
    memories: memories as MemoriesListedMessage["memories"],
  });
}

export function validateMemoryDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MemoryDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MEMORY_DELETED_FIELDS, issues);

  const memoryId = requiredString(input, "memoryId", "$.memoryId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid memory-deleted message", issues);

  return ok({
    type: "memory-deleted",
    memoryId: memoryId as string,
  });
}

export function validateCheckpointsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINTS_LISTED_FIELDS, issues);

  const checkpoints = requiredArray(input, "checkpoints", "$.checkpoints", issues);
  checkpoints?.forEach((checkpoint, index) =>
    validateCheckpointRecord(checkpoint, `$.checkpoints[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoints-listed message", issues);

  return ok({
    type: "checkpoints-listed",
    checkpoints: checkpoints as CheckpointsListedMessage["checkpoints"],
  });
}

export function validateCheckpointDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_DIFF_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) =>
    validateChangedFileRecord(file, `$.files[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid checkpoint-diff message", issues);

  return ok({
    type: "checkpoint-diff",
    checkpointId: checkpointId as string,
    files: files as CheckpointDiffMessage["files"],
  });
}

export function validateCheckpointRestoredMessage(
  input: UnknownRecord
): ProtocolValidationResult<CheckpointRestoredMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CHECKPOINT_RESTORED_FIELDS, issues);

  const checkpointId = requiredString(input, "checkpointId", "$.checkpointId", issues, {
    nonEmpty: true,
  });
  const runId = requiredString(input, "runId", "$.runId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid checkpoint-restored message", issues);

  return ok({
    type: "checkpoint-restored",
    checkpointId: checkpointId as string,
    runId: runId as string,
  });
}

export function validateArtifactRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, ARTIFACT_RECORD_FIELDS, issues, path);
  requiredString(value, "uri", `${path}.uri`, issues, { nonEmpty: true });
  requiredString(value, "type", `${path}.type`, issues, { nonEmpty: true });
  requiredString(value, "name", `${path}.name`, issues, { nonEmpty: true });
  if ("size" in value) optionalInteger(value, "size", `${path}.size`, issues, { min: 0 });
  if ("createdAt" in value) optionalString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
}

export function validateMemoryRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MEMORY_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "key", `${path}.key`, issues, { nonEmpty: true });
  requiredString(value, "value", `${path}.value`, issues);
  requiredString(value, "scope", `${path}.scope`, issues, { nonEmpty: true });
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("updatedAt" in value) optionalString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateCheckpointRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHECKPOINT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  requiredString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  if ("messageCount" in value) optionalInteger(value, "messageCount", `${path}.messageCount`, issues, { min: 0 });
}

export function validateChangedFileRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, CHANGED_FILE_RECORD_FIELDS, issues, path);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  if ("addedLines" in value) optionalInteger(value, "addedLines", `${path}.addedLines`, issues, { min: 0 });
  if ("removedLines" in value) optionalInteger(value, "removedLines", `${path}.removedLines`, issues, { min: 0 });
}
