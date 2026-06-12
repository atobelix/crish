import { createId, nowIso } from "./session";
import type { ResourceMetadata } from "./resource-uri";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";

export const PLAN_DOCUMENT_SCHEMA_VERSION = 1;
export const PLAN_DOCUMENT_RESOURCE_KIND = "plan-document";
export const PLAN_DOCUMENT_CONTENT_TYPE = "application/vnd.conex.plan-document+json";

export const PLAN_DOCUMENT_STATUSES = ["draft", "aligning", "ready", "in_progress", "blocked", "completed", "archived"] as const;
export const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed", "blocked", "skipped"] as const;
export const PLAN_QUESTION_STATUSES = ["open", "answered", "resolved", "deferred"] as const;
export const PLAN_ASSUMPTION_STATUSES = ["proposed", "confirmed", "rejected", "deferred"] as const;
export const PLAN_ACCEPTANCE_STATUSES = ["pending", "met", "failed", "waived"] as const;
export const PLAN_RISK_SEVERITIES = ["low", "medium", "high"] as const;
export const PLAN_RISK_STATUSES = ["open", "mitigated", "accepted"] as const;

export type PlanDocumentStatus = (typeof PLAN_DOCUMENT_STATUSES)[number];
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
export type PlanQuestionStatus = (typeof PLAN_QUESTION_STATUSES)[number];
export type PlanAssumptionStatus = (typeof PLAN_ASSUMPTION_STATUSES)[number];
export type PlanAcceptanceStatus = (typeof PLAN_ACCEPTANCE_STATUSES)[number];
export type PlanRiskSeverity = (typeof PLAN_RISK_SEVERITIES)[number];
export type PlanRiskStatus = (typeof PLAN_RISK_STATUSES)[number];

export type PlanDocumentSourceKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "slash-command"
  | "artifact"
  | "resource"
  | "inferred"
  | (string & {});

export interface PlanDocumentSource {
  kind: PlanDocumentSourceKind;
  id?: string;
  label?: string;
  uri?: string;
  metadata?: JsonObject;
}

