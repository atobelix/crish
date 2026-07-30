import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord, errorMessage, isNodeError, deepFreeze, deepEqual } from "@crish/shared-utils";
import { fsyncPathAsync, fsyncDirectoryPathAsync } from "@crish/shared-utils/node";
import { PlanDocumentPatchError, PlanDocumentValidationError, applyPlanDocumentPatch, createPlanDocument, summarizePlanDocument, validatePlanDocument } from "@crish/agent-core";
import type { CreatePlanDocumentInput, PlanDocument, PlanDocumentPatch, PlanDocumentSummary } from "@crish/agent-core";

export const PLAN_DOCUMENT_STORE_VERSION = 1;

/**
 * In-memory store state: holds full PlanDocument objects assembled from the
 * index file + per-document content files. Used internally by mutate/get.
 */
export interface PlanDocumentStoreState {
  version: typeof PLAN_DOCUMENT_STORE_VERSION;
  documents: PlanDocument[];
}

/**
 * Persisted index state: small file atomically rewritten on every mutation.
 * Stores PlanDocumentSummary entries sufficient for listPlanDocuments().
 * Full document content lives in per-id content files under contentDir.
 */
export interface PlanDocumentIndexState {
  version: typeof PLAN_DOCUMENT_STORE_VERSION;
  summaries: PlanDocumentSummary[];
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
  private indexState?: PlanDocumentIndexState;
  private readonly documentCache = new Map<string, PlanDocument>();
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {}

  async listPlanDocuments(): Promise<PlanDocumentSummary[]> {
    // listPlanDocuments only reads the small index file — no content file I/O.
    const index = await this.readIndex();
    return sortSummariesByCreatedAt(index.summaries);
  }

  async getPlanDocument(documentId: string): Promise<PlanDocument> {
    await this.pending;
    if (this.state) {
      const doc = this.state.documents.find((item) => item.id === documentId);
      if (doc) return doc;
    }
    const cached = this.documentCache.get(documentId);
    if (cached) return cached;

    const index = await this.loadIndex();
    const exists = index.summaries.some((summary) => summary.id === documentId);
    if (!exists) {
      throw new PlanDocumentNotFoundError(documentId);
    }

    const doc = await this.readDocumentFile(documentId);
    const frozen = deepFreeze(doc);
    this.documentCache.set(documentId, frozen);
    return frozen;
  }

