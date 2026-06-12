import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  conversationBoundaryManifestRecordToRewindTargetFacts,
  ConversationBoundaryManifestService,
  createConversationBoundaryManifestRecord,
  findLatestConversationBoundaryManifestRecord,
  parseConversationBoundaryManifestRecord,
  readConversationBoundaryManifest,
  serializeConversationBoundaryManifestRecord
} from "./conversation-boundary-manifest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("conversation boundary manifest", () => {
  it("creates stable records and roundtrips JSON", () => {
    const workspaceRoot = resolve("workspace");
    const record = createConversationBoundaryManifestRecord(
      {
        sessionId: "session_1",
        runId: "run_1",
        userMessageId: "msg_user_1",
        sessionTreeLeafIdBefore: "tree_leaf_before",
        sessionTreeLeafIdAfter: "tree_leaf_after",
        runtimeLeafIdBefore: "runtime_leaf_before",
        runtimeLeafIdAfter: "runtime_leaf_after",
        eventSequence: 12,
        workspaceRoot,
        checkpoint: { id: "checkpoint_1", ref: "artifact://checkpoint/1", source: "runtime" },
        changedPaths: ["src/b.ts", "src/a.ts", "src/a.ts"],
        metadata: { reason: "rewind-boundary", attempts: 1 }
      },
      () => "2026-01-01T00:00:00.000Z"
    );

    expect(record).toEqual({
      sessionId: "session_1",
      runId: "run_1",
      userMessageId: "msg_user_1",
      sessionTreeLeafIdBefore: "tree_leaf_before",
      sessionTreeLeafIdAfter: "tree_leaf_after",
      runtimeLeafIdBefore: "runtime_leaf_before",
      runtimeLeafIdAfter: "runtime_leaf_after",
      eventSequence: 12,
      workspaceRoot,
      checkpointId: "checkpoint_1",
      checkpointRef: "artifact://checkpoint/1",
      checkpointSource: "runtime",
      changedPaths: ["src/a.ts", "src/b.ts"],
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { reason: "rewind-boundary", attempts: 1 }
    });

    expect(parseConversationBoundaryManifestRecord(serializeConversationBoundaryManifestRecord(record))).toEqual(record);
  });

  it("appends, lists, and finds the latest matching boundary", async () => {
    const dir = await tempDir();
    const manifest = new ConversationBoundaryManifestService({
      manifestPath: join(dir, "boundaries.jsonl"),
      now: fixedClock()
    });

    await manifest.append(baseInput({ userMessageId: "msg_1", eventSequence: 1 }));
    const latest = await manifest.append(baseInput({ userMessageId: "msg_2", eventSequence: 2 }));
    await manifest.append(baseInput({ sessionId: "session_other", userMessageId: "msg_3", eventSequence: 3 }));

    expect(await manifest.list({ sessionId: "session_1" })).toHaveLength(2);
    expect(await manifest.findLatest({ sessionId: "session_1" })).toEqual(latest);
    expect(await manifest.findLatest({ userMessageId: "msg_1" })).toMatchObject({ userMessageId: "msg_1" });
  });

  it("serializes concurrent appends in one process", async () => {
    const dir = await tempDir();
    const manifest = new ConversationBoundaryManifestService({
      manifestPath: join(dir, "boundaries.jsonl"),
      now: fixedClock()
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        manifest.append(baseInput({ userMessageId: `msg_${index}`, eventSequence: index }))
      )
    );

    const result = await manifest.read();

    expect(result.invalidRecords).toEqual([]);
    expect(result.records).toHaveLength(12);
    expect(new Set(result.records.map((record) => record.userMessageId)).size).toBe(12);
  });

  it("finds latest in pure record collections by timestamp then sequence", () => {
    const older = createConversationBoundaryManifestRecord(baseInput({ eventSequence: 100, createdAt: "2026-01-01T00:00:00.000Z" }));
    const newer = createConversationBoundaryManifestRecord(baseInput({ eventSequence: 2, createdAt: "2026-01-01T00:00:01.000Z" }));
    const sameTimeHigherSequence = createConversationBoundaryManifestRecord(
      baseInput({ userMessageId: "msg_same", eventSequence: 3, createdAt: "2026-01-01T00:00:01.000Z" })
    );

    expect(findLatestConversationBoundaryManifestRecord([older, newer, sameTimeHigherSequence])).toEqual(sameTimeHigherSequence);
  });

  it("projects explicit rewind target facts for keeping or removing the user message", () => {
    const boundary = createConversationBoundaryManifestRecord(baseInput());

    expect(conversationBoundaryManifestRecordToRewindTargetFacts(boundary, "keep-user-message")).toMatchObject({
      sessionId: "session_1",
      runId: "run_1",
      userMessageId: "msg_user_1",
      mode: "keep-user-message",
      sessionTreeTargetLeafId: "tree_leaf_after",
      runtimeTargetLeafId: "runtime_leaf_after",
      checkpointId: "checkpoint_1",
      checkpointRef: "checkpoint://1",
      changedPaths: ["src/file.ts"]
    });
    expect(conversationBoundaryManifestRecordToRewindTargetFacts(boundary, "remove-user-message")).toMatchObject({
      mode: "remove-user-message",
      sessionTreeTargetLeafId: "tree_leaf_before",
      runtimeTargetLeafId: "runtime_leaf_before"
    });
  });

  it("skips corrupt lines while preserving valid records", async () => {
    const dir = await tempDir();
    const manifestPath = join(dir, "boundaries.jsonl");
    const valid = createConversationBoundaryManifestRecord(baseInput({ userMessageId: "msg_valid" }));
    await writeFile(
      manifestPath,
      [
        serializeConversationBoundaryManifestRecord(valid),
        "{not json",
        JSON.stringify({ ...valid, userMessageId: "" }),
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await readConversationBoundaryManifest(manifestPath);

    expect(result.records).toEqual([valid]);
    expect(result.invalidRecords).toHaveLength(2);
    expect(result.invalidRecords.map((record) => record.line)).toEqual([2, 3]);
  });

  it("rejects changed paths outside the workspace root", () => {
    expect(() => createConversationBoundaryManifestRecord(baseInput({ changedPaths: ["../outside.ts"] }))).toThrow(
      "changed path escapes workspace root"
    );
  });
});

function baseInput(
  overrides: Partial<Parameters<typeof createConversationBoundaryManifestRecord>[0]> = {}
): Parameters<typeof createConversationBoundaryManifestRecord>[0] {
  return {
    sessionId: "session_1",
    runId: "run_1",
    userMessageId: "msg_user_1",
    sessionTreeLeafIdBefore: "tree_leaf_before",
    sessionTreeLeafIdAfter: "tree_leaf_after",
    runtimeLeafIdBefore: "runtime_leaf_before",
    runtimeLeafIdAfter: "runtime_leaf_after",
    eventSequence: 1,
    workspaceRoot: resolve("workspace"),
    checkpointId: "checkpoint_1",
    checkpointRef: "checkpoint://1",
    checkpointSource: "runtime",
    changedPaths: ["src/file.ts"],
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: { source: "test" },
    ...overrides
  };
}

function fixedClock(): () => string {
  let tick = 0;
  return () => `2026-01-01T00:00:0${tick++}.000Z`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-runtime-boundary-"));
  tempDirs.push(dir);
  return dir;
}
