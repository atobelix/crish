import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionContextFromEntries,
  createTextMessage,
  findSessionLeafId,
  InMemorySessionStore,
  JsonlSessionStore,
  moveSessionLeaf,
  nowIso,
  SessionRecorder
} from "./session";
import type { AgentMessage, ContextCompressionRecord } from "@crish/shared-types";
import type { SessionEntry, SessionHeader } from "./types";

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

  it("rebuilds context from the selected leaf path without sibling branch messages", () => {
    const root = createTextMessage("user", "root request");
    const branchA = createTextMessage("assistant", "branch A answer");
    const branchB = createTextMessage("assistant", "branch B answer");
    const entries: SessionEntry[] = [
      { type: "message", id: "entry_root", parentId: null, timestamp: nowIso(), message: root },
      { type: "message", id: "entry_branch_a", parentId: "entry_root", timestamp: nowIso(), message: branchA },
      { type: "message", id: "entry_branch_b", parentId: "entry_root", timestamp: nowIso(), message: branchB }
    ];

    const context = buildSessionContextFromEntries(entries, "entry_branch_b");

    expect(context.map((message) => message.id)).toEqual([root.id, branchB.id]);
    expect(context.map((message) => textBlock(message))).toEqual(["root request", "branch B answer"]);
  });

  it("applies compaction only when it is on the selected leaf path", () => {
    const root = createTextMessage("user", "root request");
    const branchA = createTextMessage("assistant", "branch A answer");
    const branchAAfterCompaction = createTextMessage("assistant", "branch A continued");
    const branchB = createTextMessage("assistant", "branch B answer");
    const compactedBranchA: ContextCompressionRecord = {
      id: "compact_branch_a",
      trigger: "manual",
      summary: "Branch A was compacted.",
      firstKeptMessageId: branchA.id,
      compressedMessageIds: [root.id],
      keptMessageIds: [branchA.id],
      tokensBefore: 200,
      tokensAfter: 40,
      createdAt: nowIso()
    };
    const entries: SessionEntry[] = [
      { type: "message", id: "entry_root", parentId: null, timestamp: nowIso(), message: root },
      { type: "message", id: "entry_branch_a", parentId: "entry_root", timestamp: nowIso(), message: branchA },
      { type: "compaction", id: "entry_compact_a", parentId: "entry_branch_a", timestamp: nowIso(), record: compactedBranchA },
      { type: "message", id: "entry_branch_a_after", parentId: "entry_compact_a", timestamp: nowIso(), message: branchAAfterCompaction },
      { type: "message", id: "entry_branch_b", parentId: "entry_root", timestamp: nowIso(), message: branchB }
    ];

    const branchBContext = buildSessionContextFromEntries(entries, "entry_branch_b");
    const branchAContext = buildSessionContextFromEntries(entries, "entry_branch_a_after");

    expect(branchBContext.map((message) => message.id)).toEqual([root.id, branchB.id]);
    expect(branchAContext.map((message) => message.id)).toEqual([compactedBranchA.id, branchA.id, branchAAfterCompaction.id]);
    expect(textBlock(branchAContext[0])).toContain("Branch A was compacted.");
  });

  it("moves the current leaf with an append-only pointer before continuing from that branch", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    await store.open({
      type: "session",
      id: "session_leaf_pointer",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    });

    const root = createTextMessage("user", "root request");
    const abandoned = createTextMessage("assistant", "abandoned answer");
    const continued = createTextMessage("assistant", "continued answer");
    await recorder.recordMessage(root);
    const rootEntry = store.entries.at(-1);
    await recorder.recordMessage(abandoned);
    const abandonedEntry = store.entries.at(-1);
    await recorder.recordLeafPointer(rootEntry?.id ?? null, "rewind-user-message");
    const pointerEntry = store.entries.at(-1);
    await recorder.recordMessage(continued);

    expect(pointerEntry).toMatchObject({
      type: "leaf-pointer",
      parentId: abandonedEntry?.id,
      targetLeafId: rootEntry?.id,
      reason: "rewind-user-message"
    });
    expect(store.entries.at(-1)?.parentId).toBe(rootEntry?.id);
    expect(findSessionLeafId(store.entries)).toBe(store.entries.at(-1)?.id);
    expect(buildSessionContextFromEntries(store.entries).map((message) => message.id)).toEqual([root.id, continued.id]);
  });

  it("uses the last leaf pointer as the current session leaf before new messages are appended", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    await store.open({
      type: "session",
      id: "session_leaf_pointer_only",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    });

    const root = createTextMessage("user", "root request");
    const abandoned = createTextMessage("assistant", "abandoned answer");
    await recorder.recordMessage(root);
    const rootEntry = store.entries.at(-1);
    await recorder.recordMessage(abandoned);
    await recorder.recordLeafPointer(rootEntry?.id ?? null, "rewind-preview");

    expect(findSessionLeafId(store.entries)).toBe(rootEntry?.id);
    expect(buildSessionContextFromEntries(store.entries).map((message) => message.id)).toEqual([root.id]);
  });

  it("roundtrips leaf pointers through JSONL session persistence", async () => {
    const sessionPath = join(tempRoot, "leaf-pointer.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_jsonl_leaf_pointer",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    const store = new JsonlSessionStore(sessionPath, { mode: "resume-or-create" });
    await store.open(header);
    const recorder = new SessionRecorder(store);

    const root = createTextMessage("user", "root request");
    const abandoned = createTextMessage("assistant", "abandoned answer");
    await recorder.recordMessage(root);
    const rootEntry = (await store.readAll()).at(-1);
    await recorder.recordMessage(abandoned);
    await recorder.recordLeafPointer(rootEntry?.id ?? null, "rewind-user-message", { runId: "run_rewind" });

    const reopened = new JsonlSessionStore(sessionPath, { mode: "append" });
    await reopened.open(header);
    const entries = await reopened.readAll();
    const pointer = entries.at(-1);

    expect(pointer).toMatchObject({
      type: "leaf-pointer",
      targetLeafId: rootEntry?.id,
      reason: "rewind-user-message",
      metadata: { runId: "run_rewind" }
    });
    expect(findSessionLeafId(entries)).toBe(rootEntry?.id);
    expect(buildSessionContextFromEntries(entries).map((message) => message.id)).toEqual([root.id]);
  });

  it("moves a persisted session leaf through the shared helper", async () => {
    const sessionPath = join(tempRoot, "move-leaf.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_move_leaf",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    const store = new JsonlSessionStore(sessionPath, { mode: "resume-or-create" });
    await store.open(header);
    const recorder = new SessionRecorder(store);
    const root = createTextMessage("user", "root request");
    const abandoned = createTextMessage("assistant", "abandoned answer");
    await recorder.recordMessage(root);
    const rootEntry = (await store.readAll()).at(-1);
    await recorder.recordMessage(abandoned);

    const result = await moveSessionLeaf(store, rootEntry?.id ?? null, {
      reason: "conversation-rewind",
      metadata: { runId: "run_rewind" }
    });
    const entries = await store.readAll();

    expect(result).toMatchObject({
      previousLeafId: expect.any(String),
      targetLeafId: rootEntry?.id,
      pointerEntry: {
        type: "leaf-pointer",
        targetLeafId: rootEntry?.id,
        reason: "conversation-rewind",
        metadata: { runId: "run_rewind" }
      }
    });
    expect(entries.at(-1)).toEqual(result.pointerEntry);
    expect(findSessionLeafId(entries)).toBe(rootEntry?.id);
    expect(buildSessionContextFromEntries(entries).map((message) => message.id)).toEqual([root.id]);
  });

  it("rejects moving the session leaf to missing or non-model-context entries", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    await store.open({
      type: "session",
      id: "session_move_leaf_reject",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    });
    await recorder.recordMessage(createTextMessage("user", "root request"));
    await recorder.recordEvent({ type: "agent-start", sessionId: "session_move_leaf_reject", timestamp: nowIso() });
    const eventEntry = store.entries.at(-1);
    await recorder.recordLeafPointer(null, "clear");
    const pointerEntry = store.entries.at(-1);

    await expect(moveSessionLeaf(store, "missing_leaf")).rejects.toThrow(/not found/);
    await expect(moveSessionLeaf(store, eventEntry?.id ?? null)).rejects.toThrow(/must be a message, checkpoint, or compaction/);
    await expect(moveSessionLeaf(store, pointerEntry?.id ?? null)).rejects.toThrow(/must be a message, checkpoint, or compaction/);
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

  it("skips malformed JSONL entry lines and rewrites a clean session file", async () => {
    const sessionPath = join(tempRoot, "bad-lines.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_bad_lines",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    const validEntry: SessionEntry = {
      type: "message",
      id: "entry_valid",
      parentId: null,
      timestamp: nowIso(),
      message: createTextMessage("user", "kept")
    };
    await writeFile(
      sessionPath,
      [
        JSON.stringify(header),
        "{not json",
        JSON.stringify({ type: "unknown", id: "entry_bad", parentId: null, timestamp: nowIso() }),
        JSON.stringify(validEntry)
      ].join("\n"),
      "utf8"
    );

    const store = new JsonlSessionStore(sessionPath, { mode: "append" });
    await store.open(header);

    const entries = await store.readAll();
    const repaired = await readFile(sessionPath, "utf8");
    const repairedLines = repaired.trim().split(/\r?\n/);

    expect(entries).toEqual([validEntry]);
    expect(repaired).not.toContain("{not json");
    expect(repaired).not.toContain("entry_bad");
    expect(repairedLines).toHaveLength(2);
    expect(JSON.parse(repairedLines[0]!).version).toBe(1);
  });

  it("migrates legacy JSONL session headers without a version", async () => {
    const sessionPath = join(tempRoot, "legacy-header.jsonl");
    const legacyHeader = {
      type: "session" as const,
      id: "session_legacy",
      cwd: "C:/repo",
      createdAt: nowIso()
    };
    const currentHeader: SessionHeader = { ...legacyHeader, version: 1 };
    await writeFile(sessionPath, `${JSON.stringify(legacyHeader)}\n`, "utf8");

    const store = new JsonlSessionStore(sessionPath, { mode: "append" });
    await store.open(currentHeader);

    const repaired = await readFile(sessionPath, "utf8");
    expect(JSON.parse(repaired.trim()).version).toBe(1);
  });

  it("rejects unsupported JSONL session header versions", async () => {
    const sessionPath = join(tempRoot, "future-header.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_future",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    await writeFile(sessionPath, `${JSON.stringify({ ...header, version: 2 })}\n`, "utf8");

    const store = new JsonlSessionStore(sessionPath, { mode: "append" });
    await expect(store.open(header)).rejects.toThrow(/Unsupported session file version 2/);
  });

  it("starts a new line before appending after an unterminated partial entry", async () => {
    const sessionPath = join(tempRoot, "partial-append.jsonl");
    const header: SessionHeader = {
      type: "session",
      id: "session_partial_append",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    };
    const appendedEntry: SessionEntry = {
      type: "message",
      id: "entry_after_partial",
      parentId: null,
      timestamp: nowIso(),
      message: createTextMessage("assistant", "after partial")
    };

    const store = new JsonlSessionStore(sessionPath, { mode: "resume-or-create" });
    await store.open(header);
    await appendFile(sessionPath, '{"type":"message"', "utf8");
    await store.append(appendedEntry);

    const entries = await store.readAll();
    const repaired = await readFile(sessionPath, "utf8");

    expect(entries).toEqual([appendedEntry]);
    expect(repaired).not.toContain('{"type":"message"\n');
    expect(repaired.trim().split(/\r?\n/)).toHaveLength(2);
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

function textBlock(message: AgentMessage | undefined): string | undefined {
  const block = message?.blocks[0];
  return block?.type === "text" ? block.text : undefined;
}
