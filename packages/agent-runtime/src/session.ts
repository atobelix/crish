import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
import { SessionError } from "@crish/shared-types";
import type { SessionEntry, SessionHeader, SessionPersistenceStore } from "./types";
import { isRecord, errorMessage } from "@crish/shared-utils";

const SESSION_FILE_VERSION = 1;
export type SessionLeafPointerEntry = Extract<SessionEntry, { type: "leaf-pointer" }>;
export type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
export type SessionCheckpointEntry = Extract<SessionEntry, { type: "checkpoint" }>;
export type SessionCompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

export interface MoveSessionLeafOptions {
  reason?: string;
  metadata?: AgentMessage["metadata"];
}

export interface MoveSessionLeafResult {
  previousLeafId: string | null;
  targetLeafId: string | null;
  pointerEntry: SessionLeafPointerEntry;
}

export function createId(prefix = "id"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

/**
 * 生成不与已知 ID 冲突的条目 ID。
 *
 * 对齐 Pi 的 generateEntryId 模式：在极小概率的 UUID 碰撞下重试最多 100 次，
 * 仍碰撞则退化为带时间戳的随机 ID。prefix 用于区分条目类型。
 */
function generateUniqueEntryId(prefix: string, usedIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = createId(prefix);
    if (!usedIds.has(id)) {
      return id;
    }
  }
  // 100 次仍碰撞，退化为带更高熵的 ID
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${globalThis.crypto?.randomUUID?.() ?? ""}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createTextMessage(role: AgentMessage["role"], text: string, metadata?: AgentMessage["metadata"]): AgentMessage {
  return {
    id: createId(role),
    role,
    createdAt: nowIso(),
    blocks: text ? [{ type: "text", text }] : [],
    metadata
  };
}

export function createCompactionSummaryAgentMessage(record: ContextCompressionRecord): AgentMessage {
  return {
    id: record.id,
    role: "user",
    createdAt: record.createdAt,
    blocks: [{ type: "text", text: `<context_checkpoint>\n${record.summary.trim()}\n</context_checkpoint>` }],
    metadata: {
      kind: "context-compression-summary",
      compactionId: record.id,
      trigger: record.trigger,
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter
    }
  };
}

export function buildSessionContextFromEntries(entries: SessionEntry[], leafId: string | null = findSessionLeafId(entries)): AgentMessage[] {
  const path = buildSessionPath(entries, leafId);
  const latestCompactionIndex = findLatestCompactionIndex(path);
  if (latestCompactionIndex === -1) {
    return path.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  }

  const compaction = path[latestCompactionIndex]!;
  if (compaction.type !== "compaction") {
    return [];
  }

  const keptIds = new Set(compaction.record.keptMessageIds);
  const keptBeforeCompaction = path
    .slice(0, latestCompactionIndex)
    .flatMap((entry) => (entry.type === "message" && keptIds.has(entry.message.id) ? [entry.message] : []));
  const afterCompaction = path
    .slice(latestCompactionIndex + 1)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  return [createCompactionSummaryAgentMessage(compaction.record), ...keptBeforeCompaction, ...afterCompaction];
}

export function findSessionLeafId(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "leaf-pointer") {
      return entry.targetLeafId;
    }
    if (entry.type === "message" || entry.type === "checkpoint" || entry.type === "compaction") {
      return entry.id;
    }
  }
  return null;
}

export async function moveSessionLeaf(
  store: SessionPersistenceStore,
  targetLeafId: string | null,
  options: MoveSessionLeafOptions = {}
): Promise<MoveSessionLeafResult> {
  if (!store.readAll) {
    throw new SessionError("Session store must support readAll before moving the session leaf", "invalid_state");
  }

  const entries = await store.readAll();
  assertValidSessionLeafTarget(entries, targetLeafId);
  const previousLeafId = findSessionLeafId(entries);
  const recorder = new SessionRecorder(store, previousLeafId);
  const pointerEntry = await recorder.recordLeafPointer(targetLeafId, options.reason, options.metadata);

  return {
    previousLeafId,
    targetLeafId,
    pointerEntry
  };
}

