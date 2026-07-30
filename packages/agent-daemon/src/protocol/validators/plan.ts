// Protocol validators: plan message family
import { validatePlanDocument } from "@crish/agent-core";
import type {
  CreateRequirementsAlignmentPlanMessage,
  CreatePlanDocumentMessage,
  DeletePlanDocumentMessage,
  GetPlanDocumentMessage,
  ListPlanDocumentsMessage,
  PatchPlanDocumentMessage,
  PlanDocumentsListedMessage,
  PlanDocumentCreatedMessage,
  PlanDocumentMessage,
  PlanDocumentPatchedMessage,
  PlanDocumentDeletedMessage,
} from "../../types.js";
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from "./common.js";
import {
  CREATE_PLAN_DOCUMENT_FIELDS,
  CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS,
  DELETE_PLAN_DOCUMENT_FIELDS,
  EMPTY_COMMAND_FIELDS,
  GET_PLAN_DOCUMENT_FIELDS,
  PATCH_PLAN_DOCUMENT_FIELDS,
  PLAN_DOCUMENTS_LISTED_FIELDS,
  PLAN_DOCUMENT_DELETED_FIELDS,
  PLAN_DOCUMENT_MESSAGE_FIELDS,
  PLAN_DOCUMENT_SUMMARY_FIELDS,
  invalid,
  isRecord,
  ok,
  optionalArray,
  optionalEnum,
  optionalInteger,
  optionalJsonObject,
  optionalString,
  optionalStringArray,
  rejectUnknownFields,
  requiredArray,
  requiredInteger,
  requiredRecord,
  requiredString,
} from "./common.js";

export function validateListPlanDocumentsMessage(
  input: UnknownRecord
): ProtocolValidationResult<ListPlanDocumentsMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, EMPTY_COMMAND_FIELDS, issues);

  if (issues.length > 0) return invalid("Invalid list-plan-documents message", issues);

  return ok({ type: "list-plan-documents" });
}

export function validateCreatePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreatePlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_PLAN_DOCUMENT_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const title = requiredString(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString(input, "goal", "$.goal", issues, { nonEmpty: true });
  const assumptions = optionalArray(input, "assumptions", "$.assumptions", issues);
  const questions = optionalArray(input, "questions", "$.questions", issues);
  const steps = optionalArray(input, "steps", "$.steps", issues);
  const acceptance = optionalArray(input, "acceptance", "$.acceptance", issues);
  const risks = optionalArray(input, "risks", "$.risks", issues);
  const status = optionalString(input, "status", "$.status", issues, { nonEmpty: true });
  const version = optionalInteger(input, "version", "$.version", issues, { min: 1 });
  const createdAt = optionalString(input, "createdAt", "$.createdAt", issues, { nonEmpty: true });
  const updatedAt = optionalString(input, "updatedAt", "$.updatedAt", issues, { nonEmpty: true });
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) return invalid("Invalid create-plan-document message", issues);

  return ok({
    type: "create-plan-document" as const,
    ...(id !== undefined ? { id } : {}),
    title: title as string,
    goal: goal as string,
    ...(assumptions !== undefined ? { assumptions: assumptions as CreatePlanDocumentMessage["assumptions"] } : {}),
    ...(questions !== undefined ? { questions: questions as CreatePlanDocumentMessage["questions"] } : {}),
    ...(steps !== undefined ? { steps: steps as CreatePlanDocumentMessage["steps"] } : {}),
    ...(acceptance !== undefined ? { acceptance: acceptance as CreatePlanDocumentMessage["acceptance"] } : {}),
    ...(risks !== undefined ? { risks: risks as CreatePlanDocumentMessage["risks"] } : {}),
    ...(status !== undefined ? { status: status as CreatePlanDocumentMessage["status"] } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  } as CreatePlanDocumentMessage);
}

export function validateCreateRequirementsAlignmentPlanMessage(
  input: UnknownRecord
): ProtocolValidationResult<CreateRequirementsAlignmentPlanMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, CREATE_REQUIREMENTS_ALIGNMENT_PLAN_FIELDS, issues);

  const id = optionalString(input, "id", "$.id", issues, { nonEmpty: true });
  const title = optionalString(input, "title", "$.title", issues, { nonEmpty: true });
  const goal = requiredString(input, "goal", "$.goal", issues, { nonEmpty: true });
  const context = optionalString(input, "context", "$.context", issues, { nonEmpty: true });
  const questions = optionalStringArray(input, "questions", "$.questions", issues);
  const assumptions = optionalStringArray(input, "assumptions", "$.assumptions", issues);
  const acceptance = optionalStringArray(input, "acceptance", "$.acceptance", issues);
  const risks = optionalStringArray(input, "risks", "$.risks", issues);
  const source = optionalEnum(
    input,
    "source",
    "$.source",
    ["user", "assistant", "slash-command", "workflow", "system"] as const,
    issues
  );
  const metadata = optionalJsonObject(input, "metadata", "$.metadata", issues);

  if (issues.length > 0) {
    return invalid("Invalid create-requirements-alignment-plan message", issues);
  }

  return ok({
    type: "create-requirements-alignment-plan",
    ...(id !== undefined ? { id } : {}),
    ...(title !== undefined ? { title } : {}),
    goal: goal as string,
    ...(context !== undefined ? { context } : {}),
    ...(questions !== undefined ? { questions } : {}),
    ...(assumptions !== undefined ? { assumptions } : {}),
    ...(acceptance !== undefined ? { acceptance } : {}),
    ...(risks !== undefined ? { risks } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function validateGetPlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<GetPlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, GET_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid get-plan-document message", issues);

  return ok({ type: "get-plan-document", documentId: documentId as string });
}

export function validatePatchPlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<PatchPlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PATCH_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });
  const patch = requiredPlanDocumentPatch(input, "patch", "$.patch", issues);

  if (issues.length > 0) return invalid("Invalid patch-plan-document message", issues);

  return ok({
    type: "patch-plan-document",
    documentId: documentId as string,
    patch: patch as PatchPlanDocumentMessage["patch"],
  });
}

