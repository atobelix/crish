import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, errorMessage, fsyncPath, fsyncDirectoryPath, isNodeError, clone } from "@crish/shared-utils";
import {
  PlanDocumentPatchError,
  PlanDocumentValidationError,
  applyPlanDocumentPatch,
  createPlanDocument,
  summarizePlanDocument,
  validatePlanDocument,
  type CreatePlanDocumentInput,
  type PlanDocument,
  type PlanDocumentPatch,
  type PlanDocumentSummary,
} from "@crish/agent-runtime";

export const PLAN_DOCUMENT_STORE_VERSION = 1;

export interface PlanDocumentStoreState {
  version: typeof PLAN_DOCUMENT_STORE_VERSION;
  documents: PlanDocument[];
}

export interface PlanDocumentStore {
  listPlanDocuments(): Promise<PlanDocumentSummary[]>;
  getPlanDocument(documentId: string): Promise<PlanDocument>;
  createPlanDocument(input: CreatePlanDocumentInput): Promise<PlanDocument>;
  patchPlanDocument(documentId: string, patch: PlanDocumentPatch): Promise<PlanDocument>;
  deletePlanDocument(documentId: string): Promise<void>;
}

export class PlanDocumentStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly filePath?: string,
    readonly issues: string[] = []
  ) {
    super(message);
    this.name = "PlanDocumentStoreError";
  }
}

export class PlanDocumentStoreReadError extends PlanDocumentStoreError {
  constructor(filePath: string, message: string, issues: string[] = []) {
    super(message, "PLAN_DOCUMENT_STORE_READ_FAILED", filePath, issues);
    this.name = "PlanDocumentStoreReadError";
  }
}

export class PlanDocumentStoreWriteError extends PlanDocumentStoreError {
  constructor(filePath: string, cause: unknown) {
    super(
      `Failed to write plan document store ${filePath}: ${errorMessage(cause)}`,
      "PLAN_DOCUMENT_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "PlanDocumentStoreWriteError";
  }
}

export class PlanDocumentNotFoundError extends PlanDocumentStoreError {
  constructor(readonly documentId: string) {
    super(`Plan document not found: ${documentId}`, "PLAN_DOCUMENT_NOT_FOUND");
    this.name = "PlanDocumentNotFoundError";
  }
}

export class PlanDocumentConflictError extends PlanDocumentStoreError {
  constructor(message: string) {
    super(message, "PLAN_DOCUMENT_CONFLICT");
    this.name = "PlanDocumentConflictError";
  }
}

export class PlanDocumentStoreValidationError extends PlanDocumentStoreError {
  constructor(message: string, issues: string[]) {
    super(message, "PLAN_DOCUMENT_VALIDATION_FAILED", undefined, issues);
    this.name = "PlanDocumentStoreValidationError";
  }
}

export class FilePlanDocumentStore implements PlanDocumentStore {
  private state?: PlanDocumentStoreState;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {}

  async listPlanDocuments(): Promise<PlanDocumentSummary[]> {
    const state = await this.readState();
    return cloneState(state)
      .documents.map((document) => summarizePlanDocument(document))
      .sort(compareSummaries);
  }

  async getPlanDocument(documentId: string): Promise<PlanDocument> {
    const state = await this.readState();
    const document = state.documents.find((item) => item.id === documentId);
    if (!document) {
      throw new PlanDocumentNotFoundError(documentId);
    }
    return clone(document);
  }

  async createPlanDocument(input: CreatePlanDocumentInput): Promise<PlanDocument> {
    return this.mutate((state) => {
      const document = createPlanDocument(input);
      if (state.documents.some((item) => item.id === document.id)) {
        throw new PlanDocumentConflictError(`Plan document already exists: ${document.id}`);
      }
      state.documents.push(document);
      return clone(document);
    });
  }

  async patchPlanDocument(documentId: string, patch: PlanDocumentPatch): Promise<PlanDocument> {
    return this.mutate((state) => {
      const index = state.documents.findIndex((document) => document.id === documentId);
      if (index === -1) {
        throw new PlanDocumentNotFoundError(documentId);
      }

      try {
        const updated = applyPlanDocumentPatch(state.documents[index]!, patch);
        state.documents[index] = updated;
        return clone(updated);
      } catch (error) {
        if (error instanceof PlanDocumentPatchError && error.message.includes("version mismatch")) {
          throw new PlanDocumentConflictError(error.message);
        }
        if (error instanceof PlanDocumentPatchError || error instanceof PlanDocumentValidationError) {
          throw new PlanDocumentStoreValidationError(error.message, readRuntimeValidationIssues(error));
        }
        throw error;
      }
    });
  }

  async deletePlanDocument(documentId: string): Promise<void> {
    await this.mutate((state) => {
      const before = state.documents.length;
      state.documents = state.documents.filter((document) => document.id !== documentId);
      if (state.documents.length === before) {
        throw new PlanDocumentNotFoundError(documentId);
      }
    });
  }

  private async readState(): Promise<PlanDocumentStoreState> {
    await this.pending;
    return this.load();
  }

  private async mutate<T>(operation: (state: PlanDocumentStoreState) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const nextState = cloneState(current);
      const result = operation(nextState);
      await this.writeState(nextState);
      this.state = nextState;
      return result;
    });

    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async load(): Promise<PlanDocumentStoreState> {
    if (this.state) return this.state;

    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.state = emptyState();
        return this.state;
      }
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Failed to read plan document store ${this.filePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Plan document store ${this.filePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validatePlanDocumentStoreState(parsed);
    if (issues.length > 0) {
      throw new PlanDocumentStoreReadError(
        this.filePath,
        `Plan document store ${this.filePath} has invalid data`,
        issues
      );
    }

    this.state = clone(parsed as PlanDocumentStoreState);
    return this.state;
  }

  private async writeState(state: PlanDocumentStoreState): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      if (this.options.fsync !== false) {
        fsyncPath(tmpPath, "r+");
      }
      await rename(tmpPath, this.filePath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        fsyncDirectoryPath(dirname(this.filePath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new PlanDocumentStoreWriteError(this.filePath, error);
    }
  }
}

export function validatePlanDocumentStoreState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "documents"], "$", issues);
  if (value.version !== PLAN_DOCUMENT_STORE_VERSION) {
    issues.push(`$.version: Expected ${PLAN_DOCUMENT_STORE_VERSION}`);
  }
  if (!Array.isArray(value.documents)) {
    issues.push("$.documents: Expected array");
  } else {
    const ids = new Set<string>();
    value.documents.forEach((document, index) => {
      const validation = validatePlanDocument(document as PlanDocument);
      for (const issue of validation.errors) {
        issues.push(`$.documents[${index}]: ${issue}`);
      }
      if (!isRecord(document) || typeof document.id !== "string") return;
      if (ids.has(document.id)) {
        issues.push(`$.documents: Duplicate plan document id ${document.id}`);
      }
      ids.add(document.id);
    });
  }

  return issues;
}

function readRuntimeValidationIssues(error: PlanDocumentPatchError | PlanDocumentValidationError): string[] {
  if (error instanceof PlanDocumentValidationError) {
    return error.errors;
  }
  return [error.message];
}

function emptyState(): PlanDocumentStoreState {
  return {
    version: PLAN_DOCUMENT_STORE_VERSION,
    documents: [],
  };
}

function compareSummaries(left: PlanDocumentSummary, right: PlanDocumentSummary): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

function rejectUnknownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[]
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}.${key}: Unexpected field`);
    }
  }
}



function cloneState(state: PlanDocumentStoreState): PlanDocumentStoreState {
  return clone(state);
}


