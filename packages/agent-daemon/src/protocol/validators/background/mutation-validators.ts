// Protocol validators: mutation lease message family
import type {
  ListMutationLeasesMessage,
  MutationLeasesListedMessage,
} from "../../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../common.js";
import {
  LIST_MUTATION_LEASES_FIELDS,
  MUTATION_LEASES_LISTED_FIELDS,
  MUTATION_LEASE_FIELDS,
  MUTATION_LEASE_OWNER_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalString,
  rejectUnknownFields,
  requiredArray,
  requiredEnum,
  requiredInteger,
  requiredString,
} from "../common.js";

export function validateListMutationLeasesMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListMutationLeasesMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, LIST_MUTATION_LEASES_FIELDS, issues);

  const cwd = optionalString(input, "cwd", "$.cwd", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid list-mutation-leases message", issues);

  return ok({
    type: "list-mutation-leases",
    ...(cwd !== undefined ? { cwd } : {}),
  });
}

export function validateMutationLeasesListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<MutationLeasesListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, MUTATION_LEASES_LISTED_FIELDS, issues);

  const leases = requiredArray(input, "leases", "$.leases", issues);
  leases?.forEach((lease, index) => validateMutationLeaseSnapshot(lease, `$.leases[${index}]`, issues));

  if (issues.length > 0) return invalid("Invalid mutation-leases-listed message", issues);

  return ok({
    type: "mutation-leases-listed",
    leases: leases as MutationLeasesListedMessage["leases"],
  });
}

export function validateMutationLeaseSnapshot(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_FIELDS, issues, path);
  requiredString(value, "token", `${path}.token`, issues, { nonEmpty: true });
  validateMutationLeaseScope(value.scope, `${path}.scope`, issues);
  if ("owner" in value) {
    validateMutationLeaseOwner(value.owner, `${path}.owner`, issues);
  }
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "expiresAt", `${path}.expiresAt`, issues, { nonEmpty: true });
  requiredInteger(value, "ttlMs", `${path}.ttlMs`, issues, { min: 0 });
}

export function validateMutationLeaseScope(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  const type = requiredEnum(value, "type", `${path}.type`, ["workspace", "files"], issues);
  if (type === "workspace") {
    rejectUnknownFields(value, ["type"], issues, path);
    return;
  }

  rejectUnknownFields(value, ["type", "paths"], issues, path);
  const paths = requiredArray(value, "paths", `${path}.paths`, issues);
  paths?.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push({ path: `${path}.paths[${index}]`, message: "Expected non-empty string" });
    }
  });
}

export function validateMutationLeaseOwner(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, MUTATION_LEASE_OWNER_FIELDS, issues, path);
  if ("runId" in value) optionalString(value, "runId", `${path}.runId`, issues, { nonEmpty: true });
  if ("sessionId" in value) optionalString(value, "sessionId", `${path}.sessionId`, issues, { nonEmpty: true });
  if ("toolCallId" in value) optionalString(value, "toolCallId", `${path}.toolCallId`, issues, { nonEmpty: true });
  if ("toolName" in value) optionalString(value, "toolName", `${path}.toolName`, issues, { nonEmpty: true });
  if ("cwd" in value) optionalString(value, "cwd", `${path}.cwd`, issues, { nonEmpty: true });
  if ("targetSummary" in value) optionalString(value, "targetSummary", `${path}.targetSummary`, issues);
}
