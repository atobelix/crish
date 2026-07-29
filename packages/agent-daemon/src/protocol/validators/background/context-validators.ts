// Protocol validators: scoped context message family
import type {
  DeleteScopedContextMessage,
  GetScopedContextMessage,
  ResolveScopedContextMessage,
  ScopedContextDeletedMessage,
  ScopedContextResolvedMessage,
  ScopedContextResponseMessage,
  ScopedContextUpsertedMessage,
  UpsertScopedContextMessage,
} from "../../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "../common.js";
import {
  DELETE_SCOPED_CONTEXT_FIELDS,
  GET_SCOPED_CONTEXT_FIELDS,
  PROMPT_CONTEXT_BLOCK_FIELDS,
  PROMPT_CONTEXT_BLOCK_KINDS,
  RESOLVE_SCOPED_CONTEXT_FIELDS,
  SCOPED_CONTEXT_ACTIVATIONS,
  SCOPED_CONTEXT_CANDIDATE_FIELDS,
  SCOPED_CONTEXT_DELETED_FIELDS,
  SCOPED_CONTEXT_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_ITEM_FIELDS,
  SCOPED_CONTEXT_ITEM_STATUSES,
  SCOPED_CONTEXT_KINDS,
  SCOPED_CONTEXT_RECORD_FIELDS,
  SCOPED_CONTEXT_RESOLVED_FIELDS,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES,
  SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS,
  SCOPED_CONTEXT_RESPONSE_FIELDS,
  SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS,
  SCOPED_CONTEXT_SCOPES,
  SCOPED_CONTEXT_SOURCE_FIELDS,
  SCOPED_CONTEXT_SOURCE_TYPES,
  SCOPED_CONTEXT_STORE_STATUSES,
  SCOPED_CONTEXT_UPSERTED_FIELDS,
  UPSERT_SCOPED_CONTEXT_FIELDS,
  invalid,
  isJsonObject,
  isJsonValue,
  isRecord,
  ok,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredBoolean,
  requiredEnum,
  requiredInteger,
  requiredString,
  requiredStringArray,
} from "../common.js";

export function validateScopedContextRuntimeConfig(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS, issues, path);
  optionalStringArray(value, "userEnabledIds", `${path}.userEnabledIds`, issues);
  optionalStringArray(value, "userDisabledIds", `${path}.userDisabledIds`, issues);
  optionalBoolean(value, "includeRecommendationHints", `${path}.includeRecommendationHints`, issues);
  optionalBoolean(value, "includeAncestorContextFiles", `${path}.includeAncestorContextFiles`, issues);
  optionalBoolean(value, "includeProjectSkillDirs", `${path}.includeProjectSkillDirs`, issues);
  optionalBoolean(value, "includeWorkspaceSkillDirs", `${path}.includeWorkspaceSkillDirs`, issues);
  optionalBoolean(value, "includeGlobalSkillDirs", `${path}.includeGlobalSkillDirs`, issues);
  optionalStringArray(value, "globalSkillDirs", `${path}.globalSkillDirs`, issues);
  optionalStringArray(value, "workspaceSkillDirs", `${path}.workspaceSkillDirs`, issues);
  optionalStringArray(value, "projectSkillDirs", `${path}.projectSkillDirs`, issues);
  optionalStringArray(value, "globalRuleFiles", `${path}.globalRuleFiles`, issues);
  optionalStringArray(value, "workspaceRuleFiles", `${path}.workspaceRuleFiles`, issues);
  optionalStringArray(value, "projectRuleFiles", `${path}.projectRuleFiles`, issues);
  optionalStringArray(value, "globalRuleDirs", `${path}.globalRuleDirs`, issues);
  optionalStringArray(value, "workspaceRuleDirs", `${path}.workspaceRuleDirs`, issues);
  optionalStringArray(value, "projectRuleDirs", `${path}.projectRuleDirs`, issues);
}

export function validateGetScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_SCOPED_CONTEXT_FIELDS, issues);

  const scope = optionalEnum(input, "scope", "$.scope", SCOPED_CONTEXT_SCOPES, issues);
  const kind = optionalEnum(input, "kind", "$.kind", SCOPED_CONTEXT_KINDS, issues);

  if (issues.length > 0) return invalid("Invalid get-scoped-context message", issues);

  return ok({
    type: "get-scoped-context",
    ...(scope !== undefined ? { scope } : {}),
    ...(kind !== undefined ? { kind } : {}),
  });
}

export function validateUpsertScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<UpsertScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, UPSERT_SCOPED_CONTEXT_FIELDS, issues);
  validateScopedContextRecord(input.record, "$.record", issues);

  if (issues.length > 0) return invalid("Invalid upsert-scoped-context message", issues);

  return ok({
    type: "upsert-scoped-context",
    record: input.record as UpsertScopedContextMessage["record"],
  });
}

