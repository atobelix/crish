import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeTextBuffer } from "./encoding";
import { createId, nowIso } from "./session";
import { defineTool } from "./tools";
import type { AgentTool, JsonObject, JsonValue } from "./types";

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
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries: MemoryEntry[] = [];

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
    return filterMemories(this.entries, options);
  }
}

export class JsonlMemoryStore implements MemoryStore {
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
    await appendFile(this.filePath, `${JSON.stringify(saved)}\n`, "utf8");
    return saved;
  }

  async search(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const entries = await this.readEntries();
    return filterMemories(entries, options);
  }

  private async readEntries(): Promise<MemoryEntry[]> {
    const bytes = await readFile(this.filePath).catch(() => null);
    if (!bytes) return [];
    const decoded = decodeTextBuffer(bytes);
    if (decoded.encoding === "binary") return [];
    return decoded.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as MemoryEntry];
        } catch {
          return [];
        }
      });
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
