import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilePlanDocumentStore,
  PLAN_DOCUMENT_STORE_VERSION,
  PlanDocumentConflictError,
  PlanDocumentNotFoundError,
  PlanDocumentStoreReadError,
  PlanDocumentStoreValidationError,
  PlanDocumentStoreWriteError,
} from "./plan-document-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FilePlanDocumentStore", () => {
  it("persists plan documents as versioned JSON", async () => {
    const filePath = await tempStorePath();
    const store = new FilePlanDocumentStore(filePath);

    const document = await store.createPlanDocument({
      id: "plan_persist",
      title: "Persistent plan",
      goal: "Keep a daemon-owned editable plan document.",
      steps: [{ id: "step_1", title: "Wire the store" }],
    });
    expect(document.version).toBe(1);

    const patched = await store.patchPlanDocument("plan_persist", {
      expectedVersion: 1,
      operations: [{ op: "update-step", id: "step_1", update: { status: "completed" } }],
    });
    expect(patched.version).toBe(2);

    const restored = new FilePlanDocumentStore(filePath);
    await expect(restored.getPlanDocument("plan_persist")).resolves.toMatchObject({
      id: "plan_persist",
      version: 2,
      steps: [{ id: "step_1", status: "completed" }],
    });
    await expect(restored.listPlanDocuments()).resolves.toMatchObject([
      { id: "plan_persist", steps: { total: 1 } },
    ]);

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
    expect(persisted.version).toBe(PLAN_DOCUMENT_STORE_VERSION);
  });

  it("surfaces typed not found, conflict, and validation errors", async () => {
    const filePath = await tempStorePath();
    const store = new FilePlanDocumentStore(filePath);
    await store.createPlanDocument({
      id: "plan_errors",
      title: "Errors",
      goal: "Return typed failures.",
    });

    await expect(store.getPlanDocument("missing")).rejects.toBeInstanceOf(PlanDocumentNotFoundError);
    await expect(
      store.createPlanDocument({
        id: "plan_errors",
        title: "Duplicate",
        goal: "Reject duplicate ids.",
      })
    ).rejects.toBeInstanceOf(PlanDocumentConflictError);
    await expect(
      store.patchPlanDocument("plan_errors", {
        expectedVersion: 99,
        operations: [{ op: "set-title", title: "Stale" }],
      })
    ).rejects.toBeInstanceOf(PlanDocumentConflictError);
    await expect(
      store.patchPlanDocument("plan_errors", {
        expectedVersion: 1,
        operations: [{ op: "set-title", title: "" }],
      })
    ).rejects.toBeInstanceOf(PlanDocumentStoreValidationError);
    await expect(store.deletePlanDocument("missing")).rejects.toBeInstanceOf(PlanDocumentNotFoundError);
  });

  it("rejects invalid persisted index on read", async () => {
    const filePath = await tempStorePath();
    await writeFile(
      filePath,
      JSON.stringify({
        version: PLAN_DOCUMENT_STORE_VERSION,
        summaries: [{ id: "bad", version: "not-a-number" }],
      }),
      "utf8"
    );

    const store = new FilePlanDocumentStore(filePath);
    await expect(store.listPlanDocuments()).rejects.toBeInstanceOf(PlanDocumentStoreReadError);
  });

  it("surfaces strict directory fsync failure instead of reporting a fake durable write", async () => {
    const filePath = await tempStorePath();
    const store = new FilePlanDocumentStore(filePath, { fsyncDirectory: true });

    if (process.platform !== "win32") {
      return;
    }

    await expect(
      store.createPlanDocument({
        id: "plan_strict_dirsync",
        title: "Strict dirsync",
        goal: "Surface Windows directory fsync failures in strict mode.",
      })
    ).rejects.toBeInstanceOf(PlanDocumentStoreWriteError);
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-plan-document-store-"));
  tempDirs.push(dir);
  return join(dir, "plan-documents.json");
}