export function validateDeleteScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeleteScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_SCOPED_CONTEXT_FIELDS, issues);

  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-scoped-context message", issues);

  return ok({
    type: "delete-scoped-context",
    recordId: recordId as string,
  });
}

export function validateResolveScopedContextMessage(
  input: UnknownRecord
): ProtocolValidationResult<ResolveScopedContextMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, RESOLVE_SCOPED_CONTEXT_FIELDS, issues);

  const cwd = requiredString(input, "cwd", "$.cwd", issues, { nonEmpty: true });
  const workspaceRoot = optionalString(input, "workspaceRoot", "$.workspaceRoot", issues, {
    nonEmpty: true,
  });
  const projectRoot = optionalString(input, "projectRoot", "$.projectRoot", issues, {
    nonEmpty: true,
  });
  const projectMarkers = optionalStringArray(input, "projectMarkers", "$.projectMarkers", issues);
  const projectFiles = optionalStringArray(input, "projectFiles", "$.projectFiles", issues);
  const projectTags = optionalStringArray(input, "projectTags", "$.projectTags", issues);
  const packageNames = optionalStringArray(input, "packageNames", "$.packageNames", issues);
  const userEnabledIds = optionalStringArray(input, "userEnabledIds", "$.userEnabledIds", issues);
  const userDisabledIds = optionalStringArray(input, "userDisabledIds", "$.userDisabledIds", issues);
  if ("scopedContextConfig" in input) {
    validateScopedContextRuntimeConfig(input.scopedContextConfig, "$.scopedContextConfig", issues);
  }

  if (issues.length > 0) return invalid("Invalid resolve-scoped-context message", issues);

  return ok({
    type: "resolve-scoped-context",
    cwd: cwd as string,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(projectMarkers !== undefined ? { projectMarkers } : {}),
    ...(projectFiles !== undefined ? { projectFiles } : {}),
    ...(projectTags !== undefined ? { projectTags } : {}),
    ...(packageNames !== undefined ? { packageNames } : {}),
    ...(userEnabledIds !== undefined ? { userEnabledIds } : {}),
    ...(userDisabledIds !== undefined ? { userDisabledIds } : {}),
    ...("scopedContextConfig" in input
      ? { scopedContextConfig: input.scopedContextConfig as ResolveScopedContextMessage["scopedContextConfig"] }
      : {}),
  }) as unknown as ProtocolValidationResult<ResolveScopedContextMessage>;
}

export function validateScopedContextResponseMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResponseMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESPONSE_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const records = requiredArray(input, "records", "$.records", issues);
  records?.forEach((record, index) =>
    validateScopedContextRecord(record, `$.records[${index}]`, issues)
  );
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-response message", issues);

  return ok({
    type: "scoped-context-response",
    status: status as ScopedContextResponseMessage["status"],
    records: records as ScopedContextResponseMessage["records"],
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextResponseMessage["diagnostic"] } : {}),
  }) as unknown as ProtocolValidationResult<ScopedContextResponseMessage>;
}

export function validateScopedContextUpsertedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextUpsertedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_UPSERTED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  validateScopedContextRecord(input.record, "$.record", issues);
  const persisted = requiredBoolean(input, "persisted", "$.persisted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-upserted message", issues);

  return ok({
    type: "scoped-context-upserted",
    status: status as ScopedContextUpsertedMessage["status"],
    record: input.record as ScopedContextUpsertedMessage["record"],
    persisted: persisted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextUpsertedMessage["diagnostic"] } : {}),
  }) as unknown as ProtocolValidationResult<ScopedContextUpsertedMessage>;
}

export function validateScopedContextDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_DELETED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const recordId = requiredString(input, "recordId", "$.recordId", issues, {
    nonEmpty: true,
  });
  const deleted = requiredBoolean(input, "deleted", "$.deleted", issues);
  if ("diagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.diagnostic, "$.diagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-deleted message", issues);

  return ok({
    type: "scoped-context-deleted",
    status: status as ScopedContextDeletedMessage["status"],
    recordId: recordId as string,
    deleted: deleted as boolean,
    ...("diagnostic" in input ? { diagnostic: input.diagnostic as ScopedContextDeletedMessage["diagnostic"] } : {}),
  }) as unknown as ProtocolValidationResult<ScopedContextDeletedMessage>;
}

