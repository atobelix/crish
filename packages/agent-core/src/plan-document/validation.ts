import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";
import {
  PLAN_DOCUMENT_STATUSES,
  PLAN_STEP_STATUSES,
  PLAN_QUESTION_STATUSES,
  PLAN_ASSUMPTION_STATUSES,
  PLAN_ACCEPTANCE_STATUSES,
  PLAN_RISK_SEVERITIES,
  PLAN_RISK_STATUSES,
} from "./types";
import type {
  PlanDocument,
  PlanDocumentValidationResult,
  PlanDocumentSource,
  PlanStep,
} from "./types";

export function validatePlanDocument(document: PlanDocument): PlanDocumentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  requireNonEmptyString(document.id, "id", errors);
  requireNonEmptyString(document.title, "title", errors);
  requireNonEmptyString(document.goal, "goal", errors);
  requireAllowedValue(document.status, PLAN_DOCUMENT_STATUSES, "status", errors);
  if (!Number.isInteger(document.version) || document.version < 1) errors.push("version must be a positive integer");
  requireIsoTimestamp(document.createdAt, "createdAt", errors);
  requireIsoTimestamp(document.updatedAt, "updatedAt", errors);
  if (isIsoTimestamp(document.createdAt) && isIsoTimestamp(document.updatedAt) && Date.parse(document.updatedAt) < Date.parse(document.createdAt)) {
    errors.push("updatedAt must not be earlier than createdAt");
  }
  if (!isJsonObject(document.metadata)) errors.push("metadata must be a JSON object");

  validateArray(document.assumptions, "assumptions", errors, (assumption, index) => {
    requireNonEmptyString(assumption.id, `assumptions[${index}].id`, errors);
    requireNonEmptyString(assumption.text, `assumptions[${index}].text`, errors);
    requireAllowedValue(assumption.status, PLAN_ASSUMPTION_STATUSES, `assumptions[${index}].status`, errors);
    if ((assumption.status === "confirmed" || assumption.status === "rejected") && isBlank(assumption.answer)) {
      errors.push(`assumptions[${index}].answer must be set when status is ${assumption.status}`);
    }
    validateOptionalString(assumption.answer, `assumptions[${index}].answer`, errors);
    validateSource(assumption.source, `assumptions[${index}].source`, errors);
    validateOptionalJsonObject(assumption.metadata, `assumptions[${index}].metadata`, errors);
  });

  validateArray(document.questions, "questions", errors, (question, index) => {
    requireNonEmptyString(question.id, `questions[${index}].id`, errors);
    requireNonEmptyString(question.question, `questions[${index}].question`, errors);
    requireAllowedValue(question.status, PLAN_QUESTION_STATUSES, `questions[${index}].status`, errors);
    if ((question.status === "answered" || question.status === "resolved") && isBlank(question.answer)) {
      errors.push(`questions[${index}].answer must be set when status is ${question.status}`);
    }
    validateOptionalString(question.answer, `questions[${index}].answer`, errors);
    validateSource(question.source, `questions[${index}].source`, errors);
    validateOptionalJsonObject(question.metadata, `questions[${index}].metadata`, errors);
  });

  validateArray(document.steps, "steps", errors, (step, index) => {
    requireNonEmptyString(step.id, `steps[${index}].id`, errors);
    requireNonEmptyString(step.title, `steps[${index}].title`, errors);
    validateOptionalString(step.detail, `steps[${index}].detail`, errors);
    requireAllowedValue(step.status, PLAN_STEP_STATUSES, `steps[${index}].status`, errors);
    validateStringArray(step.dependencies, `steps[${index}].dependencies`, errors);
    validateStringArray(step.evidenceIds, `steps[${index}].evidenceIds`, errors);
    validateStringArray(step.toolHints, `steps[${index}].toolHints`, errors);
    validateOptionalJsonObject(step.metadata, `steps[${index}].metadata`, errors);
  });

  validateArray(document.acceptance, "acceptance", errors, (acceptance, index) => {
    requireNonEmptyString(acceptance.id, `acceptance[${index}].id`, errors);
    requireNonEmptyString(acceptance.text, `acceptance[${index}].text`, errors);
    requireAllowedValue(acceptance.status, PLAN_ACCEPTANCE_STATUSES, `acceptance[${index}].status`, errors);
    validateStringArray(acceptance.evidenceIds, `acceptance[${index}].evidenceIds`, errors);
    validateSource(acceptance.source, `acceptance[${index}].source`, errors);
    validateOptionalJsonObject(acceptance.metadata, `acceptance[${index}].metadata`, errors);
  });

  validateArray(document.risks, "risks", errors, (risk, index) => {
    requireNonEmptyString(risk.id, `risks[${index}].id`, errors);
    requireNonEmptyString(risk.title, `risks[${index}].title`, errors);
    validateOptionalString(risk.detail, `risks[${index}].detail`, errors);
    requireAllowedValue(risk.severity, PLAN_RISK_SEVERITIES, `risks[${index}].severity`, errors);
    requireAllowedValue(risk.status, PLAN_RISK_STATUSES, `risks[${index}].status`, errors);
    validateOptionalString(risk.mitigation, `risks[${index}].mitigation`, errors);
    validateSource(risk.source, `risks[${index}].source`, errors);
    validateOptionalJsonObject(risk.metadata, `risks[${index}].metadata`, errors);
  });

  validateUniqueIds(document.assumptions, "assumptions", errors);
  validateUniqueIds(document.questions, "questions", errors);
  validateUniqueIds(document.steps, "steps", errors);
  validateUniqueIds(document.acceptance, "acceptance", errors);
  validateUniqueIds(document.risks, "risks", errors);
  validateStepDependencies(document.steps, errors);

  if (document.status === "ready" && document.questions.some((question) => question.status === "open")) {
    warnings.push("ready plans still have open questions");
  }
  if (document.status === "completed" && document.steps.some((step) => step.status !== "completed" && step.status !== "skipped")) {
    warnings.push("completed plans still have unfinished steps");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function validateArray<T>(value: T[], label: string, errors: string[], validateItem: (item: T, index: number) => void): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return;
  }
  value.forEach(validateItem);
}