export class InMemorySessionStore implements SessionPersistenceStore {
  header: SessionHeader | null = null;
  entries: SessionEntry[] = [];

  async open(session: SessionHeader): Promise<void> {
    this.header = session;
  }

  async append(entry: SessionEntry): Promise<void> {
    this.entries.push(entry);
  }

  async readAll(): Promise<SessionEntry[]> {
    return [...this.entries];
  }

  async close(): Promise<void> {
    // 内存存储无需释放资源
  }
}

export type JsonlSessionStoreMode = "create" | "append" | "resume-or-create";

export interface JsonlSessionStoreOptions {
  mode?: JsonlSessionStoreMode;
}

export class JsonlSessionStore implements SessionPersistenceStore {
  private opened = false;
  private appendHandle: FileHandle | undefined;

  constructor(private readonly filePath: string, private readonly options: JsonlSessionStoreOptions = {}) {}

  async open(session: SessionHeader): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const mode = this.options.mode ?? "create";
    if (mode !== "create") {
      const existing = await readExistingSessionFile(this.filePath);
      if (existing) {
        if (existing.needsRewrite) {
          await writeSessionFileAtomically(this.filePath, existing.header, existing.entries);
        }
        this.opened = true;
        return;
      }
      if (mode === "append") {
        throw new SessionError(`Session file does not exist: ${this.filePath}`, "not_found");
      }
    }
    await writeSessionFileAtomically(this.filePath, migrateSessionHeader(session).header, []);
    this.opened = true;
  }

  async append(entry: SessionEntry): Promise<void> {
    if (!this.opened) {
      throw new SessionError("Session store must be opened before appending entries", "invalid_state");
    }
    try {
      await this.appendJsonlLineWithCachedHandle(JSON.stringify(entry));
    } catch (cause) {
      if (cause instanceof SessionError) {
        throw cause;
      }
      throw new SessionError(
        `Failed to append session entry to ${this.filePath}: ${errorMessage(cause)}`,
        "storage",
      );
    }
  }

  async readAll(): Promise<SessionEntry[]> {
    const parsed = await readExistingSessionFile(this.filePath);
    if (parsed?.needsRewrite) {
      // 重写前必须释放持久化句柄，否则 Windows 上 rename 会因文件锁定失败
      await this.releaseAppendHandle();
      await writeSessionFileAtomically(this.filePath, parsed.header, parsed.entries);
    }
    return parsed?.entries ?? [];
  }

  /**
   * 释放持久化的追加句柄。
   *
   * 正常运行期间 append() 会复用同一个文件句柄以提升吞吐，
   * 在关闭/卸载场景下应调用此方法确保句柄被释放。
   */
  async close(): Promise<void> {
    await this.releaseAppendHandle();
    this.opened = false;
  }

  private async releaseAppendHandle(): Promise<void> {
    if (this.appendHandle) {
      try {
        await this.appendHandle.close();
      } catch {
        // 忽略关闭错误
      }
      this.appendHandle = undefined;
    }
  }

  /**
   * 使用持久化句柄追加一行 JSONL。
   *
   * 相比每次打开/关闭文件，缓存句柄可显著提升吞吐。
   * 句柄失效时会自动释放并让下次 append 重新打开。
   */
  private async appendJsonlLineWithCachedHandle(line: string): Promise<void> {
    if (!this.appendHandle) {
      this.appendHandle = await openFile(this.filePath, constants.O_APPEND | constants.O_RDWR);
    }
    const handle = this.appendHandle;
    try {
      const stat = await handle.stat();
      if (stat.size === 0) {
        throw new SessionError(`Session file is empty before append: ${this.filePath}`, "invalid_session");
      }
      let prefix = "";
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, stat.size - 1);
      if (tail[0] !== 10) {
        prefix = "\n";
      }
      await handle.writeFile(`${prefix}${line}\n`, "utf8");
      await handle.sync();
    } catch (cause) {
      // 句柄可能已失效（文件被移动/删除等），释放并让下次 append 重新打开
      try {
        await handle.close();
      } catch {
        // 忽略关闭错误
      }
      this.appendHandle = undefined;
      throw cause;
    }
  }
}

