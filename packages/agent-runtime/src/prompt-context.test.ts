import { describe, expect, it } from "vitest";
import { assemblePromptForProvider, createTextMessage } from ".";
import { ProjectProgressLedger } from "./project-progress-ledger";
import { composePromptContext } from "./prompt-context";
import { resolveScopedContext } from "./scoped-context";

describe("prompt context composer", () => {
  it("keeps scoped context and stable project progress in stable blocks", () => {
    const scoped = resolveScopedContext({
      cwd: "C:/Software/conex",
      projectRoot: "C:/Software/conex",
      rules: [{ id: "single-track", text: "Use daemon as the product state source.", activation: "enabled" }]
    });
    const ledger = new ProjectProgressLedger({ now: () => "2026-01-01T00:00:00.000Z" });
    ledger.addStablePrinciple({ text: "Keep prompt stable context before task input." });
    ledger.recordSubagentTask({ id: "task_1", agentId: "agent", title: "Implement API", status: "in_progress" });

    const composed = composePromptContext({ scopedContext: scoped, projectProgress: ledger });

    expect(composed.stableContext.map((block) => block.id)).toEqual(["scoped-context:rules", "project-progress:stable"]);
    expect(composed.volatileContext.map((block) => block.id)).toEqual(["project-progress:recent-tasks"]);
    expect(composed.metadata.boundary).toMatchObject({
      stable: {
        globalProjectRules: ["scoped-context:rules"],
        sharedProjectProgress: ["project-progress:stable"]
      },
      volatile: {
        recentChildTaskRecords: ["project-progress:recent-tasks"]
      }
    });
    expect(JSON.stringify(composed.stableContext)).toContain("Use daemon as the product state source.");
    expect(JSON.stringify(composed.volatileContext)).toContain("Task[in_progress]: agent/task_1");
  });

  it("classifies enabled skills as stable and runtime/task/user inputs as volatile metadata", () => {
    const composed = composePromptContext({
      stableContext: [
        {
          id: "enabled-skills:runtime",
          kind: "skills-hook",
          content: { skills: ["typescript"] }
        }
      ],
      volatileContext: [
        {
          id: "parent-run:id",
          kind: "runtime-profile",
          content: { parentRunId: "run_1" }
        },
        {
          id: "cwd:current",
          kind: "runtime-profile",
          content: { cwd: "C:/repo" }
        },
        {
          id: "task-card:current",
          kind: "custom-volatile",
          content: { objective: "Do task A" }
        },
        {
          id: "current-user-turn:latest",
          kind: "custom-volatile",
          content: { text: "latest turn" }
        }
      ]
    });

    expect(composed.metadata.boundary.stable.enabledSkills).toEqual(["enabled-skills:runtime"]);
    expect(composed.metadata.boundary.volatile).toMatchObject({
      parentRuntimeIds: ["parent-run:id"],
      cwd: ["cwd:current"],
      taskCard: ["task-card:current"],
      currentUserTurn: ["current-user-turn:latest"]
    });
    expect(composed.metadata.stableBlockIds).toEqual(["enabled-skills:runtime"]);
    expect(composed.metadata.volatileBlockIds).toEqual([
      "parent-run:id",
      "cwd:current",
      "task-card:current",
      "current-user-turn:latest"
    ]);
  });

  it("changes only volatile hash when recent subagent task records change", () => {
    const first = composePromptContext({
      projectProgress: {
        stableLines: ["Principle: Single backend path"],
        recentTaskLines: ["Task[completed]: a"]
      }
    });
    const second = composePromptContext({
      projectProgress: {
        stableLines: ["Principle: Single backend path"],
        recentTaskLines: ["Task[in_progress]: b"]
      }
    });

    expect(first.metadata.stableContextHash).toBe(second.metadata.stableContextHash);
    expect(first.metadata.volatileContextHash).not.toBe(second.metadata.volatileContextHash);
  });

  it("preserves PromptAssembly stable prefix across current user turn changes", () => {
    const scoped = resolveScopedContext({
      cwd: "C:/Software/conex",
      rules: [{ id: "cache-rule", text: "Keep rules deterministic.", activation: "enabled" }]
    });
    const context = composePromptContext({ scopedContext: scoped });

    const first = assemblePromptForProvider({
      systemPrompt: "You are Conex.",
      stableContext: context.stableContext,
      volatileContext: context.volatileContext,
      messages: [createTextMessage("user", "Task A")],
      tools: []
    });
    const second = assemblePromptForProvider({
      systemPrompt: "You are Conex.",
      stableContext: context.stableContext,
      volatileContext: context.volatileContext,
      messages: [createTextMessage("user", "Task B")],
      tools: []
    });

    expect(first.metadata.stablePrefixHash).toBe(second.metadata.stablePrefixHash);
  });
});
