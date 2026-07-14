import { describe, expect, it, beforeEach } from "vitest";
import {
  ScriptWaitPolicy,
  commandFamily,
  suggestRunMode,
  NOISY_POLL_THRESHOLD,
  PARALLEL_SOFT_LIMIT_MS,
  resetSharedScriptWaitPolicyForTests,
} from "./script-wait-policy";

describe("script-wait-policy", () => {
  beforeEach(() => {
    resetSharedScriptWaitPolicyForTests();
  });

  it("classifies common command families", () => {
    expect(commandFamily("npm run build")).toBe("package-build");
    expect(commandFamily("pnpm test")).toBe("package-test");
    expect(commandFamily("git status")).toMatch(/git/);
  });

  it("suggests wait for short historical commands", () => {
    expect(suggestRunMode("npm run build", 5_000)).toBe("wait");
    expect(suggestRunMode("npm run build", 180_000)).toBe("continue");
  });

  it("forces wait after noisy short polls on long runners", () => {
    const p2 = new ScriptWaitPolicy();
    const meta = p2.registerStart("task-long", "npm run build --production", "continue");
    // inject fake history for package-build family
    (p2 as unknown as { familyDurations: Map<string, number[]> }).familyDurations.set(meta.family, [
      180_000,
      200_000,
      220_000,
    ]);

    const taskId = meta.taskId;
    let last = p2.recordPoll(taskId, 5_000);
    for (let i = 0; i < NOISY_POLL_THRESHOLD; i++) {
      last = p2.recordPoll(taskId, 10_000 + i * 3_000);
    }
    expect(last.forceWait).toBe(true);
    expect(last.hint.length).toBeGreaterThan(10);
  });

  it("soft-hints after parallel budget without force-killing semantics", () => {
    const policy = new ScriptWaitPolicy();
    policy.registerStart("t2", "node server.js", "continue");
    const advice = policy.recordPoll("t2", PARALLEL_SOFT_LIMIT_MS + 1_000);
    expect(advice.forceWait).toBe(false);
    expect(advice.hint).toMatch(/2 分钟|等待/);
  });

  it("startGuidance differs by mode", () => {
    const policy = new ScriptWaitPolicy();
    const waitMeta = policy.registerStart("a", "git status", "wait");
    const contMeta = policy.registerStart("b", "npm run build", "continue");
    expect(policy.startGuidance(waitMeta)).toMatch(/等待/);
    expect(policy.startGuidance(contMeta)).toMatch(/后台/);
  });
});
