import { describe, expect, it } from "vitest";
import { buildSubagentContextPack } from "./subagent-context-pack";
import type { ContextStateSnapshot } from "./types";

describe("subagent context pack", () => {
  it("keeps the stable prefix hash unchanged when only volatile task or runtime scope changes", () => {
    const base = {
      mode: "implement" as const,
      cwd: "C:/repo",
      parentSessionId: "parent",
      baseSystemPrompt: "Follow the product architecture.",
      policyPack: ["Keep the daemon path single-track."],
      projectProgress: ["Runtime and daemon are the main path."],
      recentSubagentTasks: ["Task[completed]: old worker"]
    };

    const first = buildSubagentContextPack({
      ...base,
      parentRunId: "run_a",
      forkPolicy: "summary",
      contextState: parentSnapshot("Parent summary A"),
      prompt: "Implement approval expiry.",
      description: "approval expiry"
    });
    const second = buildSubagentContextPack({
      ...base,
      cwd: "D:/other-repo",
      parentRunId: "run_b",
      forkPolicy: "task-only",
      contextState: parentSnapshot("Parent summary B"),
      recentSubagentTasks: ["Task[in_progress]: newer worker"],
      prompt: "Implement provider config precedence.",
      description: "provider config"
    });

    expect(first.cache.stablePrefixHash).toBe(second.cache.stablePrefixHash);
    expect(first.cache.volatileContextHash).not.toBe(second.cache.volatileContextHash);
    expect(first.cache.taskCardHash).not.toBe(second.cache.taskCardHash);
    expect(first.cache.volatileTaskHash).toBe(first.cache.taskCardHash);
    expect(first.cache.cacheKey).toBe(second.cache.cacheKey);
    expect(first.cache.boundary.stablePrefix).toEqual(["baseSystemPrompt", "policyPack", "sharedProjectProgress"]);
    expect(first.cache.boundary.volatileContext).toEqual(expect.arrayContaining(["cwd", "parentRunId", "recentSubagentTasks", "structuredSummary"]));
    expect(first.cache.boundary.taskCard).toEqual(expect.arrayContaining(["objective", "writeScope", "verificationCommands"]));
    expect(first.stablePrefix).not.toContain("run_a");
    expect(first.stablePrefix).not.toContain("C:/repo");
    expect(first.volatileContext).toContain("run_a");
    expect(first.volatileContext).toContain("Task[completed]: old worker");
  });

  it("excludes parent context when fork policy is task-only", () => {
    const pack = buildSubagentContextPack({
      forkPolicy: "task-only",
      mode: "research",
      cwd: "C:/repo",
      prompt: "Audit status projection.",
      contextState: parentSnapshot()
    });

    expect(pack.stablePrefix).not.toContain("Parent Context Snapshot");
    expect(pack.volatileContext).not.toContain("Previous Compression Summary");
    expect(pack.cache.boundary.volatileContext).not.toContain("structuredSummary");
    expect(pack.taskCard).toContain("Audit status projection.");
  });

  it("includes compression summary and recent task records in the volatile context for summary forks", () => {
    const pack = buildSubagentContextPack({
      forkPolicy: "summary",
      mode: "verify",
      cwd: "C:/repo",
      prompt: "Verify daemon tests.",
      recentSubagentTasks: ["Task[completed]: Copernicus - durable event store"],
      contextState: parentSnapshot()
    });

    expect(pack.stablePrefix).not.toContain("Parent Context Snapshot");
    expect(pack.stablePrefix).not.toContain("Copernicus");
    expect(pack.volatileContext).toContain("Parent Context Snapshot");
    expect(pack.volatileContext).toContain("Parent summary");
    expect(pack.volatileContext).toContain("daemon snapshot completed");
    expect(pack.volatileContext).toContain("pending config cleanup");
    expect(pack.volatileContext).toContain("Task[completed]: Copernicus - durable event store");
  });

  it("uses full fork policy for a larger volatile parent snapshot without changing the stable prefix", () => {
    const state = numberedSnapshot();
    const summary = buildSubagentContextPack({
      forkPolicy: "summary",
      mode: "research",
      cwd: "C:/repo",
      prompt: "Map prompt cache boundaries.",
      policyPack: ["Single product path."],
      projectProgress: ["Prompt prefix is stable."],
      contextState: state
    });
    const full = buildSubagentContextPack({
      forkPolicy: "full",
      mode: "research",
      cwd: "C:/repo",
      prompt: "Map prompt cache boundaries.",
      policyPack: ["Single product path."],
      projectProgress: ["Prompt prefix is stable."],
      contextState: state
    });

    expect(summary.cache.stablePrefixHash).toBe(full.cache.stablePrefixHash);
    expect(summary.cache.cacheKey).toBe(full.cache.cacheKey);
    expect(summary.cache.volatileContextHash).not.toBe(full.cache.volatileContextHash);
    expect(summary.volatileContext).not.toContain("- completed-1\n");
    expect(full.volatileContext).toContain("- completed-1\n");
    expect(full.cache.boundary.volatileContext).toEqual(expect.arrayContaining(["structuredSummary", "completedTaskSummaries", "sessionEvents", "fileSnapshotHints"]));
    expect(full.stablePrefix).not.toContain("completed-1");
  });

  it("changes the stable prefix only when shared principles or global progress changes", () => {
    const first = buildSubagentContextPack({
      mode: "implement",
      cwd: "C:/repo",
      prompt: "Implement a protocol guard.",
      policyPack: ["Single product path."],
      projectProgress: ["Daemon owns product state."]
    });
    const second = buildSubagentContextPack({
      mode: "implement",
      cwd: "C:/repo",
      prompt: "Implement a protocol guard.",
      policyPack: ["Single product path."],
      projectProgress: ["Daemon owns product state.", "Runtime owns tools."]
    });

    expect(first.cache.stablePrefixHash).not.toBe(second.cache.stablePrefixHash);
    expect(first.cache.cacheKey).toMatch(/^subagent-context:v2:/);
  });
});

function parentSnapshot(summary = "Parent summary"): ContextStateSnapshot {
  return {
    previousCompressionSummary: summary,
    completedTaskSummaries: ["daemon snapshot completed"],
    pendingTasks: ["pending config cleanup"],
    sessionEvents: ["event: sidecar restarted"],
    fileSnapshotHints: ["packages/agent-daemon/src/server.ts: lifecycle"]
  };
}

function numberedSnapshot(): ContextStateSnapshot {
  return {
    previousCompressionSummary: "Parent summary",
    completedTaskSummaries: Array.from({ length: 20 }, (_, index) => `completed-${index + 1}`),
    pendingTasks: Array.from({ length: 20 }, (_, index) => `pending-${index + 1}`),
    sessionEvents: Array.from({ length: 20 }, (_, index) => `event-${index + 1}`),
    fileSnapshotHints: Array.from({ length: 20 }, (_, index) => `src/file-${index + 1}.ts: hint`)
  };
}
