import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent, AgentMessage, ContextCompressionRecord, SessionEntry, SessionHeader, SessionStore } from "./types";

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

export function buildSessionContextFromEntries(entries: SessionEntry[]): AgentMessage[] {
  const latestCompactionIndex = findLatestCompactionIndex(entries);
  if (latestCompactionIndex === -1) {
    return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  }

  const compaction = entries[latestCompactionIndex]!;
  if (compaction.type !== "compaction") {
    return [];
  }

  const keptIds = new Set(compaction.record.keptMessageIds);
  const keptBeforeCompaction = entries
    .slice(0, latestCompactionIndex)
    .flatMap((entry) => (entry.type === "message" && keptIds.has(entry.message.id) ? [entry.message] : []));
  const afterCompaction = entries
    .slice(latestCompactionIndex + 1)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

  return [createCompactionSummaryAgentMessage(compaction.record), ...keptBeforeCompaction, ...afterCompaction];
}

export function findSessionLeafId(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "message" || entry.type === "checkpoint" || entry.type === "compaction") {
      return entry.id;
    }
  }
  return null;
}

export class InMemorySessionStore implements SessionStore {
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

export class JsonlSessionStore implements SessionStore {
  private opened = false;

  constructor(private readonly filePath: string, private readonly options: JsonlSessionStoreOptions = {}) {}

  async open(session: SessionHeader): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const mode = this.options.mode ?? "create";
    if (mode !== "create") {
      const existing = await readExistingSessionFile(this.filePath);
      if (existing) {
        this.opened = true;
        return;
      }
      if (mode === "append") {
        throw new Error(`Session file does not exist: ${this.filePath}`);
      }
    }
    await writeFile(this.filePath, `${JSON.stringify(session)}\n`, "utf8");
    this.opened = true;
  }

  async append(entry: SessionEntry): Promise<void> {
    if (!this.opened) {
      throw new Error("Session store must be opened before appending entries");
    }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async readAll(): Promise<SessionEntry[]> {
    const parsed = await readExistingSessionFile(this.filePath);
    return parsed?.entries ?? [];
  }
}

export class SessionRecorder {
  private leafId: string | null;
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly store: SessionStore, initialLeafId: string | null = null) {
    this.leafId = initialLeafId;
  }

  async recordMessage(message: AgentMessage): Promise<void> {
    await this.enqueueAppend(async () => {
      const entry: SessionEntry = {
        type: "message",
        id: createId("entry"),
        parentId: this.leafId,
        timestamp: nowIso(),
        message
      };
      this.leafId = entry.id;
      await this.store.append(entry);
    });
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

  async recordCompaction(record: ContextCompressionRecord): Promise<void> {
    await this.enqueueAppend(async () => {
      const entry: SessionEntry = {
        type: "compaction",
        id: createId("compact_entry"),
        parentId: this.leafId,
        timestamp: nowIso(),
        record
      };
      this.leafId = entry.id;
      await this.store.append(entry);
    });
  }

  async recordCheckpoint(label: string, metadata?: AgentMessage["metadata"]): Promise<void> {
    await this.enqueueAppend(async () => {
      const entry: SessionEntry = {
        type: "checkpoint",
        id: createId("checkpoint"),
        parentId: this.leafId,
        timestamp: nowIso(),
        label,
        metadata
      };
      this.leafId = entry.id;
      await this.store.append(entry);
    });
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

async function readExistingSessionFile(filePath: string): Promise<{ header: SessionHeader; entries: SessionEntry[] } | null> {
  const raw = await readFile(filePath, "utf8").catch((cause) => {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return null;
    throw cause;
  });
  if (!raw?.trim()) return null;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  const header = JSON.parse(lines[0]!) as SessionHeader;
  const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
  return { header, entries };
}