export class SessionRecorder {
  private leafId: string | null;
  private appendQueue: Promise<void> = Promise.resolve();
  private readonly usedIds: Set<string>;

  constructor(private readonly store: SessionPersistenceStore, initialLeafId: string | null = null) {
    this.leafId = initialLeafId;
    this.usedIds = new Set();
    if (initialLeafId !== null) {
      this.usedIds.add(initialLeafId);
    }
  }

  async recordMessage(message: AgentMessage): Promise<SessionMessageEntry> {
    let messageEntry: SessionMessageEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionMessageEntry = {
        type: "message",
        id: generateUniqueEntryId("entry", this.usedIds),
        parentId: this.leafId,
        timestamp: nowIso(),
        message
      };
      this.usedIds.add(entry.id);
      this.leafId = entry.id;
      messageEntry = entry;
      await this.store.append(entry);
    });
    return messageEntry!;
  }

  async recordEvent(event: AgentEvent): Promise<void> {
    await this.enqueueAppend(async () => {
      const entry: SessionEntry = {
        type: "event",
        id: generateUniqueEntryId("event", this.usedIds),
        parentId: this.leafId,
        timestamp: nowIso(),
        event
      };
      this.usedIds.add(entry.id);
      await this.store.append(entry);
    });
  }

  async recordCompaction(record: ContextCompressionRecord): Promise<SessionCompactionEntry> {
    let compactionEntry: SessionCompactionEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionCompactionEntry = {
        type: "compaction",
        id: generateUniqueEntryId("compact_entry", this.usedIds),
        parentId: this.leafId,
        timestamp: nowIso(),
        record
      };
      this.usedIds.add(entry.id);
      this.leafId = entry.id;
      compactionEntry = entry;
      await this.store.append(entry);
    });
    return compactionEntry!;
  }

  async recordCheckpoint(label: string, metadata?: AgentMessage["metadata"]): Promise<SessionCheckpointEntry> {
    let checkpointEntry: SessionCheckpointEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionCheckpointEntry = {
        type: "checkpoint",
        id: generateUniqueEntryId("checkpoint", this.usedIds),
        parentId: this.leafId,
        timestamp: nowIso(),
        label,
        metadata
      };
      this.usedIds.add(entry.id);
      this.leafId = entry.id;
      checkpointEntry = entry;
      await this.store.append(entry);
    });
    return checkpointEntry!;
  }

  async recordLeafPointer(targetLeafId: string | null, reason?: string, metadata?: AgentMessage["metadata"]): Promise<SessionLeafPointerEntry> {
    let pointerEntry: SessionLeafPointerEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionLeafPointerEntry = {
        type: "leaf-pointer",
        id: generateUniqueEntryId("leaf_pointer", this.usedIds),
        parentId: this.leafId,
        timestamp: nowIso(),
        targetLeafId,
        ...(reason !== undefined ? { reason } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      };
      this.usedIds.add(entry.id);
      this.leafId = targetLeafId;
      pointerEntry = entry;
      await this.store.append(entry);
    });
    return pointerEntry!;
  }

  private async enqueueAppend(operation: () => Promise<void>): Promise<void> {
    const next = this.appendQueue.then(operation, operation);
    this.appendQueue = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }
}

function findLatestCompactionIndex(entries: SessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") return index;
  }
  return -1;
}

function assertValidSessionLeafTarget(entries: SessionEntry[], targetLeafId: string | null): void {
  if (targetLeafId === null) return;
  const target = entries.find((entry) => entry.id === targetLeafId);
  if (!target) {
    throw new SessionError(`Session leaf target ${targetLeafId} not found`, "not_found");
  }
  if (target.type === "event" || target.type === "leaf-pointer") {
    throw new SessionError(
      `Session leaf target ${targetLeafId} must be a message, checkpoint, or compaction entry`,
      "invalid_entry",
    );
  }
}