export interface PlanAssumption {
  id: string;
  text: string;
  status: PlanAssumptionStatus;
  answer?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanQuestion {
  id: string;
  question: string;
  status: PlanQuestionStatus;
  answer?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
  dependencies: string[];
  evidenceIds: string[];
  toolHints: string[];
  metadata?: JsonObject;
}

export interface PlanAcceptanceCriterion {
  id: string;
  text: string;
  status: PlanAcceptanceStatus;
  evidenceIds: string[];
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanRisk {
  id: string;
  title: string;
  detail?: string;
  severity: PlanRiskSeverity;
  status: PlanRiskStatus;
  mitigation?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanDocument {
  id: string;
  title: string;
  goal: string;
  assumptions: PlanAssumption[];
  questions: PlanQuestion[];
  steps: PlanStep[];
  acceptance: PlanAcceptanceCriterion[];
  risks: PlanRisk[];
  status: PlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

export interface PlanAssumptionInput {
  id?: string;
  text: string;
  status?: PlanAssumptionStatus;
  answer?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanQuestionInput {
  id?: string;
  question: string;
  status?: PlanQuestionStatus;
  answer?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanStepInput {
  id?: string;
  title: string;
  detail?: string;
  status?: PlanStepStatus;
  dependencies?: string[];
  evidenceIds?: string[];
  toolHints?: string[];
  metadata?: JsonObject;
}

export interface PlanAcceptanceCriterionInput {
  id?: string;
  text: string;
  status?: PlanAcceptanceStatus;
  evidenceIds?: string[];
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface PlanRiskInput {
  id?: string;
  title: string;
  detail?: string;
  severity?: PlanRiskSeverity;
  status?: PlanRiskStatus;
  mitigation?: string;
  source?: PlanDocumentSource;
  metadata?: JsonObject;
}

export interface CreatePlanDocumentInput {
  id?: string;
  title: string;
  goal: string;
  assumptions?: PlanAssumptionInput[];
  questions?: PlanQuestionInput[];
  steps?: PlanStepInput[];
  acceptance?: PlanAcceptanceCriterionInput[];
  risks?: PlanRiskInput[];
  status?: PlanDocumentStatus;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: JsonObject;
}

export interface PlanDocumentUpdate {
  title?: string;
  goal?: string;
  assumptions?: PlanAssumptionInput[];
  questions?: PlanQuestionInput[];
  steps?: PlanStepInput[];
  acceptance?: PlanAcceptanceCriterionInput[];
  risks?: PlanRiskInput[];
  status?: PlanDocumentStatus;
  metadata?: JsonObject;
}

export interface PlanDocumentHelperOptions {
  now?: () => string;
  idFactory?: (prefix: string) => string;
}

export interface PlanDocumentPatch {
  expectedVersion?: number;
  operations: PlanDocumentPatchOperation[];
}

export type PlanStepUpdate = Partial<Omit<PlanStepInput, "id">>;
export type PlanQuestionUpdate = Partial<Omit<PlanQuestionInput, "id">>;
export type PlanAssumptionUpdate = Partial<Omit<PlanAssumptionInput, "id">>;
export type PlanAcceptanceCriterionUpdate = Partial<Omit<PlanAcceptanceCriterionInput, "id">>;
export type PlanRiskUpdate = Partial<Omit<PlanRiskInput, "id">>;

export type PlanDocumentPatchOperation =
  | { op: "set-title"; title: string }
  | { op: "set-goal"; goal: string }
  | { op: "set-status"; status: PlanDocumentStatus }
  | { op: "set-metadata"; metadata: JsonObject }
  | { op: "merge-metadata"; metadata: JsonObject }
  | { op: "add-step"; step: PlanStepInput; index?: number }
  | { op: "update-step"; id: string; update: PlanStepUpdate }
  | { op: "remove-step"; id: string }
  | { op: "add-question"; question: PlanQuestionInput; index?: number }
  | { op: "update-question"; id: string; update: PlanQuestionUpdate }
  | { op: "remove-question"; id: string }
  | { op: "add-assumption"; assumption: PlanAssumptionInput; index?: number }
  | { op: "update-assumption"; id: string; update: PlanAssumptionUpdate }
  | { op: "remove-assumption"; id: string }
  | { op: "add-acceptance"; acceptance: PlanAcceptanceCriterionInput; index?: number }
  | { op: "update-acceptance"; id: string; update: PlanAcceptanceCriterionUpdate }
  | { op: "remove-acceptance"; id: string }
  | { op: "add-risk"; risk: PlanRiskInput; index?: number }
  | { op: "update-risk"; id: string; update: PlanRiskUpdate }
  | { op: "remove-risk"; id: string };

export interface PlanDocumentValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PlanItemSummary {
  id: string;
  title: string;
  status: string;
}

export interface PlanDocumentSummary {
  id: string;
  title: string;
  goal: string;
  status: PlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  steps: {
    total: number;
    byStatus: Record<PlanStepStatus, number>;
    next: PlanItemSummary[];
    blocked: PlanItemSummary[];
  };
  questions: {
    total: number;
    byStatus: Record<PlanQuestionStatus, number>;
    open: PlanItemSummary[];
  };
  assumptions: {
    total: number;
    byStatus: Record<PlanAssumptionStatus, number>;
    unresolved: PlanItemSummary[];
  };
  acceptance: {
    total: number;
    byStatus: Record<PlanAcceptanceStatus, number>;
  };
  risks: {
    total: number;
    bySeverity: Record<PlanRiskSeverity, number>;
    byStatus: Record<PlanRiskStatus, number>;
    open: PlanItemSummary[];
  };
}

export class PlanDocumentValidationError extends Error {
  readonly kind = "plan-document-validation-error" as const;
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid plan document: ${errors.join("; ")}`);
    this.name = "PlanDocumentValidationError";
    this.errors = errors;
  }
}

export class PlanDocumentPatchError extends Error {
  readonly kind = "plan-document-patch-error" as const;
  readonly operationIndex?: number;

  constructor(message: string, operationIndex?: number) {
    super(message);
    this.name = "PlanDocumentPatchError";
    if (operationIndex !== undefined) this.operationIndex = operationIndex;
  }
}

export function createPlanDocument(input: CreatePlanDocumentInput, options: PlanDocumentHelperOptions = {}): PlanDocument {
  const now = options.now ?? nowIso;
  const idFactory = options.idFactory ?? createId;
  const createdAt = input.createdAt ?? now();
  const document: PlanDocument = {
    id: input.id ?? idFactory("plan"),
    title: input.title,
    goal: input.goal,
    assumptions: (input.assumptions ?? []).map((assumption) => normalizeAssumption(assumption, idFactory)),
    questions: (input.questions ?? []).map((question) => normalizeQuestion(question, idFactory)),
    steps: (input.steps ?? []).map((step) => normalizeStep(step, idFactory)),
    acceptance: (input.acceptance ?? []).map((acceptance) => normalizeAcceptance(acceptance, idFactory)),
    risks: (input.risks ?? []).map((risk) => normalizeRisk(risk, idFactory)),
    status: input.status ?? "draft",
    version: input.version ?? 1,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    metadata: cloneJsonObject(input.metadata)
  };

  assertValidPlanDocument(document);
  return document;
}

export function updatePlanDocument(
  document: PlanDocument,
  update: PlanDocumentUpdate,
  options: PlanDocumentHelperOptions = {}
): PlanDocument {
  const idFactory = options.idFactory ?? createId;
  const next: PlanDocument = clonePlanDocument(document);

  if (update.title !== undefined) next.title = update.title;
  if (update.goal !== undefined) next.goal = update.goal;
  if (update.status !== undefined) next.status = update.status;
  if (update.metadata !== undefined) next.metadata = cloneJsonObject(update.metadata);
  if (update.assumptions !== undefined) next.assumptions = update.assumptions.map((assumption) => normalizeAssumption(assumption, idFactory));
  if (update.questions !== undefined) next.questions = update.questions.map((question) => normalizeQuestion(question, idFactory));
  if (update.steps !== undefined) next.steps = update.steps.map((step) => normalizeStep(step, idFactory));
  if (update.acceptance !== undefined) next.acceptance = update.acceptance.map((acceptance) => normalizeAcceptance(acceptance, idFactory));
  if (update.risks !== undefined) next.risks = update.risks.map((risk) => normalizeRisk(risk, idFactory));

  return finalizeUpdatedDocument(next, document, options);
}

export function applyPlanDocumentPatch(
  document: PlanDocument,
  patch: PlanDocumentPatch | PlanDocumentPatchOperation[],
  options: PlanDocumentHelperOptions = {}
): PlanDocument {
  const idFactory = options.idFactory ?? createId;
  const operations = Array.isArray(patch) ? patch : patch.operations;
  const expectedVersion = Array.isArray(patch) ? undefined : patch.expectedVersion;

  if (expectedVersion !== undefined && expectedVersion !== document.version) {
    throw new PlanDocumentPatchError(`Plan document version mismatch: expected ${expectedVersion}, got ${document.version}`);
  }
  if (operations.length === 0) {
    throw new PlanDocumentPatchError("Plan document patch must include at least one operation");
  }

  let next = clonePlanDocument(document);
  operations.forEach((operation, index) => {
    try {
      next = applyPlanDocumentPatchOperation(next, operation, idFactory);
    } catch (cause) {
      if (cause instanceof PlanDocumentPatchError) {
        throw new PlanDocumentPatchError(cause.message, cause.operationIndex ?? index);
      }
      throw cause;
    }
  });

  return finalizeUpdatedDocument(next, document, options);
}

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

export function summarizePlanDocument(document: PlanDocument): PlanDocumentSummary {
  const nextSteps = document.steps
    .filter((step) => step.status === "pending" || step.status === "in_progress")
    .slice(0, 5)
    .map((step) => itemSummary(step.id, step.title, step.status));

  return {
    id: document.id,
    title: document.title,
    goal: document.goal,
    status: document.status,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    steps: {
      total: document.steps.length,
      byStatus: countByStatus(PLAN_STEP_STATUSES, document.steps),
      next: nextSteps,
      blocked: document.steps.filter((step) => step.status === "blocked").map((step) => itemSummary(step.id, step.title, step.status))
    },
    questions: {
      total: document.questions.length,
      byStatus: countByStatus(PLAN_QUESTION_STATUSES, document.questions),
      open: document.questions
        .filter((question) => question.status === "open")
        .map((question) => itemSummary(question.id, question.question, question.status))
    },
    assumptions: {
      total: document.assumptions.length,
      byStatus: countByStatus(PLAN_ASSUMPTION_STATUSES, document.assumptions),
      unresolved: document.assumptions
        .filter((assumption) => assumption.status === "proposed")
        .map((assumption) => itemSummary(assumption.id, assumption.text, assumption.status))
    },
    acceptance: {
      total: document.acceptance.length,
      byStatus: countByStatus(PLAN_ACCEPTANCE_STATUSES, document.acceptance)
    },
    risks: {
      total: document.risks.length,
      bySeverity: countBySeverity(document.risks),
      byStatus: countByStatus(PLAN_RISK_STATUSES, document.risks),
      open: document.risks.filter((risk) => risk.status === "open").map((risk) => itemSummary(risk.id, risk.title, risk.status))
    }
  };
}

export function planDocumentToMarkdown(document: PlanDocument): string {
  const lines: string[] = [
    `# ${document.title}`,
    "",
    `Status: ${document.status}`,
    `Version: ${document.version}`,
    `Updated: ${document.updatedAt}`,
    "",
    "## Goal",
    "",
    document.goal,
    "",
    "## Assumptions"
  ];

  appendAssumptionsMarkdown(lines, document.assumptions);
  lines.push("", "## Questions");
  appendQuestionsMarkdown(lines, document.questions);
  lines.push("", "## Steps");
  appendStepsMarkdown(lines, document.steps);
  lines.push("", "## Acceptance");
  appendAcceptanceMarkdown(lines, document.acceptance);
  lines.push("", "## Risks");
  appendRisksMarkdown(lines, document.risks);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function planDocumentToArtifactMetadata(document: PlanDocument): JsonObject {
  const summary = summarizePlanDocument(document);
  return {
    kind: PLAN_DOCUMENT_RESOURCE_KIND,
    schemaVersion: PLAN_DOCUMENT_SCHEMA_VERSION,
    contentType: PLAN_DOCUMENT_CONTENT_TYPE,
    planDocumentId: document.id,
    title: document.title,
    status: document.status,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    stepCount: summary.steps.total,
    stepStatusCounts: summary.steps.byStatus,
    questionCount: summary.questions.total,
    questionStatusCounts: summary.questions.byStatus,
    openQuestionIds: summary.questions.open.map((question) => question.id),
    assumptionCount: summary.assumptions.total,
    assumptionStatusCounts: summary.assumptions.byStatus,
    unresolvedAssumptionIds: summary.assumptions.unresolved.map((assumption) => assumption.id),
    acceptanceCount: summary.acceptance.total,
    riskCount: summary.risks.total,
    openRiskIds: summary.risks.open.map((risk) => risk.id),
    metadata: document.metadata
  };
}

export function planDocumentToResourceMetadata(document: PlanDocument, uri?: string): ResourceMetadata {
  const metadata = planDocumentToArtifactMetadata(document);
  const resource: ResourceMetadata = {
    kind: PLAN_DOCUMENT_RESOURCE_KIND,
    title: document.title,
    name: `${document.id}.plan.json`,
    contentType: PLAN_DOCUMENT_CONTENT_TYPE,
    mimeType: "application/json",
    metadata
  };
  if (uri !== undefined) resource.uri = uri;
  return resource;
}

function applyPlanDocumentPatchOperation(
  document: PlanDocument,
  operation: PlanDocumentPatchOperation,
  idFactory: (prefix: string) => string
): PlanDocument {
  const next = clonePlanDocument(document);

  switch (operation.op) {
    case "set-title":
      next.title = operation.title;
      return next;
    case "set-goal":
      next.goal = operation.goal;
      return next;
    case "set-status":
      next.status = operation.status;
      return next;
    case "set-metadata":
      next.metadata = cloneJsonObject(operation.metadata);
      return next;
    case "merge-metadata":
      next.metadata = { ...next.metadata, ...cloneJsonObject(operation.metadata) };
      return next;
    case "add-step":
      next.steps = insertItem(next.steps, normalizeStep(operation.step, idFactory), operation.index, "steps");
      return next;
    case "update-step":
      next.steps = updateItem(next.steps, operation.id, "steps", (step) => normalizeStep({ ...step, ...stripUndefined(operation.update), id: step.id }, idFactory));
      return next;
    case "remove-step":
      next.steps = removeItem(next.steps, operation.id, "steps");
      return next;
    case "add-question":
      next.questions = insertItem(next.questions, normalizeQuestion(operation.question, idFactory), operation.index, "questions");
      return next;
    case "update-question":
      next.questions = updateItem(next.questions, operation.id, "questions", (question) =>
        normalizeQuestion({ ...question, ...stripUndefined(operation.update), id: question.id }, idFactory)
      );
      return next;
    case "remove-question":
      next.questions = removeItem(next.questions, operation.id, "questions");
      return next;
    case "add-assumption":
      next.assumptions = insertItem(next.assumptions, normalizeAssumption(operation.assumption, idFactory), operation.index, "assumptions");
      return next;
    case "update-assumption":
      next.assumptions = updateItem(next.assumptions, operation.id, "assumptions", (assumption) =>
        normalizeAssumption({ ...assumption, ...stripUndefined(operation.update), id: assumption.id }, idFactory)
      );
      return next;
    case "remove-assumption":
      next.assumptions = removeItem(next.assumptions, operation.id, "assumptions");
      return next;
    case "add-acceptance":
      next.acceptance = insertItem(next.acceptance, normalizeAcceptance(operation.acceptance, idFactory), operation.index, "acceptance");
      return next;
    case "update-acceptance":
      next.acceptance = updateItem(next.acceptance, operation.id, "acceptance", (acceptance) =>
        normalizeAcceptance({ ...acceptance, ...stripUndefined(operation.update), id: acceptance.id }, idFactory)
      );
      return next;
    case "remove-acceptance":
      next.acceptance = removeItem(next.acceptance, operation.id, "acceptance");
      return next;
    case "add-risk":
      next.risks = insertItem(next.risks, normalizeRisk(operation.risk, idFactory), operation.index, "risks");
      return next;
    case "update-risk":
      next.risks = updateItem(next.risks, operation.id, "risks", (risk) =>
        normalizeRisk({ ...risk, ...stripUndefined(operation.update), id: risk.id }, idFactory)
      );
      return next;
    case "remove-risk":
      next.risks = removeItem(next.risks, operation.id, "risks");
      return next;
    default:
      return assertNever(operation);
  }
}

function finalizeUpdatedDocument(document: PlanDocument, previous: PlanDocument, options: PlanDocumentHelperOptions): PlanDocument {
  const next = clonePlanDocument(document);
  const now = options.now ?? nowIso;
  next.version = previous.version + 1;
  next.updatedAt = nextTimestampAfter(previous.updatedAt, now());
  assertValidPlanDocument(next);
  return next;
}

function normalizeAssumption(input: PlanAssumptionInput, idFactory: (prefix: string) => string): PlanAssumption {
  const assumption: PlanAssumption = {
    id: input.id ?? idFactory("assumption"),
    text: input.text,
    status: input.status ?? "proposed"
  };
  if (input.answer !== undefined) assumption.answer = input.answer;
  if (input.source !== undefined) assumption.source = cloneSource(input.source);
  if (input.metadata !== undefined) assumption.metadata = cloneJsonObject(input.metadata);
  return assumption;
}

function normalizeQuestion(input: PlanQuestionInput, idFactory: (prefix: string) => string): PlanQuestion {
  const question: PlanQuestion = {
    id: input.id ?? idFactory("question"),
    question: input.question,
    status: input.status ?? "open"
  };
  if (input.answer !== undefined) question.answer = input.answer;
  if (input.source !== undefined) question.source = cloneSource(input.source);
  if (input.metadata !== undefined) question.metadata = cloneJsonObject(input.metadata);
  return question;
}

function normalizeStep(input: PlanStepInput, idFactory: (prefix: string) => string): PlanStep {
  const step: PlanStep = {
    id: input.id ?? idFactory("step"),
    title: input.title,
    status: input.status ?? "pending",
    dependencies: [...(input.dependencies ?? [])],
    evidenceIds: [...(input.evidenceIds ?? [])],
    toolHints: [...(input.toolHints ?? [])]
  };
  if (input.detail !== undefined) step.detail = input.detail;
  if (input.metadata !== undefined) step.metadata = cloneJsonObject(input.metadata);
  return step;
}

function normalizeAcceptance(input: PlanAcceptanceCriterionInput, idFactory: (prefix: string) => string): PlanAcceptanceCriterion {
  const acceptance: PlanAcceptanceCriterion = {
    id: input.id ?? idFactory("acceptance"),
    text: input.text,
    status: input.status ?? "pending",
    evidenceIds: [...(input.evidenceIds ?? [])]
  };
  if (input.source !== undefined) acceptance.source = cloneSource(input.source);
  if (input.metadata !== undefined) acceptance.metadata = cloneJsonObject(input.metadata);
  return acceptance;
}

function normalizeRisk(input: PlanRiskInput, idFactory: (prefix: string) => string): PlanRisk {
  const risk: PlanRisk = {
    id: input.id ?? idFactory("risk"),
    title: input.title,
    severity: input.severity ?? "medium",
    status: input.status ?? "open"
  };
  if (input.detail !== undefined) risk.detail = input.detail;
  if (input.mitigation !== undefined) risk.mitigation = input.mitigation;
  if (input.source !== undefined) risk.source = cloneSource(input.source);
  if (input.metadata !== undefined) risk.metadata = cloneJsonObject(input.metadata);
  return risk;
}

function clonePlanDocument(document: PlanDocument): PlanDocument {
  return {
    id: document.id,
    title: document.title,
    goal: document.goal,
    assumptions: document.assumptions.map((assumption) => ({
      ...assumption,
      source: cloneSource(assumption.source),
      metadata: cloneOptionalJsonObject(assumption.metadata)
    })),
    questions: document.questions.map((question) => ({
      ...question,
      source: cloneSource(question.source),
      metadata: cloneOptionalJsonObject(question.metadata)
    })),
    steps: document.steps.map((step) => ({
      ...step,
      dependencies: [...step.dependencies],
      evidenceIds: [...step.evidenceIds],
      toolHints: [...step.toolHints],
      metadata: cloneOptionalJsonObject(step.metadata)
    })),
    acceptance: document.acceptance.map((acceptance) => ({
      ...acceptance,
      evidenceIds: [...acceptance.evidenceIds],
      source: cloneSource(acceptance.source),
      metadata: cloneOptionalJsonObject(acceptance.metadata)
    })),
    risks: document.risks.map((risk) => ({
      ...risk,
      source: cloneSource(risk.source),
      metadata: cloneOptionalJsonObject(risk.metadata)
    })),
    status: document.status,
    version: document.version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    metadata: cloneJsonObject(document.metadata)
  };
}

function cloneSource(source: PlanDocumentSource | undefined): PlanDocumentSource | undefined {
  if (!source) return undefined;
  const next: PlanDocumentSource = { kind: source.kind };
  if (source.id !== undefined) next.id = source.id;
  if (source.label !== undefined) next.label = source.label;
  if (source.uri !== undefined) next.uri = source.uri;
  if (source.metadata !== undefined) next.metadata = cloneJsonObject(source.metadata);
  return next;
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject {
  return value === undefined ? {} : (JSON.parse(JSON.stringify(value)) as JsonObject);
}

function cloneOptionalJsonObject(value: JsonObject | undefined): JsonObject | undefined {
  return value === undefined ? undefined : cloneJsonObject(value);
}

function assertValidPlanDocument(document: PlanDocument): void {
  const validation = validatePlanDocument(document);
  if (!validation.valid) {
    throw new PlanDocumentValidationError(validation.errors);
  }
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


function insertItem<T>(items: T[], item: T, index: number | undefined, label: string): T[] {
  if (index === undefined) return [...items, item];
  if (!Number.isInteger(index) || index < 0 || index > items.length) {
    throw new PlanDocumentPatchError(`${label} insert index out of range: ${index}`);
  }
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function updateItem<T extends { id: string }>(items: T[], id: string, label: string, update: (item: T) => T): T[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) {
    throw new PlanDocumentPatchError(`${label} item not found: ${id}`);
  }
  return items.map((item, itemIndex) => (itemIndex === index ? update(item) : item));
}

function removeItem<T extends { id: string }>(items: T[], id: string, label: string): T[] {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) {
    throw new PlanDocumentPatchError(`${label} item not found: ${id}`);
  }
  return next;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const next: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      next[key as keyof T] = entry as T[keyof T];
    }
  }
  return next;
}

function nextTimestampAfter(previous: string, candidate: string): string {
  const previousTime = Date.parse(previous);
  const candidateTime = Date.parse(candidate);
  if (Number.isNaN(previousTime) || Number.isNaN(candidateTime) || candidateTime > previousTime) {
    return candidate;
  }
  return new Date(previousTime + 1).toISOString();
}

function itemSummary(id: string, title: string, status: string): PlanItemSummary {
  return { id, title, status };
}

function countByStatus<TStatus extends string>(
  statuses: readonly TStatus[],
  items: readonly { status: TStatus }[]
): Record<TStatus, number> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<TStatus, number>;
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

function countBySeverity(risks: readonly PlanRisk[]): Record<PlanRiskSeverity, number> {
  const counts = Object.fromEntries(PLAN_RISK_SEVERITIES.map((severity) => [severity, 0])) as Record<PlanRiskSeverity, number>;
  for (const risk of risks) {
    counts[risk.severity] += 1;
  }
  return counts;
}

function appendAssumptionsMarkdown(lines: string[], assumptions: PlanAssumption[]): void {
  if (assumptions.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const assumption of assumptions) {
    lines.push(`- [${assumption.status}] ${assumption.text} (${assumption.id})`);
    appendAnswerAndSource(lines, assumption.answer, assumption.source);
  }
}

function appendQuestionsMarkdown(lines: string[], questions: PlanQuestion[]): void {
  if (questions.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const question of questions) {
    lines.push(`- [${question.status}] ${question.question} (${question.id})`);
    appendAnswerAndSource(lines, question.answer, question.source);
  }
}

function appendStepsMarkdown(lines: string[], steps: PlanStep[]): void {
  if (steps.length === 0) {
    lines.push("", "None.");
    return;
  }
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.status}] ${step.title} (${step.id})`);
    if (step.detail) lines.push(`   ${step.detail}`);
    if (step.dependencies.length > 0) lines.push(`   Dependencies: ${step.dependencies.join(", ")}`);
    if (step.evidenceIds.length > 0) lines.push(`   Evidence: ${step.evidenceIds.join(", ")}`);
    if (step.toolHints.length > 0) lines.push(`   Tool hints: ${step.toolHints.join(", ")}`);
  });
}

function appendAcceptanceMarkdown(lines: string[], acceptance: PlanAcceptanceCriterion[]): void {
  if (acceptance.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const criterion of acceptance) {
    lines.push(`- [${criterion.status}] ${criterion.text} (${criterion.id})`);
    if (criterion.evidenceIds.length > 0) lines.push(`  Evidence: ${criterion.evidenceIds.join(", ")}`);
    if (criterion.source) lines.push(`  Source: ${formatSource(criterion.source)}`);
  }
}

function appendRisksMarkdown(lines: string[], risks: PlanRisk[]): void {
  if (risks.length === 0) {
    lines.push("", "None.");
    return;
  }
  for (const risk of risks) {
    lines.push(`- [${risk.status}/${risk.severity}] ${risk.title} (${risk.id})`);
    if (risk.detail) lines.push(`  Detail: ${risk.detail}`);
    if (risk.mitigation) lines.push(`  Mitigation: ${risk.mitigation}`);
    if (risk.source) lines.push(`  Source: ${formatSource(risk.source)}`);
  }
}

function appendAnswerAndSource(lines: string[], answer: string | undefined, source: PlanDocumentSource | undefined): void {
  if (answer) lines.push(`  Answer: ${answer}`);
  if (source) lines.push(`  Source: ${formatSource(source)}`);
}

function formatSource(source: PlanDocumentSource): string {
  const details = [source.id, source.label, source.uri].filter((value): value is string => typeof value === "string" && value.length > 0);
  return details.length > 0 ? `${source.kind}:${details.join(":")}` : source.kind;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan document operation: ${JSON.stringify(value)}`);
}
