// Protocol validators: git message family
import type {
  GitDiffMessage,
  GitDiffResponseMessage,
  GitStatusMessage,
  GitStatusResponseMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  GIT_DIFF_FIELDS,
  GIT_DIFF_RESPONSE_FIELDS,
  GIT_STATUS_FIELDS,
  GIT_STATUS_FILE_FIELDS,
  GIT_STATUS_RESPONSE_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalBoolean,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
  validateOptionalNullableString,
} from "./common.js";
import { validateChangedFileRecord } from "./background.js";

export function validateGitStatusMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitStatusMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_STATUS_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid git-status message", issues);

  return ok({
    type: "git-status",
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

export function validateGitDiffMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitDiffMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_DIFF_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const path = optionalString(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = optionalBoolean(input, "staged", "$.staged", issues);

  if (issues.length > 0) return invalid("Invalid git-diff message", issues);

  return ok({
    type: "git-diff",
    ...(cwd !== undefined ? { cwd } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(staged !== undefined ? { staged } : {}),
  });
}

export function validateGitStatusResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitStatusResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_STATUS_RESPONSE_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const found = requiredBoolean(input, "found", "$.found", issues);
  const repositoryRoot = optionalString(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const gitDir = optionalString(input, "gitDir", "$.gitDir", issues, { nonEmpty: true });
  validateOptionalNullableString(input, "head", "$.head", issues);
  validateOptionalNullableString(input, "branch", "$.branch", issues);
  const clean = optionalBoolean(input, "clean", "$.clean", issues);
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateGitStatusFile(file, `$.files[${index}]`, issues));
  const stagedCount = requiredInteger(input, "stagedCount", "$.stagedCount", issues, { min: 0 });
  const unstagedCount = requiredInteger(input, "unstagedCount", "$.unstagedCount", issues, { min: 0 });
  const untrackedCount = requiredInteger(input, "untrackedCount", "$.untrackedCount", issues, { min: 0 });
  const conflictedCount = requiredInteger(input, "conflictedCount", "$.conflictedCount", issues, { min: 0 });
  const reason = optionalString(input, "reason", "$.reason", issues, { nonEmpty: true });

  if (issues.length > 0) return invalid("Invalid git-status-response message", issues);

  return ok({
    type: "git-status-response",
    cwd: cwd as string,
    found: found as boolean,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    ...(gitDir !== undefined ? { gitDir } : {}),
    ...("head" in input ? { head: input.head as string | null } : {}),
    ...("branch" in input ? { branch: input.branch as string | null } : {}),
    ...(clean !== undefined ? { clean } : {}),
    files: files as GitStatusResponseMessage["files"],
    stagedCount: stagedCount as number,
    unstagedCount: unstagedCount as number,
    untrackedCount: untrackedCount as number,
    conflictedCount: conflictedCount as number,
    ...(reason !== undefined ? { reason } : {}),
  });
}

export function validateGitDiffResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<GitDiffResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GIT_DIFF_RESPONSE_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const repositoryRoot = optionalString(input, "repositoryRoot", "$.repositoryRoot", issues, { nonEmpty: true });
  const path = optionalString(input, "path", "$.path", issues, { nonEmpty: true });
  const staged = requiredBoolean(input, "staged", "$.staged", issues);
  const unified = requiredString(input, "unified", "$.unified", issues);
  const stat = requiredString(input, "stat", "$.stat", issues);
  const files = requiredArray(input, "files", "$.files", issues);
  files?.forEach((file, index) => validateChangedFileRecord(file, `$.files[${index}]`, issues));

  if (issues.length > 0) return invalid("Invalid git-diff-response message", issues);

  return ok({
    type: "git-diff-response",
    cwd: cwd as string,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    ...(path !== undefined ? { path } : {}),
    staged: staged as boolean,
    unified: unified as string,
    stat: stat as string,
    files: files as GitDiffResponseMessage["files"],
  });
}

export function validateGitStatusFile(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, GIT_STATUS_FILE_FIELDS, issues, path);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredEnum(value, "status", `${path}.status`, ["A", "M", "D", "U", "R", "C", "?", "!", "mixed"] as const, issues);
  requiredString(value, "index", `${path}.index`, issues);
  requiredString(value, "worktree", `${path}.worktree`, issues);
  requiredBoolean(value, "staged", `${path}.staged`, issues);
  requiredBoolean(value, "unstaged", `${path}.unstaged`, issues);
  requiredBoolean(value, "untracked", `${path}.untracked`, issues);
  requiredBoolean(value, "conflicted", `${path}.conflicted`, issues);
  if ("originalPath" in value) optionalString(value, "originalPath", `${path}.originalPath`, issues, { nonEmpty: true });
}