function buildSessionPath(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const reversedPath: SessionEntry[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId !== null) {
    if (seen.has(currentId)) {
      throw new SessionError(`Session entry parent cycle detected at ${currentId}`, "invalid_session");
    }
    const entry = byId.get(currentId);
    if (!entry) {
      if (reversedPath.length === 0) {
        throw new SessionError(`Session entry ${currentId} not found`, "not_found");
      }
      break;
    }
    seen.add(currentId);
    if (entry.type === "leaf-pointer") {
      currentId = entry.targetLeafId;
      continue;
    }
    reversedPath.push(entry);
    currentId = entry.parentId;
  }

  return reversedPath.reverse();
}

interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
  needsRewrite: boolean;
}

async function readExistingSessionFile(filePath: string): Promise<ParsedSessionFile | null> {
  const raw = await readFile(filePath, "utf8").catch((cause) => {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return null;
    throw cause;
  });
  if (!raw?.trim()) return null;
  const lines = raw.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  const headerLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headerLineIndex === -1) return null;

  const migrated = parseSessionHeader(lines[headerLineIndex]!, filePath);
  const entries: SessionEntry[] = [];
  let needsRewrite = migrated.needsRewrite || headerLineIndex > 0 || !raw.endsWith("\n");

  for (let index = headerLineIndex + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) {
      needsRewrite = true;
      continue;
    }

    const parsed = parseJsonLine(line);
    if (!isSessionEntry(parsed)) {
      needsRewrite = true;
      continue;
    }
    entries.push(parsed);
  }

  return { header: migrated.header, entries, needsRewrite };
}

function parseSessionHeader(line: string, filePath: string): { header: SessionHeader; needsRewrite: boolean } {
  const parsed = parseJsonLine(line);
  if (!isRecord(parsed) || parsed.type !== "session") {
    throw new SessionError(`Invalid session header in ${filePath}`, "invalid_session");
  }

  if (parsed.version !== undefined && parsed.version !== SESSION_FILE_VERSION) {
    throw new SessionError(
      `Unsupported session file version ${String(parsed.version)} in ${filePath}`,
      "invalid_session",
    );
  }

  return migrateSessionHeader(parsed);
}

function migrateSessionHeader(value: unknown): { header: SessionHeader; needsRewrite: boolean } {
  if (
    !isRecord(value) ||
    value.type !== "session" ||
    typeof value.id !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new SessionError("Invalid session header", "invalid_session");
  }

  return {
    header: {
      type: "session",
      id: value.id,
      cwd: value.cwd,
      createdAt: value.createdAt,
      version: SESSION_FILE_VERSION
    },
    needsRewrite: value.version !== SESSION_FILE_VERSION
  };
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string" || !isParentId(value.parentId)) {
    return false;
  }

  switch (value.type) {
    case "message":
      return isAgentMessage(value.message);
    case "event":
      return isRecord(value.event) && typeof value.event.type === "string";
    case "checkpoint":
      return typeof value.label === "string";
    case "compaction":
      return isContextCompressionRecord(value.record);
    case "leaf-pointer":
      return isParentId(value.targetLeafId) && optionalString(value.reason) && optionalRecord(value.metadata);
    default:
      return false;
  }
}

function isParentId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.blocks)
  );
}

function isContextCompressionRecord(value: unknown): value is ContextCompressionRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.trigger === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.compressedMessageIds) &&
    Array.isArray(value.keptMessageIds) &&
    typeof value.tokensBefore === "number" &&
    typeof value.tokensAfter === "number" &&
    typeof value.createdAt === "string"
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

async function writeSessionFileAtomically(filePath: string, header: SessionHeader, entries: SessionEntry[]): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(filePath)}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`);
  const lines = [header, ...entries].map((line) => JSON.stringify(line));
  const contents = `${lines.join("\n")}\n`;

  const handle = await openFile(tempPath, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw new SessionError(`Failed to write session file ${filePath}: ${errorMessage(cause)}`, "storage");
  }
  try {
    await handle.close();
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new SessionError(
      `Failed to close temporary session file ${tempPath}: ${errorMessage(cause)}`,
      "storage",
    );
  }

  try {
    await rename(tempPath, filePath);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new SessionError(`Failed to replace session file ${filePath}: ${errorMessage(cause)}`, "storage");
  }
}


