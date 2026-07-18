import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { SessionAction } from "@crish/shared-types";
import { isRecord, errorMessage, fsyncPathAsync, fsyncDirectoryPathAsync, isNodeError, clone, compactJsonObject, isJsonObject, deepFreeze, deepEqual } from "@crish/shared-utils";


export const SESSION_METADATA_STORE_VERSION = 1;

export interface SessionMetadataRecord {
  sessionId: string;
  title?: string;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  source: SessionMetadataSource;
}

export interface SessionMetadataSource {
  actionId: string;
  actionKind: SessionAction["kind"];
  requestedAt: string;
  requestedBy: SessionAction["requestedBy"];
  idempotencyKey?: string;
  metadata?: JsonObject;
}

export interface SessionMetadataStoreState {
  version: typeof SESSION_METADATA_STORE_VERSION;
  sessions: SessionMetadataRecord[];
}

export interface SessionMetadataMutationResult {
  record: SessionMetadataRecord;
  changed: boolean;
}

export type SessionMetadataPatch =
  | { kind: "pin"; pinned: boolean }
  | { kind: "rename"; title: string }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete"; deleted: true };

export class SessionMetadataStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly filePath?: string,
    readonly issues: string[] = []
  ) {
    super(message);
    this.name = "SessionMetadataStoreError";
  }
}

export class SessionMetadataStoreReadError extends SessionMetadataStoreError {
  constructor(filePath: string, message: string, issues: string[] = []) {
    super(message, "SESSION_METADATA_STORE_READ_FAILED", filePath, issues);
    this.name = "SessionMetadataStoreReadError";
  }
}

export class SessionMetadataStoreWriteError extends SessionMetadataStoreError {
  constructor(filePath: string, cause: unknown) {
    super(
      `Failed to write session metadata store ${filePath}: ${errorMessage(cause)}`,
      "SESSION_METADATA_STORE_WRITE_FAILED",
      filePath
    );
    this.name = "SessionMetadataStoreWriteError";
  }
}

export class FileSessionMetadataStore {
  private state?: SessionMetadataStoreState;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly options: { fsync?: boolean; fsyncDirectory?: boolean | "best-effort" } = {}
  ) {}

  async list(): Promise<SessionMetadataRecord[]> {
    const state = await this.readState();
    // state.sessions 是 frozen 数组；返回一个浅拷贝数组（items 仍为 frozen 引用），
    // 以保持按 sessionId 排序的对外契约，而不必深拷贝每条 record。
    return [...state.sessions].sort(compareRecords);
  }

  async get(sessionId: string): Promise<SessionMetadataRecord | undefined> {
    const state = await this.readState();
    // 直接返回 frozen 引用：state 在写入时已 deepFreeze，调用方无法 mutate。
    return state.sessions.find((item) => item.sessionId === sessionId);
  }

  async applyAction(
    action: SessionAction,
    patch: SessionMetadataPatch,
    now: Date = new Date()
  ): Promise<SessionMetadataMutationResult> {
    return this.mutate((state) => {
      const timestamp = now.toISOString();
      const index = state.sessions.findIndex((record) => record.sessionId === action.sessionId);
      const previous = index === -1 ? undefined : state.sessions[index]!;
      const source = sourceFromAction(action);
      const current: SessionMetadataRecord =
        previous ??
        {
          sessionId: action.sessionId,
          pinned: false,
          archived: false,
          deleted: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          source,
        };

      const updated = applyPatch(current, patch, timestamp, source);
      assertSessionMetadataRecord(updated, "$.session");
      // structural sharing: 只创建新 sessions 数组与受影响元素，其余 session 引用不变。
      const nextSessions =
        index === -1
          ? [...state.sessions, updated]
          : state.sessions.map((item, i) => (i === index ? updated : item));

      return {
        next: { ...state, sessions: nextSessions },
        result: {
          record: updated,
          changed: !previous || !recordsEqual(previous, updated),
        },
      };
    });
  }

  private async readState(): Promise<SessionMetadataStoreState> {
    await this.pending;
    return this.load();
  }

  private async mutate<T>(
    operation: (state: SessionMetadataStoreState) => { next: SessionMetadataStoreState; result: T }
  ): Promise<T> {
    const next = this.pending.then(async () => {
      const current = await this.load();
      // structural sharing: operation 产出新 state（受影响分支为新对象，其余引用不变）。
      // deepFreeze 幂等：已 frozen 的子树（来自 current）直接跳过，只冻结新创建的对象。
      const { next: nextState, result } = operation(current);
      deepFreeze(nextState);
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

  private async load(): Promise<SessionMetadataStoreState> {
    if (this.state) return this.state;

    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.state = deepFreeze(emptyState());
        return this.state;
      }
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Failed to read session metadata store ${this.filePath}: ${errorMessage(error)}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Session metadata store ${this.filePath} is not valid JSON: ${errorMessage(error)}`
      );
    }

    const issues = validateSessionMetadataStoreState(parsed);
    if (issues.length > 0) {
      throw new SessionMetadataStoreReadError(
        this.filePath,
        `Session metadata store ${this.filePath} has invalid data`,
        issues
      );
    }

    // JSON.parse 产出全新对象（无外部引用），可直接冻结作为不可变 state。
    this.state = deepFreeze(parsed as SessionMetadataStoreState);
    return this.state;
  }

  private async writeState(state: SessionMetadataStoreState): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmpPath, serializeState(state), "utf8");
      if (this.options.fsync !== false) {
        await fsyncPathAsync(tmpPath, "r+");
      }
      await rename(tmpPath, this.filePath);
      if (this.options.fsync !== false && this.options.fsyncDirectory !== false) {
        const dirFsyncMode = this.options.fsyncDirectory === true ? "strict" : "best-effort";
        await fsyncDirectoryPathAsync(dirname(this.filePath), dirFsyncMode);
      }
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new SessionMetadataStoreWriteError(this.filePath, error);
    }
  }
}

export function validateSessionMetadataStoreState(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return ["$: Expected object"];
  }

  rejectUnknownFields(value, ["version", "sessions"], "$", issues);
  if (value.version !== SESSION_METADATA_STORE_VERSION) {
    issues.push(`$.version: Expected ${SESSION_METADATA_STORE_VERSION}`);
  }
  if (!Array.isArray(value.sessions)) {
    issues.push("$.sessions: Expected array");
  } else {
    const ids = new Set<string>();
    value.sessions.forEach((record, index) => {
      validateSessionMetadataRecord(record, `$.sessions[${index}]`, issues);
      if (!isRecord(record) || typeof record.sessionId !== "string") return;
      if (ids.has(record.sessionId)) {
        issues.push(`$.sessions: Duplicate session id ${record.sessionId}`);
      }
      ids.add(record.sessionId);
    });
  }

  return issues;
}

function validateSessionMetadataRecord(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  rejectUnknownFields(value, ["sessionId", "title", "pinned", "archived", "deleted", "createdAt", "updatedAt", "source"], path, issues);
  requiredString(value, "sessionId", `${path}.sessionId`, issues);
  if ("title" in value && typeof value.title !== "string") {
    issues.push(`${path}.title: Expected string`);
  }
  requiredBoolean(value, "pinned", `${path}.pinned`, issues);
  requiredBoolean(value, "archived", `${path}.archived`, issues);
  requiredBoolean(value, "deleted", `${path}.deleted`, issues);
  requiredString(value, "createdAt", `${path}.createdAt`, issues);
  requiredString(value, "updatedAt", `${path}.updatedAt`, issues);
  validateSource(value.source, `${path}.source`, issues);
}

function assertSessionMetadataRecord(value: SessionMetadataRecord, path: string): void {
  const issues: string[] = [];
  validateSessionMetadataRecord(value, path, issues);
  if (issues.length > 0) {
    throw new SessionMetadataStoreError(
      `Invalid session metadata record: ${issues.join("; ")}`,
      "SESSION_METADATA_STORE_VALIDATION_FAILED",
      undefined,
      issues
    );
  }
}

function validateSource(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path}: Expected object`);
    return;
  }

  rejectUnknownFields(value, ["actionId", "actionKind", "requestedAt", "requestedBy", "idempotencyKey", "metadata"], path, issues);
  requiredString(value, "actionId", `${path}.actionId`, issues);
  requiredString(value, "actionKind", `${path}.actionKind`, issues);
  requiredString(value, "requestedAt", `${path}.requestedAt`, issues);
  requiredString(value, "requestedBy", `${path}.requestedBy`, issues);
  if ("idempotencyKey" in value && typeof value.idempotencyKey !== "string") {
    issues.push(`${path}.idempotencyKey: Expected string`);
  }
  if ("metadata" in value && !isJsonObject(value.metadata)) {
    issues.push(`${path}.metadata: Expected JSON object`);
  }
}

