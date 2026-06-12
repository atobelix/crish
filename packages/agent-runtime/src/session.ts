import { constants } from "node:fs";
import { mkdir, open as openFile, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentEvent, AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
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
    throw new Error("Session store must support readAll before moving the session leaf");
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
}

export type JsonlSessionStoreMode = "create" | "append" | "resume-or-create";

export interface JsonlSessionStoreOptions {
  mode?: JsonlSessionStoreMode;
}

export class JsonlSessionStore implements SessionPersistenceStore {
  private opened = false;

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
        throw new Error(`Session file does not exist: ${this.filePath}`);
      }
    }
    await writeSessionFileAtomically(this.filePath, migrateSessionHeader(session).header, []);
    this.opened = true;
  }

  async append(entry: SessionEntry): Promise<void> {
    if (!this.opened) {
      throw new Error("Session store must be opened before appending entries");
    }
    try {
      await appendJsonlLine(this.filePath, JSON.stringify(entry));
    } catch (cause) {
      throw new Error(`Failed to append session entry to ${this.filePath}: ${errorMessage(cause)}`);
    }
  }

  async readAll(): Promise<SessionEntry[]> {
    const parsed = await readExistingSessionFile(this.filePath);
    if (parsed?.needsRewrite) {
      await writeSessionFileAtomically(this.filePath, parsed.header, parsed.entries);
    }
    return parsed?.entries ?? [];
  }
}

export class SessionRecorder {
  private leafId: string | null;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: SessionPersistenceStore, initialLeafId: string | null = null) {
    this.leafId = initialLeafId;
  }

  async recordMessage(message: AgentMessage): Promise<SessionMessageEntry> {
    let messageEntry: SessionMessageEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionMessageEntry = {
        type: "message",
        id: createId("entry"),
        parentId: this.leafId,
        timestamp: nowIso(),
        message
      };
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
        id: createId("event"),
        parentId: this.leafId,
        timestamp: nowIso(),
        event
      };
      await this.store.append(entry);
    });
  }

  async recordCompaction(record: ContextCompressionRecord): Promise<SessionCompactionEntry> {
    let compactionEntry: SessionCompactionEntry | undefined;
    await this.enqueueAppend(async () => {
      const entry: SessionCompactionEntry = {
        type: "compaction",
        id: createId("compact_entry"),
        parentId: this.leafId,
        timestamp: nowIso(),
        record
      };
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
        id: createId("checkpoint"),
        parentId: this.leafId,
        timestamp: nowIso(),
        label,
        metadata
      };
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
        id: createId("leaf_pointer"),
        parentId: this.leafId,
        timestamp: nowIso(),
        targetLeafId,
        ...(reason !== undefined ? { reason } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      };
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
    throw new Error(`Session leaf target ${targetLeafId} not found`);
  }
  if (target.type === "event" || target.type === "leaf-pointer") {
    throw new Error(`Session leaf target ${targetLeafId} must be a message, checkpoint, or compaction entry`);
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
      throw new Error(`Session entry parent cycle detected at ${currentId}`);
    }
    const entry = byId.get(currentId);
    if (!entry) {
      if (reversedPath.length === 0) {
        throw new Error(`Session entry ${currentId} not found`);
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
    throw new Error(`Invalid session header in ${filePath}`);
  }

  if (parsed.version !== undefined && parsed.version !== SESSION_FILE_VERSION) {
    throw new Error(`Unsupported session file version ${String(parsed.version)} in ${filePath}`);
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
    throw new Error("Invalid session header");
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
    throw new Error(`Failed to write session file ${filePath}: ${errorMessage(cause)}`);
  }
  try {
    await handle.close();
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to close temporary session file ${tempPath}: ${errorMessage(cause)}`);
  }

  try {
    await rename(tempPath, filePath);
  } catch (cause) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Failed to replace session file ${filePath}: ${errorMessage(cause)}`);
  }
}

async function appendJsonlLine(filePath: string, line: string): Promise<void> {
  const handle = await openFile(filePath, constants.O_APPEND | constants.O_RDWR);
  try {
    const fileStat = await handle.stat();
    if (fileStat.size === 0) {
      throw new Error(`Session file is empty before append: ${filePath}`);
    }
    let prefix = "";
    const tail = Buffer.alloc(1);
    await handle.read(tail, 0, 1, fileStat.size - 1);
    if (tail[0] !== 10) {
      prefix = "\n";
    }
    await handle.writeFile(`${prefix}${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}