function validateUniqueIds(items: { id: string }[], label: string, errors: string[]): void {
  if (!Array.isArray(items)) return;
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string") continue;
    if (seen.has(item.id)) {
      errors.push(`${label} contains duplicate id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function validateStepDependencies(steps: PlanStep[], errors: string[]): void {
  if (!Array.isArray(steps)) return;
  const stepIds = new Set(steps.map((step) => step.id).filter((id) => typeof id === "string"));
  steps.forEach((step, index) => {
    if (!Array.isArray(step.dependencies)) return;
    for (const dependency of step.dependencies) {
      if (dependency === step.id) {
        errors.push(`steps[${index}].dependencies must not include its own id`);
      } else if (!stepIds.has(dependency)) {
        errors.push(`steps[${index}].dependencies references missing step: ${dependency}`);
      }
    }
  });
}

function validateSource(source: PlanDocumentSource | undefined, path: string, errors: string[]): void {
  if (source === undefined) return;
  if (!isRecord(source)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireNonEmptyString(source.kind, `${path}.kind`, errors);
  validateOptionalString(source.id, `${path}.id`, errors);
  validateOptionalString(source.label, `${path}.label`, errors);
  validateOptionalString(source.uri, `${path}.uri`, errors);
  validateOptionalJsonObject(source.metadata, `${path}.metadata`, errors);
}

function requireNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function validateOptionalString(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && typeof value !== "string") {
    errors.push(`${path} must be a string`);
  }
}

function validateStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    }
  });
}

function validateOptionalJsonObject(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && !isJsonObject(value)) {
    errors.push(`${path} must be a JSON object`);
  }
}

function requireAllowedValue<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: string[]): void {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${path} must be one of: ${allowed.join(", ")}`);
  }
}

function requireIsoTimestamp(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !isIsoTimestamp(value)) {
    errors.push(`${path} must be an ISO timestamp`);
  }
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
