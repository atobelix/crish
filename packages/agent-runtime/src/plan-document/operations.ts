import type { JsonObject } from "@crish/shared-types";
import { createId, nowIso } from "../session";
import type {
  CreatePlanDocumentInput,
  PlanAssumption,
  PlanAssumptionInput,
  PlanQuestion,
  PlanQuestionInput,
  PlanStep,
  PlanStepInput,
  PlanAcceptanceCriterion,
  PlanAcceptanceCriterionInput,
  PlanRisk,
  PlanRiskInput,
  PlanDocument,
  PlanDocumentUpdate,
  PlanDocumentPatch,
  PlanDocumentPatchOperation,
  PlanDocumentHelperOptions,
  PlanDocumentSource,
} from "./types";
import { PlanDocumentPatchError, PlanDocumentValidationError } from "./types";
import { validatePlanDocument } from "./validation";

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
  if (input.source !== undefined) {
    const cloned = cloneSource(input.source);
    if (cloned !== undefined) assumption.source = cloned;
  }
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
  if (input.source !== undefined) {
    const cloned = cloneSource(input.source);
    if (cloned !== undefined) question.source = cloned;
  }
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
  if (input.source !== undefined) {
    const cloned = cloneSource(input.source);
    if (cloned !== undefined) acceptance.source = cloned;
  }
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
  if (input.source !== undefined) {
    const cloned = cloneSource(input.source);
    if (cloned !== undefined) risk.source = cloned;
  }
  if (input.metadata !== undefined) risk.metadata = cloneJsonObject(input.metadata);
  return risk;
}

function clonePlanDocument(document: PlanDocument): PlanDocument {
  return {
    id: document.id,
    title: document.title,
    goal: document.goal,
    assumptions: document.assumptions.map((assumption) => {
      const s = cloneSource(assumption.source);
      const m = cloneOptionalJsonObject(assumption.metadata);
      return {
        ...assumption,
        ...(s !== undefined ? { source: s } : {}),
        ...(m !== undefined ? { metadata: m } : {}),
      };
    }) as PlanAssumption[],
    questions: document.questions.map((question) => {
      const s = cloneSource(question.source);
      const m = cloneOptionalJsonObject(question.metadata);
      return {
        ...question,
        ...(s !== undefined ? { source: s } : {}),
        ...(m !== undefined ? { metadata: m } : {}),
      };
    }) as PlanQuestion[],
    steps: document.steps.map((step) => {
      const m = cloneOptionalJsonObject(step.metadata);
      return {
        ...step,
        dependencies: [...step.dependencies],
        evidenceIds: [...step.evidenceIds],
        toolHints: [...step.toolHints],
        ...(m !== undefined ? { metadata: m } : {}),
      };
    }) as PlanStep[],
    acceptance: document.acceptance.map((acceptance) => {
      const s = cloneSource(acceptance.source);
      const m = cloneOptionalJsonObject(acceptance.metadata);
      return {
        ...acceptance,
        evidenceIds: [...acceptance.evidenceIds],
        ...(s !== undefined ? { source: s } : {}),
        ...(m !== undefined ? { metadata: m } : {}),
      };
    }) as PlanAcceptanceCriterion[],
    risks: document.risks.map((risk) => {
      const s = cloneSource(risk.source);
      const m = cloneOptionalJsonObject(risk.metadata);
      return {
        ...risk,
        ...(s !== undefined ? { source: s } : {}),
        ...(m !== undefined ? { metadata: m } : {}),
      };
    }) as PlanRisk[],
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
  return value === undefined ? {} : structuredClone(value);
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

function assertNever(value: never): never {
  throw new Error(`Unhandled plan document operation: ${JSON.stringify(value)}`);
}
