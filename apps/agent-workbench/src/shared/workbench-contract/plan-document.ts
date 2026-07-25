import type { JsonObject } from "@crish/shared-types";

export type WorkbenchPlanDocumentStatus =
  | "draft"
  | "aligning"
  | "ready"
  | "in_progress"
  | "blocked"
  | "completed"
  | "archived";
export type WorkbenchPlanStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type WorkbenchPlanQuestionStatus = "open" | "answered" | "resolved" | "deferred";
export type WorkbenchPlanAssumptionStatus = "proposed" | "confirmed" | "rejected" | "deferred";
export type WorkbenchPlanAcceptanceStatus = "pending" | "met" | "failed" | "waived";
export type WorkbenchPlanRiskSeverity = "low" | "medium" | "high";
export type WorkbenchPlanRiskStatus = "open" | "mitigated" | "accepted";
export type WorkbenchPlanDocumentSourceKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "slash-command"
  | "artifact"
  | "resource"
  | "inferred"
  | (string & {});

export interface WorkbenchPlanDocumentSource {
  kind: WorkbenchPlanDocumentSourceKind;
  id?: string;
  label?: string;
  uri?: string;
  metadata?: JsonObject;
}

export interface WorkbenchPlanAssumption {
  id: string;
  text: string;
  status: WorkbenchPlanAssumptionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanQuestion {
  id: string;
  question: string;
  status: WorkbenchPlanQuestionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: WorkbenchPlanStepStatus;
  dependencies: string[];
  evidenceIds: string[];
  toolHints: string[];
  metadata?: JsonObject;
}

export interface WorkbenchPlanAcceptanceCriterion {
  id: string;
  text: string;
  status: WorkbenchPlanAcceptanceStatus;
  evidenceIds: string[];
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanRisk {
  id: string;
  title: string;
  detail?: string;
  severity: WorkbenchPlanRiskSeverity;
  status: WorkbenchPlanRiskStatus;
  mitigation?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanAssumptionInput {
  id?: string;
  text: string;
  status?: WorkbenchPlanAssumptionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanQuestionInput {
  id?: string;
  question: string;
  status?: WorkbenchPlanQuestionStatus;
  answer?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanStepInput {
  id?: string;
  title: string;
  detail?: string;
  status?: WorkbenchPlanStepStatus;
  dependencies?: string[];
  evidenceIds?: string[];
  toolHints?: string[];
  metadata?: JsonObject;
}

export interface WorkbenchPlanAcceptanceCriterionInput {
  id?: string;
  text: string;
  status?: WorkbenchPlanAcceptanceStatus;
  evidenceIds?: string[];
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchPlanRiskInput {
  id?: string;
  title: string;
  detail?: string;
  severity?: WorkbenchPlanRiskSeverity;
  status?: WorkbenchPlanRiskStatus;
  mitigation?: string;
  source?: WorkbenchPlanDocumentSource;
  metadata?: JsonObject;
}

export interface WorkbenchCreatePlanDocumentRequest {
  id?: string;
  title: string;
  goal: string;
  assumptions?: WorkbenchPlanAssumptionInput[];
  questions?: WorkbenchPlanQuestionInput[];
  steps?: WorkbenchPlanStepInput[];
  acceptance?: WorkbenchPlanAcceptanceCriterionInput[];
  risks?: WorkbenchPlanRiskInput[];
  status?: WorkbenchPlanDocumentStatus;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: JsonObject;
}

export interface WorkbenchCreateRequirementsAlignmentPlanRequest {
  id?: string;
  title?: string;
  goal: string;
  context?: string;
  questions?: string[];
  assumptions?: string[];
  acceptance?: string[];
  risks?: string[];
  source?: "user" | "assistant" | "slash-command" | "workflow" | "system";
  metadata?: JsonObject;
}

export type WorkbenchPlanStepUpdate = Partial<Omit<WorkbenchPlanStepInput, "id">>;
export type WorkbenchPlanQuestionUpdate = Partial<Omit<WorkbenchPlanQuestionInput, "id">>;
export type WorkbenchPlanAssumptionUpdate = Partial<Omit<WorkbenchPlanAssumptionInput, "id">>;
export type WorkbenchPlanAcceptanceCriterionUpdate = Partial<Omit<WorkbenchPlanAcceptanceCriterionInput, "id">>;
export type WorkbenchPlanRiskUpdate = Partial<Omit<WorkbenchPlanRiskInput, "id">>;

export type WorkbenchPlanDocumentPatchOperation =
  | { op: "set-title"; title: string }
  | { op: "set-goal"; goal: string }
  | { op: "set-status"; status: WorkbenchPlanDocumentStatus }
  | { op: "set-metadata"; metadata: JsonObject }
  | { op: "merge-metadata"; metadata: JsonObject }
  | { op: "add-step"; step: WorkbenchPlanStepInput; index?: number }
  | { op: "update-step"; id: string; update: WorkbenchPlanStepUpdate }
  | { op: "remove-step"; id: string }
  | { op: "add-question"; question: WorkbenchPlanQuestionInput; index?: number }
  | { op: "update-question"; id: string; update: WorkbenchPlanQuestionUpdate }
  | { op: "remove-question"; id: string }
  | { op: "add-assumption"; assumption: WorkbenchPlanAssumptionInput; index?: number }
  | { op: "update-assumption"; id: string; update: WorkbenchPlanAssumptionUpdate }
  | { op: "remove-assumption"; id: string }
  | { op: "add-acceptance"; acceptance: WorkbenchPlanAcceptanceCriterionInput; index?: number }
  | { op: "update-acceptance"; id: string; update: WorkbenchPlanAcceptanceCriterionUpdate }
  | { op: "remove-acceptance"; id: string }
  | { op: "add-risk"; risk: WorkbenchPlanRiskInput; index?: number }
  | { op: "update-risk"; id: string; update: WorkbenchPlanRiskUpdate }
  | { op: "remove-risk"; id: string };

export interface WorkbenchPlanItemSummary {
  id: string;
  title: string;
  status: string;
}

export interface WorkbenchPlanDocumentSummary {
  id: string;
  title: string;
  goal: string;
  status: WorkbenchPlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  steps: {
    total: number;
    byStatus: Record<WorkbenchPlanStepStatus, number>;
    next: WorkbenchPlanItemSummary[];
    blocked: WorkbenchPlanItemSummary[];
  };
  questions: {
    total: number;
    byStatus: Record<WorkbenchPlanQuestionStatus, number>;
    open: WorkbenchPlanItemSummary[];
  };
  assumptions: {
    total: number;
    byStatus: Record<WorkbenchPlanAssumptionStatus, number>;
    unresolved: WorkbenchPlanItemSummary[];
  };
  acceptance: {
    total: number;
    byStatus: Record<WorkbenchPlanAcceptanceStatus, number>;
  };
  risks: {
    total: number;
    bySeverity: Record<WorkbenchPlanRiskSeverity, number>;
    byStatus: Record<WorkbenchPlanRiskStatus, number>;
    open: WorkbenchPlanItemSummary[];
  };
}

export interface WorkbenchPlanDocument {
  id: string;
  title: string;
  goal: string;
  assumptions: WorkbenchPlanAssumption[];
  questions: WorkbenchPlanQuestion[];
  steps: WorkbenchPlanStep[];
  acceptance: WorkbenchPlanAcceptanceCriterion[];
  risks: WorkbenchPlanRisk[];
  status: WorkbenchPlanDocumentStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}