  async createPlanDocument(input: CreatePlanDocumentInput): Promise<PlanDocument> {
    return this.mutate((state) => {
      const document = createPlanDocument(input);
      if (state.documents.some((item) => item.id === document.id)) {
        throw new PlanDocumentConflictError(`Plan document already exists: ${document.id}`);
      }
      state.documents.push(document);
      return document;
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
        return updated;
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

  /**
   * Content directory derived from the index file path.
   * e.g. "plan-documents.json" -> "plan-documents/"
   */
  private get contentDir(): string {
    const base = basename(this.filePath).replace(/\.[^.]+$/, "");
    return join(dirname(this.filePath), base);
  }

  private documentFilePath(documentId: string): string {
    return join(this.contentDir, `${documentId}.json`);
  }

  private async readIndex(): Promise<PlanDocumentIndexState> {
    await this.pending;
    return this.loadIndex();
  }

  private async mutate<T>(operation: (state: PlanDocumentStoreState) => T): Promise<T> {
    const next = this.pending.then(async () => {
      const current = await this.load();
      const previousState = this.state;
      const nextState = cloneState(current);
      const result = operation(nextState);
      // 不可变 store 模式：写入前递归冻结 nextState，使读方法可安全返回 frozen 引用。
      deepFreeze(nextState);
      await this.writeState(nextState, previousState);
      this.state = nextState;
      this.indexState = deepFreeze(indexFromState(nextState));

      // 同步更新缓存
      this.documentCache.clear();
      for (const doc of nextState.documents) {
        this.documentCache.set(doc.id, doc);
      }

      return result;
    });

    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async loadIndex(): Promise<PlanDocumentIndexState> {
    if (this.indexState) return this.indexState;

    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.indexState = deepFreeze(emptyIndexState());
        return this.indexState;
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

    // JSON.parse 产出全新对象（无外部引用），可直接冻结作为不可变 state。
    this.indexState = deepFreeze(parsed as PlanDocumentIndexState);
    return this.indexState;
  }

  private async load(): Promise<PlanDocumentStoreState> {
    if (this.state) return this.state;

    const index = await this.loadIndex();

    // 并行读取所有 content 文件（使用缓存，避免重复读取）
    const documents = await Promise.all(
      index.summaries.map(async (summary) => {
        let doc = this.documentCache.get(summary.id);
        if (!doc) {
          doc = await this.readDocumentFile(summary.id);
          doc = deepFreeze(doc);
          this.documentCache.set(summary.id, doc);
        }
        return doc;
      })
    );

    const state: PlanDocumentStoreState = {
      version: index.version,
      documents,
    };
    this.state = deepFreeze(state);
    return this.state;
  }

  private async readDocumentFile(documentId: string): Promise<PlanDocument> {
    const contentPath = this.documentFilePath(documentId);
    let text: string;
    try {
      text = await readFile(contentPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new PlanDocumentStoreReadError(
          contentPath,
          `Plan document content file missing for ${documentId}: ${contentPath}`
        );
      }
      throw new PlanDocumentStoreReadError(
        contentPath,
        `Failed to read plan document content ${contentPath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PlanDocumentStoreReadError(
        contentPath,
        `Plan document content ${contentPath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const validation = validatePlanDocument(parsed as PlanDocument);
    if (validation.errors.length > 0) {
      throw new PlanDocumentStoreReadError(
        contentPath,
        `Plan document content ${contentPath} has invalid data`,
        validation.errors
      );
    }

    return parsed as PlanDocument;
  }

  /**
   * Split-index write strategy:
   * 1. Write changed/new content files FIRST. If a crash occurs here, the old
   *    index remains valid (no dangling references to missing content).
   * 2. Write the index file (atomic rename). After this, new content is referenced.
   * 3. Delete removed content files (best-effort, after index no longer references them).
   */
  private async writeState(
    state: PlanDocumentStoreState,
    previous: PlanDocumentStoreState | undefined
  ): Promise<void> {
    const indexState = indexFromState(state);

    const previousDocs = new Map<string, PlanDocument>(
      (previous?.documents ?? []).map((doc) => [doc.id, doc])
    );
    const currentIds = new Set(state.documents.map((doc) => doc.id));

    // 1. Write changed/new content files before index update.
    for (const document of state.documents) {
      const prev = previousDocs.get(document.id);
      if (!prev || !deepEqual(prev, document)) {
        await this.writeDocumentFile(document);
      }
    }

    // 2. Write index file (atomic).
    await this.writeIndexFile(indexState);

    // 3. Delete removed content files (best-effort).
    for (const [id] of previousDocs) {
      if (!currentIds.has(id)) {
        await this.deleteDocumentFile(id);
      }
    }
  }

  private async atomicWriteJsonFile(targetPath: string, data: unknown): Promise<void> {
    const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      if (this.options.fsync !== false) {
        await fsyncPathAsync(tmpPath, "r+");
      }
      await rename(tmpPath, targetPath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        await fsyncDirectoryPathAsync(dirname(targetPath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new PlanDocumentStoreWriteError(targetPath, error);
    }
  }

  private async writeIndexFile(index: PlanDocumentIndexState): Promise<void> {
    await this.atomicWriteJsonFile(this.filePath, index);
  }

  private async writeDocumentFile(document: PlanDocument): Promise<void> {
    await this.atomicWriteJsonFile(this.documentFilePath(document.id), document);
  }

  private async deleteDocumentFile(documentId: string): Promise<void> {
    const contentPath = this.documentFilePath(documentId);
    try {
      await rm(contentPath, { force: true });
    } catch {
      // Best-effort: file doesn't exist or can't be deleted — ignore.
    }
  }
}

export function validatePlanDocumentStoreState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "summaries"], "$", issues);
  if (value.version !== PLAN_DOCUMENT_STORE_VERSION) {
    issues.push(`$.version: Expected ${PLAN_DOCUMENT_STORE_VERSION}`);
  }
  if (!Array.isArray(value.summaries)) {
    issues.push("$.summaries: Expected array");
  } else {
    const ids = new Set<string>();
    value.summaries.forEach((summary, index) => {
      if (!isRecord(summary)) {
        issues.push(`$.summaries[${index}]: Expected object`);
        return;
      }
      if (typeof summary.id !== "string" || summary.id.length === 0) {
        issues.push(`$.summaries[${index}].id: Expected non-empty string`);
      }
      if (typeof summary.version !== "number") {
        issues.push(`$.summaries[${index}].version: Expected number`);
      }
      if (typeof summary.createdAt !== "string") {
        issues.push(`$.summaries[${index}].createdAt: Expected string`);
      }
      if (typeof summary.updatedAt !== "string") {
        issues.push(`$.summaries[${index}].updatedAt: Expected string`);
      }
      if (typeof summary.id === "string" && summary.id.length > 0) {
        if (ids.has(summary.id)) {
          issues.push(`$.summaries: Duplicate plan document id ${summary.id}`);
        }
        ids.add(summary.id);
      }
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

function emptyIndexState(): PlanDocumentIndexState {
  return {
    version: PLAN_DOCUMENT_STORE_VERSION,
    summaries: [],
  };
}

function indexFromState(state: PlanDocumentStoreState): PlanDocumentIndexState {
  return {
    version: state.version,
    summaries: state.documents.map((document) => summarizePlanDocument(document)),
  };
}

// Schwartzian transform：先 map 抽出 sort key（预解析 Date.parse 一次/元素），
// 排序后还原。避免在 comparator 内每次比较重复 parse 同一字段。NaN（非法日期）
// 通过 `||` 短路落入 tie-breaker，与原 compareSummaries 行为一致。
function sortSummariesByCreatedAt(
  summaries: readonly PlanDocumentSummary[]
): PlanDocumentSummary[] {
  const withKey = summaries.map((summary) => ({
    summary,
    t: Date.parse(summary.createdAt),
  }));
  withKey.sort(
    (a, b) => a.t - b.t || a.summary.id.localeCompare(b.summary.id)
  );
  return withKey.map((entry) => entry.summary);
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

/**
 * Structural-sharing clone：仅浅拷贝顶层 state 与 documents 数组外壳，
 * 复用 frozen item 引用。
 *
 * 安全前提（已验证所有 mutate operation 满足）：
 *  - createPlanDocument 仅 push 新构造的 document
 *  - patchPlanDocument 通过 `arr[i] = applyPlanDocumentPatch(...)` 替换（返回新对象，
 *    从不就地修改既有 document）
 *  - deletePlanDocument 通过 `arr = arr.filter(...)` 替换数组引用
 * 因此既有 document 引用始终不被修改，可在前后 state 间共享。
 *
 * 收益：
 *  - 复杂度从 O(整棵 state 大小，含每条 document 的嵌套 steps) 降为 O(documents.length)
 *  - writeState 中 `deepEqual(prev, document)` 因 `a === b` 早退对未变更 document
 *    退化为 O(1)，与 split-index 写入策略协同：未变更 document 不重写 content 文件
 */
function cloneState(state: PlanDocumentStoreState): PlanDocumentStoreState {
  return {
    version: state.version,
    documents: [...state.documents],
  };
}
