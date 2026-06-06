import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryTools, InMemoryMemoryStore, JsonlMemoryStore } from ".";
import type { ToolExecutionContext } from "./types";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-memory-"));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return {
    toolCallId: "call",
    sessionId: "session",
    cwd: workspaceRoot,
    signal: new AbortController().signal,
    emit: () => undefined
  };
}

describe("memory stores and tools", () => {
  it("persists and searches JSONL memory", async () => {
    const store = new JsonlMemoryStore(join(workspaceRoot, "memory.jsonl"));
    await store.remember({ scope: "project", content: "Prefer pnpm for this project", tags: ["package-manager"] });
    await store.remember({ scope: "user", content: "User prefers concise answers", tags: ["style"] });

    await expect(store.search({ query: "pnpm" })).resolves.toMatchObject([{ scope: "project" }]);
    await expect(store.search({ scope: "user" })).resolves.toMatchObject([{ content: "User prefers concise answers" }]);
  });

  it("exposes remember and search tools", async () => {
    const [remember, search] = createMemoryTools(new InMemoryMemoryStore());
    await remember!.execute({ content: "Use read-only subagents for review", tags: ["agent"] }, context());

    const output = await search!.execute({ query: "subagents" }, context());

    expect(output.text).toContain("read-only subagents");
    expect(output.json).toMatchObject({ matches: [{ scope: "project" }] });
  });
});
