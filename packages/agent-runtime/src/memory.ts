import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeTextBuffer } from "./encoding";
import { createId, nowIso } from "./session";
import { defineTool } from "./tools";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { AgentTool } from "./types";

export type MemoryScope = "session" | "project" | "user";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface MemorySearchOptions {
  query?: string;
  scope?: MemoryScope;
  tags?: string[];
  limit?: number;
}

export interface MemoryStore {
  remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  search(options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  delete?(memoryId: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries: MemoryEntry[] = [];
  private readonly deletedIds = new Set<string>();

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const now = nowIso();
    const saved: MemoryEntry = {
      ...entry,
      id: createId("memory"),
      createdAt: now,
      updatedAt: now
    };
    this.entries.push(saved);
    return saved;
  }

  async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    return filterMemories(this.entries.filter((entry) => !this.deletedIds.has(entry.id)), options);
  }

  async delete(memoryId: string): Promise<boolean> {
    const exists = this.entries.some((entry) => entry.id === memoryId && !this.deletedIds.has(entry.id));
    if (!exists) return false;
    this.deletedIds.add(memoryId);
    return true;
  }
}

export class JsonlMemoryStore implements MemoryStore {
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const now = nowIso();
    const saved: MemoryEntry = {
      ...entry,
      id: createId("memory"),
      createdAt: now,
      updatedAt: now
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.enqueueAppend(JSON.stringify(saved));
    return saved;
  }

  async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const entries = await this.readEntries();
    return filterMemories(entries, options);
  }

  async delete(memoryId: string): Promise<boolean> {
    const id = requireString({ memoryId }, "memoryId");
    const entries = await this.readEntries();
    if (!entries.some((entry) => entry.id === id)) {
      return false;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.enqueueAppend(JSON.stringify({ type: "delete", memoryId: id, deletedAt: nowIso() }));
    return true;
  }

  private async readEntries(): Promise<MemoryEntry[]> {
    const bytes = await readFile(this.filePath).catch(() => null);
    if (!bytes) return [];
    const decoded = decodeTextBuffer(bytes);
    if (decoded.encoding === "binary") return [];
    const entries = new Map<string, MemoryEntry>();
    const deletedIds = new Set<string>();
    for (const line of decoded.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as unknown;
        if (isMemoryDeleteRecord(record)) {
          deletedIds.add(record.memoryId);
          entries.delete(record.memoryId);
          continue;
        }
        const entry = normalizeMemoryEntry(record);
        if (!deletedIds.has(entry.id)) {
          entries.set(entry.id, entry);
        }
      } catch {
        continue;
      }
    }
    return [...entries.values()];
  }

  private async enqueueAppend(line: string): Promise<void> {
    const appendTask = this.appendQueue.then(() => appendJsonLine(this.filePath, line));
    this.appendQueue = appendTask.catch(() => undefined);
    await appendTask;
  }
}

interface MemoryDeleteRecord {
  type: "delete";
  memoryId: string;
  deletedAt: string;
}

function isMemoryDeleteRecord(value: unknown): value is MemoryDeleteRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === "delete" && typeof record.memoryId === "string" && record.memoryId.length > 0;
}

function normalizeMemoryEntry(value: unknown): MemoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory entry must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    id: requireString(record as JsonObject, "id"),
    scope: memoryScope(record.scope as JsonValue | undefined),
    content: requireString(record as JsonObject, "content"),
    tags: stringArray(record.tags as JsonValue | undefined),
    createdAt: requireString(record as JsonObject, "createdAt"),
    updatedAt: requireString(record as JsonObject, "updatedAt"),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as JsonObject }
      : {})
  };
}

async function appendJsonLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(dirname(path));
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort on Windows and some filesystems.
  }
}

export function createMemoryTools(store: MemoryStore): AgentTool[] {
  return [
    defineTool({
      name: "remember_memory",
      label: "Remember memory",
      description: "Persist a concise memory for future agent turns.",
      category: "internal",
      concurrency: "exclusive",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          scope: { type: "string", enum: ["session", "project", "user"] },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object" }
        },
        required: ["content"],
        additionalProperties: false
      },
      isReadOnly: () => false,
      summarize(input) {
        return `remember ${stringField(input, "content")?.slice(0, 80) ?? "memory"}`;
      },
      async execute(input) {
        const entry = await store.remember({
          content: requireString(input, "content"),
          scope: memoryScope(input.scope),
          tags: stringArray(input.tags),
          metadata: objectField(input, "metadata")
        });
        return {
          text: `Remembered ${entry.id}`,
          json: entry as unknown as JsonValue
        };
      }
    }),
    defineTool({
      name: "search_memory",
      label: "Search memory",
      description: "Search persisted memories by text, scope, and tags.",
      category: "internal",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["session", "project", "user"] },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" }
        },
        additionalProperties: false
      },
      isReadOnly: () => true,
      summarize(input) {
        return `search memory ${stringField(input, "query") ?? ""}`.trim();
      },
      async execute(input) {
        const matches = await store.search({
          query: stringField(input, "query"),
          scope: optionalMemoryScope(input.scope),
          tags: stringArray(input.tags),
          limit: numberField(input, "limit")
        });
        return {
          text: matches.map((entry) => `${entry.id} [${entry.scope}] ${entry.content}`).join("\n"),
          json: { matches: matches as unknown as JsonValue }
        };
      }
    })
  ];
}

function filterMemories(entries: MemoryEntry[], options: MemorySearchOptions): MemoryEntry[] {
  const query = options.query?.trim().toLowerCase();
  const tags = new Set((options.tags ?? []).map((tag) => tag.toLowerCase()));
  const limit = Math.max(1, options.limit ?? 20);
  return entries
    .filter((entry) => !options.scope || entry.scope === options.scope)
    .filter((entry) => !query || entry.content.toLowerCase().includes(query) || entry.tags.some((tag) => tag.toLowerCase().includes(query)))
    .filter((entry) => tags.size === 0 || entry.tags.some((tag) => tags.has(tag.toLowerCase())))
    .slice(-limit)
    .reverse();
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(input: JsonObject, key: string): JsonObject | undefined {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalMemoryScope(value: JsonValue | undefined): MemoryScope | undefined {
  return value === "session" || value === "project" || value === "user" ? value : undefined;
}

function memoryScope(value: JsonValue | undefined): MemoryScope {
  return optionalMemoryScope(value) ?? "project";
}
