import type { JsonObject } from "@crish/shared-types";
import type { ResourceMetadata } from "../resource-uri";
import {
  PLAN_STEP_STATUSES,
  PLAN_QUESTION_STATUSES,
  PLAN_ASSUMPTION_STATUSES,
  PLAN_ACCEPTANCE_STATUSES,
  PLAN_RISK_STATUSES,
  PLAN_RISK_SEVERITIES,
  PLAN_DOCUMENT_RESOURCE_KIND,
  PLAN_DOCUMENT_SCHEMA_VERSION,
  PLAN_DOCUMENT_CONTENT_TYPE,
} from "./types";
import type {
  PlanDocument,
  PlanDocumentSummary,
  PlanItemSummary,
  PlanRisk,
  PlanRiskSeverity,
} from "./types";

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