function applyPatch(
  current: SessionMetadataRecord,
  patch: SessionMetadataPatch,
  updatedAt: string,
  source: SessionMetadataSource
): SessionMetadataRecord {
  const next: SessionMetadataRecord = {
    ...current,
    updatedAt,
    source,
  };

  if (patch.kind === "pin") {
    next.pinned = patch.pinned;
  } else if (patch.kind === "rename") {
    next.title = patch.title;
  } else if (patch.kind === "archive") {
    next.archived = patch.archived;
  } else {
    next.deleted = true;
  }

  return next;
}

function sourceFromAction(action: SessionAction): SessionMetadataSource {
  const metadata = compactJsonObject({
    consistency: action.consistency,
    ...(action.kind === "fork"
      ? {
          fromEventId: action.fromEventId,
          fromMessageId: action.fromMessageId,
          targetSessionId: action.targetSessionId,
        }
      : {}),
    ...(action.kind === "open" ? { target: action.target, paneId: action.paneId } : {}),
  });
  return {
    actionId: action.actionId,
    actionKind: action.kind,
    requestedAt: action.requestedAt,
    requestedBy: action.requestedBy,
    ...(action.idempotencyKey !== undefined ? { idempotencyKey: action.idempotencyKey } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function emptyState(): SessionMetadataStoreState {
  return {
    version: SESSION_METADATA_STORE_VERSION,
    sessions: [],
  };
}

function compareRecords(left: SessionMetadataRecord, right: SessionMetadataRecord): number {
  return left.sessionId.localeCompare(right.sessionId);
}

function recordsEqual(left: SessionMetadataRecord, right: SessionMetadataRecord): boolean {
  return deepEqual(left, right);
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

function requiredBoolean(
  input: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[]
): void {
  if (!(key in input)) {
    issues.push(`${path}: Required field is missing`);
    return;
  }
  if (typeof input[key] !== "boolean") {
    issues.push(`${path}: Expected boolean`);
  }
}

/**
 * 序列化 state 为写入文件的字符串。
 *
 * 默认紧凑输出（无缩进），减小文件体积与写入开销。
 * 设置环境变量 DEBUG_PRETTY_JSON=1 可切换为 2 空格缩进，便于调试时人工阅读。
 */
function serializeState(state: SessionMetadataStoreState): string {
  return `${JSON.stringify(state)}\n`;
}


