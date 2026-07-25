import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DAEMON_SCOPED_CONTEXT_STORE_VERSION,
  FileScopedContextStore,
} from "./scoped-context-store";
import {
  createDeleteScopedContextResponse,
  createGetScopedContextResponse,
  createResolveScopedContextResponse,
  createUpsertScopedContextResponse,
} from "./scoped-context-query-handlers";
import type { ScopedContextRecord } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileScopedContextStore", () => {
  it("supports CRUD and persistent roundtrip", async () => {
    const filePath = await tempStorePath();
    const store = new FileScopedContextStore(filePath);

    const upserted = await store.upsert(record({ id: "project-rule", title: "Project rule" }));
    expect(upserted).toMatchObject({
      record: {
        id: "project-rule",
        title: "Project rule",
        updatedAt: expect.any(String),
      },
      persisted: true,
    });

    const listed = await store.list();
    expect(listed.records.map((item) => item.id)).toEqual(["project-rule"]);

    const restored = new FileScopedContextStore(filePath);
    await expect(restored.list()).resolves.toMatchObject({
      records: [expect.objectContaining({ id: "project-rule" })],
    });

    const deleted = await restored.delete("project-rule");
    expect(deleted).toMatchObject({ recordId: "project-rule", deleted: true, persisted: true });
    await expect(restored.list()).resolves.toMatchObject({ records: [] });

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { version: number; records: unknown[] };
    expect(persisted.version).toBe(DAEMON_SCOPED_CONTEXT_STORE_VERSION);
    expect(persisted.records).toEqual([]);
  });

  it("returns degraded diagnostics instead of empty success when persisted state is invalid", async () => {
    const filePath = await tempStorePath();
    await writeFile(filePath, "{\"version\":1,\"records\":[{\"id\":\"broken\"}]}\n", "utf8");
    const store = new FileScopedContextStore(filePath);

    const listed = await store.list();
    expect(listed).toMatchObject({
      status: "degraded",
      records: [],
      diagnostic: {
        code: "SCOPED_CONTEXT_STORE_READ_FAILED",
      },
    });

    const upserted = await store.upsert(record({ id: "new-rule" }));
    expect(upserted).toMatchObject({
      status: "degraded",
      persisted: false,
      diagnostic: {
        code: "SCOPED_CONTEXT_STORE_READ_FAILED",
      },
    });
    expect(await readFile(filePath, "utf8")).toContain("\"id\":\"broken\"");
  });
});

describe("scoped context query handlers", () => {
  it("returns CRUD protocol responses with store status", async () => {
    const store = new FileScopedContextStore(await tempStorePath());
    const upserted = await createUpsertScopedContextResponse(store, {
      type: "upsert-scoped-context",
      record: record({ id: "global-skill", kind: "skill", activation: "recommended" }),
    });
    expect(upserted).toMatchObject({
      type: "scoped-context-upserted",
      record: { id: "global-skill" },
      persisted: true,
    });

    await expect(
      createGetScopedContextResponse(store, { type: "get-scoped-context", kind: "skill" })
    ).resolves.toMatchObject({
      type: "scoped-context-response",
      records: [expect.objectContaining({ id: "global-skill" })],
    });

    await expect(
      createDeleteScopedContextResponse(store, {
        type: "delete-scoped-context",
        recordId: "global-skill",
      })
    ).resolves.toMatchObject({
      type: "scoped-context-deleted",
      deleted: true,
    });
  });

  it("resolves enabled, recommended, disabled, and user-enabled records", async () => {
    const store = new FileScopedContextStore(await tempStorePath());
    await store.upsert(record({ id: "enabled-rule", activation: "enabled", order: 1 }));
    await store.upsert(record({ id: "recommended-rule", activation: "recommended", order: 2 }));
    await store.upsert(record({ id: "disabled-rule", activation: "disabled", order: 3 }));
    await store.upsert(
      record({
        id: "recommended-skill",
        kind: "skill",
        activation: "recommended",
        content: "Use safe context management.",
        order: 4,
      })
    );

    const recommended = await createResolveScopedContextResponse(store, {
      type: "resolve-scoped-context",
      cwd: "C:/workspace/crish",
      projectRoot: "C:/workspace/crish",
    });
    expect(recommended).toMatchObject({
      type: "scoped-context-resolved",
      status: expect.any(String),
    });
    expect(recommended.stableContext.map((block) => block.id)).toEqual(["scoped-context:rules"]);
    expect(recommended.recommended.map((item) => item.id)).toEqual([
      "recommended-rule",
      "recommended-skill",
    ]);
    expect(recommended.items.map((item) => [item.id, item.status])).toEqual([
      ["enabled-rule", "active"],
      ["recommended-rule", "recommended"],
      ["disabled-rule", "disabled"],
      ["recommended-skill", "recommended"],
    ]);

    const enabledByUser = await createResolveScopedContextResponse(store, {
      type: "resolve-scoped-context",
      cwd: "C:/workspace/crish",
      projectRoot: "C:/workspace/crish",
      userEnabledIds: ["recommended-skill"],
    });
    expect(enabledByUser.stableContext.map((block) => block.id)).toEqual([
      "scoped-context:rules",
      "scoped-context:skills",
    ]);
    expect(enabledByUser.recommended.map((item) => item.id)).toEqual(["recommended-rule"]);
    expect(enabledByUser.stableContextHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-scoped-context-"));
  tempDirs.push(dir);
  return join(dir, "scoped-context.json");
}

function record(overrides: Partial<ScopedContextRecord> = {}): ScopedContextRecord {
  return {
    id: "record-1",
    kind: "rule",
    title: "Rule",
    content: "Keep scoped context stable.",
    description: undefined,
    scope: "project",
    activation: "enabled",
    appliesTo: [],
    tags: [],
    source: { type: "user", label: "User managed" },
    sourceMetadata: { origin: "test" },
    order: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
