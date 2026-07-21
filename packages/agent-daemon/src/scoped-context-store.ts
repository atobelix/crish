import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord, errorMessage, isNodeError, clone, isJsonObject, deepFreeze } from "@crish/shared-utils";
import { fsyncPathAsync } from "@crish/shared-utils/node";
import type {
  DaemonScopedContextDiagnostic,
  DaemonScopedContextStoreStatus,
  ScopedContextQueryResult,
  ScopedContextRecord,
} from "./types.js";

export const DAEMON_SCOPED_CONTEXT_STORE_VERSION = 1;

export interface ScopedContextStoreState {
  version: typeof DAEMON_SCOPED_CONTEXT_STORE_VERSION;
  records: ScopedContextRecord[];
}

export interface ScopedContextListFilter {
  scope?: ScopedContextRecord["scope"];
  kind?: ScopedContextRecord["kind"];
}

export interface ScopedContextWriteResult {
  status: DaemonScopedContextStoreStatus;
  persisted: boolean;
  diagnostic?: DaemonScopedContextDiagnostic;
}

export interface ScopedContextUpsertResult extends ScopedContextWriteResult {
  record: ScopedContextRecord;
}

export interface ScopedContextDeleteResult extends ScopedContextWriteResult {
  recordId: string;
  deleted: boolean;
}

export interface ScopedContextStore {
  list(filter?: ScopedContextListFilter): Promise<ScopedContextQueryResult>;
  upsert(record: ScopedContextRecord, now?: Date): Promise<ScopedContextUpsertResult>;
  delete(recordId: string): Promise<ScopedContextDeleteResult>;
}

export class FileScopedContextStore implements ScopedContextStore {
  private state?: ScopedContextStoreState;
  private diagnostic: DaemonScopedContextDiagnostic | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async list(filter: ScopedContextListFilter = {}): Promise<ScopedContextQueryResult> {
    const load = await this.readState();
    // state.records 在写入时已 deepFreeze；filter 产出新数组，items 仍为 frozen 引用，
    // 不必深拷贝每条 record。sort 操作发生在新生成的浅拷贝数组上，不影响 frozen state。
    const records = load.records
      .filter((record) => filter.scope === undefined || record.scope === filter.scope)
      .filter((record) => filter.kind === undefined || record.kind === filter.kind)
      .sort(compareRecords);
    return {
      status: load.diagnostic ? "degraded" : this.status,
      records,
      ...(load.diagnostic ?? this.diagnostic ? { diagnostic: load.diagnostic ?? this.diagnostic } : {}),
    };
  }

  async upsert(
    record: ScopedContextRecord,
    now: Date = new Date()
  ): Promise<ScopedContextUpsertResult> {
    const normalized = normalizeScopedContextRecord(record, now);
    const mutation = await this.mutate((state) => {
      const index = state.records.findIndex((item) => item.id === normalized.id);
      // structural sharing: 只创建新 records 数组与受影响元素，其余元素引用不变。
      // map/扩展均产出新数组，sort 在新数组上 in-place，不影响原 frozen state.records。
      const nextRecords =
        index >= 0
          ? state.records.map((item, i) => (i === index ? normalized : item))
          : [...state.records, normalized];
      nextRecords.sort(compareRecords);
      return {
        next: { ...state, records: nextRecords },
        result: normalized,
      };
    }, () => normalized);

    return {
      ...mutation,
      record: normalized,
    };
  }

  async delete(recordId: string): Promise<ScopedContextDeleteResult> {
    const id = normalizeText(recordId, "recordId");
    const mutation = await this.mutate((state) => {
      // filter 已是 structural sharing：产出新数组，保留的元素引用不变。
      const nextRecords = state.records.filter((record) => record.id !== id);
      return {
        next: { ...state, records: nextRecords },
        result: nextRecords.length !== state.records.length,
      };
    }, () => false);

    return {
      ...mutation,
      recordId: id,
      deleted: mutation.result,
    };
  }

  private get status(): DaemonScopedContextStoreStatus {
    return this.diagnostic ? "degraded" : "ok";
  }

