import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionContextFromEntries,
  createTextMessage,
  findSessionLeafId,
  InMemorySessionStore,
  JsonlSessionStore,
  nowIso,
  SessionRecorder
} from "./session";
import type { ContextCompressionRecord, SessionHeader } from "./types";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agent-runtime-session-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("session context reconstruction", () => {
  it("rebuilds model context from the latest compaction entry plus kept and new messages", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    const header: SessionHeader = {
      type: "session",
      id: "session_test",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    await store.open(header);
    const oldUser = createTextMessage("user", "old user request");
    const oldAssistant = createTextMessage("assistant", "old assistant answer");
    const keptUser = createTextMessage("user", "latest request");
    await recorder.recordMessage(oldUser);
    await recorder.recordMessage(oldAssistant);
    await recorder.recordMessage(keptUser);
    await recorder.recordCheckpoint("before compaction");

    const record: ContextCompressionRecord = {
      id: "compact_test",
      trigger: "auto",
      summary: "Old request was answered.",
      firstKeptMessageId: keptUser.id,
      compressedMessageIds: [oldUser.id, oldAssistant.id],
      keptMessageIds: [keptUser.id],
      tokensBefore: 120,
      tokensAfter: 30,
      createdAt: nowIso()
    };
    await recorder.recordCompaction(record);
    const after = createTextMessage("assistant", "continued");
    await recorder.recordMessage(after);

    const context = buildSessionContextFromEntries(store.entries);

    expect(context.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
    expect(context[0]?.blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<context_checkpoint>")
    });
    expect(context[1]?.id).toBe(keptUser.id);
    expect(context[2]?.id).toBe(after.id);
    expect(findSessionLeafId(store.entries)).toBe(store.entries.at(-1)?.id);
  });

  it("can reopen a JSONL session in append mode without overwriting previous entries", async () => {
    const sessionPath = join(tempRoot, "session.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_jsonl",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };

    const firstStore = new JsonlSessionStore(sessionPath, { mode: "resume-or-create" });
    await firstStore.open(header);
    const firstRecorder = new SessionRecorder(firstStore);
    const firstMessage = createTextMessage("user", "first");
    await firstRecorder.recordMessage(firstMessage);

    const secondStore = new JsonlSessionStore(sessionPath, { mode: "append" });
    await secondStore.open(header);
    const existingEntries = await secondStore.readAll();
    const secondRecorder = new SessionRecorder(secondStore, findSessionLeafId(existingEntries));
    const secondMessage = createTextMessage("assistant", "second");
    await secondRecorder.recordMessage(secondMessage);

    const reopened = new JsonlSessionStore(sessionPath, { mode: "append" });
    await reopened.open(header);
    const entries = await reopened.readAll();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type === "message" ? entries[0].message.id : undefined).toBe(firstMessage.id);
    expect(entries[1]?.type === "message" ? entries[1].message.id : undefined).toBe(secondMessage.id);
    expect(entries[1]?.parentId).toBe(existingEntries[0]?.id);
  });

  it("serializes concurrent recorder writes so checkpoint parent links stay linear", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    await store.open({
      type: "session",
      id: "session_parallel_record",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    });
    await recorder.recordMessage(createTextMessage("user", "start"));

    await Promise.all([recorder.recordCheckpoint("first"), recorder.recordCheckpoint("second")]);

    const messageEntry = store.entries.find((entry) => entry.type === "message");
    const checkpoints = store.entries.filter((entry) => entry.type === "checkpoint");
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.parentId).toBe(messageEntry?.id);
    expect(checkpoints[1]?.parentId).toBe(checkpoints[0]?.id);
  });

  it("fails append mode when the target session file is missing", async () => {
    const store = new JsonlSessionStore(join(tempRoot, "missing.jsonl"), { mode: "append" });
    await expect(
      store.open({
        type: "session",
        id: "missing",
        cwd: "C:/repo",
        createdAt: nowIso(),
        version: 1
      })
    ).rejects.toThrow(/does not exist/);
  });
});