export function validateScopedContextResolvedMessage(
  input: UnknownRecord
): ProtocolValidationResult<ScopedContextResolvedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, SCOPED_CONTEXT_RESOLVED_FIELDS, issues);
  const status = requiredEnum(input, "status", "$.status", SCOPED_CONTEXT_STORE_STATUSES, issues);
  const stableContext = requiredArray(input, "stableContext", "$.stableContext", issues);
  stableContext?.forEach((block, index) =>
    validatePromptContextBlock(block, `$.stableContext[${index}]`, issues)
  );
  const recommended = requiredArray(input, "recommended", "$.recommended", issues);
  recommended?.forEach((candidate, index) =>
    validateScopedContextCandidate(candidate, `$.recommended[${index}]`, issues)
  );
  const items = requiredArray(input, "items", "$.items", issues);
  items?.forEach((item, index) =>
    validateScopedContextResolvedItem(item, `$.items[${index}]`, issues)
  );
  const diagnostics = requiredArray(input, "diagnostics", "$.diagnostics", issues);
  diagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResolverDiagnostic(diagnostic, `$.diagnostics[${index}]`, issues)
  );
  const stableContextHash = requiredString(input, "stableContextHash", "$.stableContextHash", issues, {
    nonEmpty: true,
  });
  const storeRecordCount = requiredInteger(input, "storeRecordCount", "$.storeRecordCount", issues, { min: 0 });
  const resourceRecordCount = requiredInteger(input, "resourceRecordCount", "$.resourceRecordCount", issues, { min: 0 });
  const resourceDiagnostics = requiredArray(input, "resourceDiagnostics", "$.resourceDiagnostics", issues);
  resourceDiagnostics?.forEach((diagnostic, index) =>
    validateScopedContextResourceDiagnostic(diagnostic, `$.resourceDiagnostics[${index}]`, issues)
  );
  if ("storeDiagnostic" in input) {
    validateScopedContextStoreDiagnostic(input.storeDiagnostic, "$.storeDiagnostic", issues);
  }

  if (issues.length > 0) return invalid("Invalid scoped-context-resolved message", issues);

  return ok({
    type: "scoped-context-resolved",
    status: status as ScopedContextResolvedMessage["status"],
    stableContext: stableContext as ScopedContextResolvedMessage["stableContext"],
    recommended: recommended as ScopedContextResolvedMessage["recommended"],
    items: items as ScopedContextResolvedMessage["items"],
    diagnostics: diagnostics as ScopedContextResolvedMessage["diagnostics"],
    stableContextHash: stableContextHash as string,
    storeRecordCount: storeRecordCount as number,
    resourceRecordCount: resourceRecordCount as number,
    resourceDiagnostics: resourceDiagnostics as ScopedContextResolvedMessage["resourceDiagnostics"],
    ...("storeDiagnostic" in input ? { storeDiagnostic: input.storeDiagnostic as ScopedContextResolvedMessage["storeDiagnostic"] } : {}),
  }) as unknown as ProtocolValidationResult<ScopedContextResolvedMessage>;
}

export function validateScopedContextRecord(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RECORD_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString(value, "content", `${path}.content`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject(value.sourceMetadata)) {
    issues.push({ path: `${path}.sourceMetadata`, message: "Expected JSON object" });
  }
  if ("order" in value) {
    optionalNumber(value, "order", `${path}.order`, issues);
  } else {
    issues.push({ path: `${path}.order`, message: "Required field is missing" });
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
}

export function validateScopedContextSource(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_SOURCE_FIELDS, issues, path);
  requiredEnum(value, "type", `${path}.type`, SCOPED_CONTEXT_SOURCE_TYPES, issues);
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
}

export function validateScopedContextStoreDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_DIAGNOSTIC_FIELDS, issues, path);
  requiredString(value, "code", `${path}.code`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  if ("path" in value) optionalString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  if ("detail" in value) optionalString(value, "detail", `${path}.detail`, issues);
}

export function validateScopedContextCandidate(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_CANDIDATE_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
}

export function validateScopedContextResolvedItem(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_ITEM_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, SCOPED_CONTEXT_KINDS, issues);
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  if ("description" in value) optionalString(value, "description", `${path}.description`, issues, { nonEmpty: true });
  requiredEnum(value, "scope", `${path}.scope`, SCOPED_CONTEXT_SCOPES, issues);
  requiredEnum(value, "activation", `${path}.activation`, SCOPED_CONTEXT_ACTIVATIONS, issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  requiredString(value, "reason", `${path}.reason`, issues, { nonEmpty: true });
  requiredEnum(value, "status", `${path}.status`, SCOPED_CONTEXT_ITEM_STATUSES, issues);
}

export function validateScopedContextResolverDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES, issues);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "code", `${path}.code`, SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES, issues);
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validateScopedContextResourceDiagnostic(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS, issues, path);
  requiredEnum(value, "severity", `${path}.severity`, ["warning"], issues);
  requiredString(value, "path", `${path}.path`, issues, { nonEmpty: true });
  requiredString(value, "message", `${path}.message`, issues, { nonEmpty: true });
}

export function validatePromptContextBlock(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PROMPT_CONTEXT_BLOCK_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredEnum(value, "kind", `${path}.kind`, PROMPT_CONTEXT_BLOCK_KINDS, issues);
  if ("label" in value) optionalString(value, "label", `${path}.label`, issues, { nonEmpty: true });
  if (!("content" in value)) {
    issues.push({ path: `${path}.content`, message: "Required field is missing" });
  } else if (!isJsonValue(value.content)) {
    issues.push({ path: `${path}.content`, message: "Expected JSON value" });
  }
}