export function validateDeletePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<DeletePlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, DELETE_PLAN_DOCUMENT_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid delete-plan-document message", issues);

  return ok({ type: "delete-plan-document", documentId: documentId as string });
}

export function validatePlanDocumentsListedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentsListedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENTS_LISTED_FIELDS, issues);

  const documents = requiredArray(input, "documents", "$.documents", issues);
  documents?.forEach((document, index) =>
    validatePlanDocumentSummary(document, `$.documents[${index}]`, issues)
  );

  if (issues.length > 0) return invalid("Invalid plan-documents-listed message", issues);

  return ok({
    type: "plan-documents-listed",
    documents: documents as PlanDocumentsListedMessage["documents"],
  });
}

export function validatePlanDocumentCreatedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentCreatedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document-created message", issues);

  return ok({
    type: "plan-document-created",
    document: input.document as PlanDocumentCreatedMessage["document"],
  });
}

export function validatePlanDocumentMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document message", issues);

  return ok({
    type: "plan-document",
    document: input.document as PlanDocumentMessage["document"],
  });
}

export function validatePlanDocumentPatchedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentPatchedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_MESSAGE_FIELDS, issues);
  validatePlanDocumentPayload(input.document, "$.document", issues);

  if (issues.length > 0) return invalid("Invalid plan-document-patched message", issues);

  return ok({
    type: "plan-document-patched",
    document: input.document as PlanDocumentPatchedMessage["document"],
  });
}

export function validatePlanDocumentDeletedMessage(
  input: UnknownRecord
): ProtocolValidationResult<PlanDocumentDeletedMessage> {
  const issues: ProtocolValidationIssue[] = [];
  rejectUnknownFields(input, PLAN_DOCUMENT_DELETED_FIELDS, issues);
  const documentId = requiredString(input, "documentId", "$.documentId", issues, {
    nonEmpty: true,
  });

  if (issues.length > 0) return invalid("Invalid plan-document-deleted message", issues);

  return ok({
    type: "plan-document-deleted",
    documentId: documentId as string,
  });
}

export function validatePlanDocumentPayload(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  const validation = validatePlanDocument(value as unknown as Parameters<typeof validatePlanDocument>[0]);
  for (const error of validation.errors) {
    issues.push({ path, message: error });
  }
}

export function validatePlanDocumentSummary(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object" });
    return;
  }

  rejectUnknownFields(value, PLAN_DOCUMENT_SUMMARY_FIELDS, issues, path);
  requiredString(value, "id", `${path}.id`, issues, { nonEmpty: true });
  requiredString(value, "title", `${path}.title`, issues, { nonEmpty: true });
  requiredString(value, "goal", `${path}.goal`, issues, { nonEmpty: true });
  requiredString(value, "status", `${path}.status`, issues, { nonEmpty: true });
  requiredInteger(value, "version", `${path}.version`, issues, { min: 1 });
  requiredString(value, "createdAt", `${path}.createdAt`, issues, { nonEmpty: true });
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues, { nonEmpty: true });
  for (const field of ["steps", "questions", "assumptions", "acceptance", "risks"] as const) {
    if (!isRecord(value[field])) {
      issues.push({ path: `${path}.${field}`, message: "Expected object" });
    }
  }
}

export function requiredPlanDocumentPatch(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): PatchPlanDocumentMessage["patch"] | undefined {
  const patch = requiredRecord(input, key, path, issues);
  if (!patch) return undefined;

  rejectUnknownFields(patch, ["expectedVersion", "operations"], issues, path);
  optionalInteger(patch, "expectedVersion", `${path}.expectedVersion`, issues, { min: 1 });
  const operations = requiredArray(patch, "operations", `${path}.operations`, issues);
  operations?.forEach((operation, index) => {
    if (!isRecord(operation)) {
      issues.push({ path: `${path}.operations[${index}]`, message: "Expected object" });
      return;
    }
    requiredString(operation, "op", `${path}.operations[${index}].op`, issues, {
      nonEmpty: true,
    });
  });

  return patch as unknown as PatchPlanDocumentMessage["patch"];
}
