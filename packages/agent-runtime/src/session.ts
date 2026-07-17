import { mkdir, open as openFile, readFile, rename, stat as statFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
import { SessionError } from "@crish/shared-types";
import type { SessionEntry, SessionHeader, SessionPersistenceStore } from "./types";
import { AsyncMutex, BoundedMap, errorMessage, isRecord, JsonlAppendBatcher } from "@crish/shared-utils";

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

/**
 * InMemorySessionStore 的容量上限。
 *
 * 该 store 在 runtime.ts 中作为未提供持久化 store 时的默认 fallback，
 * 长会话或 daemon 长跑场景下 entries 会单调增长导致内存泄漏。
 * 使用 BoundedMap 以 entry.id 为 key 存储，超容量时按 FIFO 淘汰最旧条目，
 * 既保留按 id 去重的语义，又提供强制容量约束。
 */
const IN_MEMORY_SESSION_STORE_CAPACITY = 500;

export class InMemorySessionStore implements SessionPersistenceStore {
  header: SessionHeader | null = null;
  private readonly entriesStore = new BoundedMap<string, SessionEntry>(IN_MEMORY_SESSION_STORE_CAPACITY);

  async open(session: SessionHeader): Promise<void> {
    this.header = session;
  }

  async append(entry: SessionEntry): Promise<void> {
    this.entriesStore.set(entry.id, entry);
  }

  async readAll(): Promise<SessionEntry[]> {
    return this.entriesStore.values();
  }

  async close(): Promise<void> {
    // 内存存储无需释放资源
  }

  /**
   * 按插入顺序返回所有 entries 的快照数组（受容量上限约束，超容量时淘汰最旧）。
   *
   * 兼容历史 API：原为 public 数组字段，外部调用方（含测试）依赖
   * `.find / .filter / .at(-1) / .length` 等数组操作。改为 getter 返回快照数组，
   * 既保留数组接口，又确保所有访问经过 BoundedMap 的容量约束。
   */
  get entries(): SessionEntry[] {
    return this.entriesStore.values();
  }
}

export type JsonlSessionStoreMode = "create" | "append" | "resume-or-create";

export interface JsonlSessionStoreOptions {
  mode?: JsonlSessionStoreMode;
}

export class JsonlSessionStore implements SessionPersistenceStore {
  private opened = false;
  private appendBatcher: JsonlAppendBatcher | undefined;
  /**
   * 串行化所有触碰 appendBatcher / 重写文件的公共方法。
   *
   * readAll 在 needsRewrite 时会调用 releaseAppendHandle 关闭 appendBatcher，
   * 若此时并发的 append 已经捕获 batcher 引用并正在写入，后续 rename 会
   * 抛 EBADF/EPERM。AsyncMutex 保证 readAll 释放句柄时不会有并发的 append
   * 正在使用它，同时保留 append 句柄缓存的吞吐优势。
   */
  private readonly mutex = new AsyncMutex();

  constructor(private readonly filePath: string, private readonly options: JsonlSessionStoreOptions = {}) {}

  async open(session: SessionHeader): Promise<void> {
    await this.mutex.runExclusive(async () => {
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
    });
  }

  async append(entry: SessionEntry): Promise<void> {
    if (!this.opened) {
      throw new SessionError("Session store must be opened before appending entries", "invalid_state");
    }
    await this.mutex.runExclusive(async () => {
      try {
        const batcher = await this.ensureAppendBatcher();
        await batcher.append(JSON.stringify(entry));
        // 立即 flush 确保 append 返回后数据已落盘。
        // session store 的调用方（含测试）依赖 append 的同步持久化语义：
        // 新建 store 实例读取或进程重启后必须看到已写入的 entry。
        // batcher 仍提供句柄缓存与集中化的换行/目录 fsync 逻辑。
        await batcher.flush();
      } catch (cause) {
        if (cause instanceof SessionError) {
          throw cause;
        }
        throw new SessionError(
          `Failed to append session entry to ${this.filePath}: ${errorMessage(cause)}`,
          "storage",
        );
      }
    });
  }

  async readAll(): Promise<SessionEntry[]> {
    return this.mutex.runExclusive(async () => {
      // 先 flush pending appends，确保文件反映所有写入后再读取
      if (this.appendBatcher) {
        await this.appendBatcher.flush();
      }
      const parsed = await readExistingSessionFile(this.filePath);
      if (parsed?.needsRewrite) {
        // 重写前必须释放持久化句柄，否则 Windows 上 rename 会因文件锁定失败
        await this.releaseAppendHandle();
        await writeSessionFileAtomically(this.filePath, parsed.header, parsed.entries);
      }
      return parsed?.entries ?? [];
    });
  }

  /**
   * 释放持久化的追加句柄。
   *
   * 正常运行期间 append() 会复用同一个文件句柄以提升吞吐，
   * 在关闭/卸载场景下应调用此方法确保句柄被释放。
   */
  async close(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.releaseAppendHandle();
      this.opened = false;
    });
  }

  private async releaseAppendHandle(): Promise<void> {
    if (this.appendBatcher) {
      try {
        await this.appendBatcher.close();
      } catch {
        // 忽略关闭错误
      }
      this.appendBatcher = undefined;
    }
  }

  /**
   * 懒初始化 JsonlAppendBatcher。
   *
   * batcher 内部缓存文件句柄、累积写入并批量 fsync，相比逐条 writeFile+sync
   * 显著提升吞吐。首行换行与目录 fsync 由 batcher 自身处理。同时做一次
   * 防御性 stat 检查，确保 header 已存在（open() 应已写入）。
   */
  private async ensureAppendBatcher(): Promise<JsonlAppendBatcher> {
    if (!this.appendBatcher) {
      const stat = await statFile(this.filePath).catch((cause) => {
        throw new SessionError(
          `Failed to access session file ${this.filePath}: ${errorMessage(cause)}`,
          "storage",
        );
      });
      if (stat.size === 0) {
        throw new SessionError(`Session file is empty before append: ${this.filePath}`, "invalid_session");
      }
      this.appendBatcher = new JsonlAppendBatcher({ filePath: this.filePath });
    }
    return this.appendBatcher;
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


