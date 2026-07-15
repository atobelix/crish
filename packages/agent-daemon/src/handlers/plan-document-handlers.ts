/**
 * Plan Document Handlers
 *
 * Extracted from DaemonRequestHandlers.
 */

import type { WebSocket } from "ws";
import { errorMessage, compactJsonObject } from "@crish/shared-utils";
import type {
  DaemonCorrelationFields,
  CreatePlanDocumentMessage,
  CreateRequirementsAlignmentPlanMessage,
  DeletePlanDocumentMessage,
  GetPlanDocumentMessage,
  ListPlanDocumentsMessage,
  PatchPlanDocumentMessage,
} from "../types.js";
import {
  PlanDocumentConflictError,
  PlanDocumentNotFoundError,
  PlanDocumentStoreError,
} from "../plan-document-store.js";
import type { PlanDocumentStore } from "../plan-document-store.js";
import type { DaemonMessageTransport } from "./workflow-handlers.js";
import { correlateResponse } from "./run-handlers.js";

// ─── Error dispatcher ──────────────────────────────────────

export function sendPlanDocumentStoreError(
  transport: DaemonMessageTransport,
  ws: WebSocket,
  error: unknown,
  correlation?: DaemonCorrelationFields
): void {
  if (error instanceof PlanDocumentNotFoundError) {
    transport.sendError(ws, error.code, error.message, undefined, correlation);
    return;
  }
  if (error instanceof PlanDocumentConflictError) {
    transport.sendError(ws, error.code, error.message, undefined, correlation);
    return;
  }
  if (error instanceof PlanDocumentStoreError) {
    const detail = error.issues.length > 0 ? `: ${error.issues.join("; ")}` : "";
    transport.sendError(ws, error.code, `${error.message}${detail}`, undefined, correlation);
    return;
  }

  transport.sendError(ws, "PLAN_DOCUMENT_ERROR", errorMessage(error), undefined, correlation);
}

// ─── Handler functions ─────────────────────────────────────

export async function handleListPlanDocuments(
  ws: WebSocket,
  msg: ListPlanDocumentsMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    const documents = await planDocumentStore.listPlanDocuments();
    transport.send(
      ws,
      correlateResponse({ type: "plan-documents-listed", documents }, msg)
    );
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

export async function handleCreatePlanDocument(
  ws: WebSocket,
  msg: CreatePlanDocumentMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    const document = await planDocumentStore.createPlanDocument({
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      title: msg.title,
      goal: msg.goal,
      ...(msg.assumptions !== undefined ? { assumptions: msg.assumptions } : {}),
      ...(msg.questions !== undefined ? { questions: msg.questions } : {}),
      ...(msg.steps !== undefined ? { steps: msg.steps } : {}),
      ...(msg.acceptance !== undefined ? { acceptance: msg.acceptance } : {}),
      ...(msg.risks !== undefined ? { risks: msg.risks } : {}),
      ...(msg.status !== undefined ? { status: msg.status } : {}),
      ...(msg.version !== undefined ? { version: msg.version } : {}),
      ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
      ...(msg.updatedAt !== undefined ? { updatedAt: msg.updatedAt } : {}),
      ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    });
    transport.send(ws, correlateResponse({ type: "plan-document-created", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

export async function handleCreateRequirementsAlignmentPlan(
  ws: WebSocket,
  msg: CreateRequirementsAlignmentPlanMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    const sourceKind = msg.source ?? "user";
    const document = await planDocumentStore.createPlanDocument({
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      title: msg.title ?? "Requirements alignment",
      goal: msg.goal,
      status: "aligning",
      questions: (msg.questions ?? []).map((question, index) => ({
        id: `question_${index + 1}`,
        question,
        status: "open",
        source: { kind: sourceKind },
      })),
      assumptions: (msg.assumptions ?? []).map((text, index) => ({
        id: `assumption_${index + 1}`,
        text,
        status: "proposed",
        source: { kind: sourceKind },
      })),
      acceptance: (msg.acceptance ?? []).map((text, index) => ({
        id: `acceptance_${index + 1}`,
        text,
        status: "pending",
        evidenceIds: [],
        source: { kind: sourceKind },
      })),
      risks: (msg.risks ?? []).map((title, index) => ({
        id: `risk_${index + 1}`,
        title,
        severity: "medium",
        status: "open",
        source: { kind: sourceKind },
      })),
      metadata: compactJsonObject({
        ...(msg.metadata ?? {}),
        mode: "requirements-alignment",
        source: sourceKind,
        context: msg.context,
      }),
    });
    transport.send(ws, correlateResponse({ type: "plan-document-created", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

export async function handleGetPlanDocument(
  ws: WebSocket,
  msg: GetPlanDocumentMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    const document = await planDocumentStore.getPlanDocument(msg.documentId);
    transport.send(ws, correlateResponse({ type: "plan-document", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

export async function handlePatchPlanDocument(
  ws: WebSocket,
  msg: PatchPlanDocumentMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    const document = await planDocumentStore.patchPlanDocument(
      msg.documentId,
      msg.patch
    );
    transport.send(ws, correlateResponse({ type: "plan-document-patched", document }, msg));
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}

export async function handleDeletePlanDocument(
  ws: WebSocket,
  msg: DeletePlanDocumentMessage & DaemonCorrelationFields,
  transport: DaemonMessageTransport,
  planDocumentStore: PlanDocumentStore
): Promise<void> {
  try {
    await planDocumentStore.deletePlanDocument(msg.documentId);
    transport.send(
      ws,
      correlateResponse({ type: "plan-document-deleted", documentId: msg.documentId }, msg)
    );
  } catch (error) {
    sendPlanDocumentStoreError(transport, ws, error, msg);
  }
}