  private async readState(): Promise<{
    records: ScopedContextRecord[];
    diagnostic?: DaemonScopedContextDiagnostic;
  }> {
    await this.pending;
    try {
      const state = await this.load();
      // state.records 是 frozen 数组引用；list() 会通过 filter 产出新的浅拷贝数组，
      // 这里直接返回 frozen 引用即可，避免每次读都做全 records 深拷贝。
      return { records: state.records, ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}) };
    } catch (error) {
      const diagnostic = this.recordDiagnostic(
        "SCOPED_CONTEXT_STORE_READ_FAILED",
        `Failed to read scoped context store: ${errorMessage(error)}`,
        error
      );
      return {
        records: [],
        diagnostic,
      };
    }
  }

  private async mutate<T>(
    operation: (state: ScopedContextStoreState) => { next: ScopedContextStoreState; result: T },
    loadFailedResult: () => T
  ): Promise<ScopedContextWriteResult & { result: T }> {
    const next = this.pending.then(async () => {
      let current: ScopedContextStoreState;
      try {
        current = await this.load();
      } catch (error) {
        const diagnostic = this.recordDiagnostic(
          "SCOPED_CONTEXT_STORE_READ_FAILED",
          `Failed to read scoped context store before mutation: ${errorMessage(error)}`,
          error
        );
        return {
          status: "degraded" as const,
          persisted: false,
          diagnostic,
          result: loadFailedResult(),
        };
      }
      // structural sharing: operation 产出新 state（受影响分支为新对象，其余引用不变）。
      // deepFreeze 幂等：已 frozen 的子树（来自 current）直接跳过，只冻结新创建的对象。
      // 即使 writeState 最终未 persisted，nextState 也只是被丢弃，提前 freeze 无副作用。
      const { next: nextState, result } = operation(current);
      deepFreeze(nextState);
      const writeResult = await this.writeState(nextState);
      if (writeResult.persisted) {
        this.state = nextState;
      }
      return { ...writeResult, result };
    });

    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async load(): Promise<ScopedContextStoreState> {
    if (this.state) return this.state;

    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.state = deepFreeze(emptyState());
        return this.state;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Scoped context store is not valid JSON: ${errorMessage(error)}`);
    }

    const issues = validateScopedContextStoreState(parsed);
    if (issues.length > 0) {
      throw new Error(`Scoped context store has invalid data: ${issues.join("; ")}`);
    }

    // JSON.parse 产出全新对象（无外部引用），可直接冻结作为不可变 state。
    this.state = deepFreeze(parsed as ScopedContextStoreState);
    this.diagnostic = undefined;
    return this.state;
  }

  private async writeState(state: ScopedContextStoreState): Promise<ScopedContextWriteResult> {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmpPath, serializeState(state), "utf8");
      const fileSyncDiagnostic = await fsyncPathDiagnostic(
        tmpPath,
        "SCOPED_CONTEXT_STORE_FILE_FSYNC_FAILED",
        "r+"
      );
      if (fileSyncDiagnostic) {
        await rm(tmpPath, { force: true }).catch(() => undefined);
        this.diagnostic = fileSyncDiagnostic;
        return { status: "degraded", persisted: false, diagnostic: fileSyncDiagnostic };
      }

      await rename(tmpPath, this.filePath);
      const dirSyncDiagnostic = await fsyncPathDiagnostic(
        dirname(this.filePath),
        "SCOPED_CONTEXT_STORE_DIR_FSYNC_FAILED"
      );
      this.diagnostic = dirSyncDiagnostic;
      return {
        status: dirSyncDiagnostic ? "degraded" : "ok",
        persisted: true,
        ...(dirSyncDiagnostic ? { diagnostic: dirSyncDiagnostic } : {}),
      };
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      const diagnostic = this.recordDiagnostic(
        "SCOPED_CONTEXT_STORE_WRITE_FAILED",
        `Failed to write scoped context store: ${errorMessage(error)}`,
        error
      );
      return { status: "degraded", persisted: false, diagnostic };
    }
  }

  private recordDiagnostic(
    code: string,
    message: string,
    error: unknown
  ): DaemonScopedContextDiagnostic {
    const diagnostic: DaemonScopedContextDiagnostic = {
      code,
      message,
      updatedAt: new Date().toISOString(),
      path: this.filePath,
      ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
    };
    this.diagnostic = diagnostic;
    return diagnostic;
  }
}

export function validateScopedContextStoreState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["$: Expected object"];

  rejectUnknownFields(value, ["version", "records"], "$", issues);
  if (value.version !== DAEMON_SCOPED_CONTEXT_STORE_VERSION) {
    issues.push(`$.version: Expected ${DAEMON_SCOPED_CONTEXT_STORE_VERSION}`);
  }
  if (!Array.isArray(value.records)) {
    issues.push("$.records: Expected array");
  } else {
    value.records.forEach((record, index) =>
      validateScopedContextRecord(record, `$.records[${index}]`, issues)
    );
    const ids = new Set<string>();
    for (const record of value.records) {
      if (!isRecord(record) || typeof record.id !== "string") continue;
      if (ids.has(record.id)) issues.push(`$.records: Duplicate record id ${record.id}`);
      ids.add(record.id);
    }
  }
  return issues;
}

export function validateScopedContextRecord(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  rejectUnknownFields(
    value,
    [
      "id",
      "kind",
      "title",
      "content",
      "description",
      "scope",
      "activation",
      "appliesTo",
      "tags",
      "source",
      "sourceMetadata",
      "order",
      "updatedAt",
    ],
    path,
    issues
  );
  requiredString(value, "id", `${path}.id`, issues);
  requiredEnum(value, "kind", `${path}.kind`, ["rule", "skill"], issues);
  requiredString(value, "title", `${path}.title`, issues);
  requiredString(value, "content", `${path}.content`, issues);
  optionalString(value, "description", `${path}.description`, issues);
  requiredEnum(value, "scope", `${path}.scope`, ["global", "project", "workspace"], issues);
  requiredEnum(value, "activation", `${path}.activation`, ["enabled", "recommended", "disabled"], issues);
  requiredStringArray(value, "appliesTo", `${path}.appliesTo`, issues);
  requiredStringArray(value, "tags", `${path}.tags`, issues);
  if ("source" in value) validateScopedContextSource(value.source, `${path}.source`, issues);
  if ("sourceMetadata" in value && !isJsonObject(value.sourceMetadata)) {
    issues.push(`${path}.sourceMetadata: Expected JSON object`);
  }
  if (typeof value.order !== "number" || !Number.isFinite(value.order)) {
    issues.push(`${path}.order: Expected finite number`);
  }
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues);
}

export function normalizeScopedContextRecord(
  record: ScopedContextRecord,
  now: Date = new Date()
): ScopedContextRecord {
  const issues: string[] = [];
  validateScopedContextRecord(record, "$.record", issues);
  if (issues.length > 0) {
    throw new Error(`Invalid scoped context record: ${issues.join("; ")}`);
  }
  return {
    id: normalizeText(record.id, "id"),
    kind: record.kind,
    title: normalizeText(record.title, "title"),
    content: normalizeText(record.content, "content"),
    ...(record.description !== undefined
      ? { description: normalizeText(record.description, "description") }
      : {}),
    scope: record.scope,
    activation: record.activation,
    appliesTo: normalizeList(record.appliesTo),
    tags: normalizeList(record.tags),
    ...(record.source ? { source: clone(record.source) } : {}),
    ...(record.sourceMetadata ? { sourceMetadata: clone(record.sourceMetadata) } : {}),
    order: record.order,
    updatedAt: now.toISOString(),
  };
}

function validateScopedContextSource(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }
  rejectUnknownFields(value, ["type", "path", "label"], path, issues);
  requiredEnum(
    value,
    "type",
    `${path}.type`,
    ["global-rule", "project-rule", "workspace-rule", "skill-file", "user", "system"],
    issues
  );
  optionalString(value, "path", `${path}.path`, issues);
  optionalString(value, "label", `${path}.label`, issues);
}

function emptyState(): ScopedContextStoreState {
  return {
    version: DAEMON_SCOPED_CONTEXT_STORE_VERSION,
    records: [],
  };
}

function compareRecords(left: ScopedContextRecord, right: ScopedContextRecord): number {
  return (
    left.order - right.order ||
    left.scope.localeCompare(right.scope) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

async function fsyncPathDiagnostic(
  path: string,
  code: string,
  mode: "r" | "r+" = "r"
): Promise<DaemonScopedContextDiagnostic | undefined> {
  try {
    await fsyncPathAsync(path, mode);
    return undefined;
  } catch (error) {
    return {
      code,
      message: `Failed to fsync scoped context store path ${path}: ${errorMessage(error)}`,
      updatedAt: new Date().toISOString(),
      path,
      ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
    };
  }
}

/**
 * 序列化 state 为写入文件的字符串。
 *
 * 默认紧凑输出（无缩进），减小文件体积与写入开销。
 * 设置环境变量 DEBUG_PRETTY_JSON=1 可切换为 2 空格缩进，便于调试时人工阅读。
 */
function serializeState(state: ScopedContextStoreState): string {
  return `${JSON.stringify(state)}\n`;
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

function requiredString(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!(key in input)) return;
  if (typeof input[key] !== "string" || input[key].length === 0) {
    issues.push(`${path}: Expected non-empty string`);
  }
}

function requiredEnum(
  input: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly string[],
  issues: string[]
): void {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "string" || !allowed.includes(input[key])) {
    issues.push(`${path}: Expected one of: ${allowed.join(", ")}`);
  }
}

function requiredStringArray(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!Array.isArray(input[key])) {
    issues.push(`${path}: Expected array`);
    return;
  }
  input[key].forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      issues.push(`${path}[${index}]: Expected non-empty string`);
    }
  });
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function normalizeList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}


