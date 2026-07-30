import type { JsonObject } from "@crish/shared-types";

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
