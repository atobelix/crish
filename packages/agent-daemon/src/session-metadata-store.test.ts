import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAction } from "@crish/shared-types";
import { FileSessionMetadataStore } from "./session-metadata-store";
import { removeTempDirs } from "./test-temp-cleanup";

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe("FileSessionMetadataStore", () => {
  it("roundtrips session metadata mutations", async () => {
    const storePath = await tempStorePath();
    const store = new FileSessionMetadataStore(storePath, { fsync: false });

    await store.applyAction(action("pin"), { kind: "pin", pinned: true }, new Date("2026-06-08T00:00:01.000Z"));
    await store.applyAction(
      renameAction(),
      { kind: "rename", title: "Renamed session" },
      new Date("2026-06-08T00:00:02.000Z")
    );

    const restored = new FileSessionMetadataStore(storePath, { fsync: false });
    await expect(restored.get("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      title: "Renamed session",
      pinned: true,
      archived: false,
      deleted: false,
      updatedAt: "2026-06-08T00:00:02.000Z",
      source: {
        actionId: "action_rename",
        actionKind: "rename",
      },
    });
  });

  it("tolerates invalid records with a typed read failure", async () => {
    const storePath = await tempStorePath();
    await writeFile(storePath, JSON.stringify({ version: 1, sessions: [{ sessionId: "missing-fields" }] }), "utf8");

    const store = new FileSessionMetadataStore(storePath, { fsync: false });

    await expect(store.list()).rejects.toMatchObject({
      code: "SESSION_METADATA_STORE_READ_FAILED",
      issues: expect.arrayContaining([expect.stringContaining("pinned")]),
    });
  });

  it("soft deletes without clearing persisted metadata or history files", async () => {
    const dir = await tempDir();
    const historyPath = join(dir, "orchestrator-events.jsonl");
    await writeFile(historyPath, "{\"type\":\"orchestrator-event-store\"}\n", "utf8");
    const store = new FileSessionMetadataStore(join(dir, "session-metadata.json"), { fsync: false });

    await store.applyAction(action("delete"), { kind: "delete", deleted: true });

    await expect(store.get("session-1")).resolves.toMatchObject({ deleted: true });
    await expect(readFile(historyPath, "utf8")).resolves.toContain("orchestrator-event-store");
  });
});

async function tempStorePath(): Promise<string> {
  return join(await tempDir(), "session-metadata.json");
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crish-session-metadata-"));
  tempDirs.push(dir);
  return dir;
}

function action(kind: SessionAction["kind"]): SessionAction {
  const base = {
    protocolVersion: 1 as const,
    actionId: `action_${kind}`,
    kind,
    sessionId: "session-1",
    requestedAt: "2026-06-08T00:00:00.000Z",
    requestedBy: "workbench" as const,
  };
  if (kind === "rename") return { ...base, kind, title: "Renamed session" };
  if (kind === "fork") return { ...base, kind };
  if (kind === "rewind") return { ...base, kind, targetEventId: "event-1", restoreWorkspace: false };
  if (kind === "open") return { ...base, kind, target: "split-view" };
  return base as SessionAction;
}

function renameAction(): Extract<SessionAction, { kind: "rename" }> {
  return {
    protocolVersion: 1,
    actionId: "action_rename",
    kind: "rename",
    sessionId: "session-1",
    requestedAt: "2026-06-08T00:00:00.000Z",
    requestedBy: "workbench",
    title: "Renamed session",
  };
}
