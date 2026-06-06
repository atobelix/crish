import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCliRunJsonOutput, parseWorkbenchSnapshotPayload, runCliMain } from "./main";
import type { WorkbenchRunnerYield } from "./workbench-runner";
import { applyUserGoal, buildInitialTaskSnapshot } from "../shared/workbench-contract";
import { defaultRunRegistryPath, readRunRegistry } from "./run-registry";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("agent workbench CLI main", () => {
  it("collects streaming workbench events into one JSON payload", async () => {
    const snapshot = buildInitialTaskSnapshot("C:\\repo\\demo");
    const items: WorkbenchRunnerYield[] = [
      {
        snapshot,
        event: {
          type: "run-start",
          message: "\u4efb\u52a1\u5df2\u5f00\u59cb",
          timestamp: "2026-06-05T00:00:00.000Z"
        }
      },
      {
        snapshot: { ...snapshot, state: "planning" },
        event: {
          type: "run-end",
          message: "\u672c\u8f6e\u6a21\u578b\u8c03\u7528\u5df2\u7ed3\u675f",
          timestamp: "2026-06-05T00:00:01.000Z"
        }
      }
    ];

    const output = await collectCliRunJsonOutput(toAsyncIterable(items));

    expect(output.events.map((event) => event.type)).toEqual(["run-start", "run-end"]);
    expect(output.snapshot?.state).toBe("planning");
    expect(output.decision?.action).toBe("continue");
    expect(output.decision?.prompt).toContain("\u5f53\u524d\u76ee\u6807");
  });

  it("prints status and snapshot from explicit argv", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await runCliMain(["status", "--cwd=C:\\repo\\demo"]);

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as { status: { cwd: string }; snapshot: { project: { path: string } } };
    expect(parsed.status.cwd).toBe("C:\\repo\\demo");
    expect(parsed.snapshot.project.path).toBe("C:\\repo\\demo");
  });

  it("prints continuation prompt using explicit prompt instead of global process argv", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await runCliMain(["continue", "--cwd=C:\\repo\\demo", "--prompt=\u68c0\u67e5\u9879\u76ee\u72b6\u6001"]);

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as { snapshot: { userGoal: string }; decision: { action: string; prompt?: string } };
    expect(parsed.snapshot.userGoal).toBe("\u68c0\u67e5\u9879\u76ee\u72b6\u6001");
    expect(parsed.decision.action).toBe("continue");
    expect(parsed.decision.prompt).toContain("\u68c0\u67e5\u9879\u76ee\u72b6\u6001");
  });

  it("reads UTF-8 prompts from an explicit prompt file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-prompt-"));
    const promptPath = join(tempDir, "prompt.txt");
    await writeFile(promptPath, "\u68c0\u67e5\u4e2d\u6587\u63d0\u793a\u8bcd\u7f16\u7801", "utf8");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    try {
      await runCliMain(["continue", "--cwd=C:\\repo\\demo", `--prompt-file=${promptPath}`]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as { snapshot: { userGoal: string }; decision: { prompt?: string } };
    expect(parsed.snapshot.userGoal).toBe("\u68c0\u67e5\u4e2d\u6587\u63d0\u793a\u8bcd\u7f16\u7801");
    expect(parsed.decision.prompt).toContain("\u68c0\u67e5\u4e2d\u6587\u63d0\u793a\u8bcd\u7f16\u7801");
  });

  it("parses snapshots from goal JSON payloads and newline logs", () => {
    const first = { ...buildInitialTaskSnapshot("C:\\repo\\demo"), userGoal: "\u539f\u59cb\u76ee\u6807" };
    const second = { ...first, userGoal: "\u7ee7\u7eed\u76ee\u6807", completionPercent: 42 };

    expect(parseWorkbenchSnapshotPayload(JSON.stringify({ snapshot: first }))?.userGoal).toBe("\u539f\u59cb\u76ee\u6807");
    expect(
      parseWorkbenchSnapshotPayload(
        [
          JSON.stringify({ type: "snapshot", snapshot: first }),
          JSON.stringify({ type: "goal-end", snapshot: second })
        ].join("\n")
      )?.completionPercent
    ).toBe(42);
    expect(parseWorkbenchSnapshotPayload(`> npm run cli\n${JSON.stringify({ snapshot: second }, null, 2)}`)?.userGoal).toBe(
      "\u7ee7\u7eed\u76ee\u6807"
    );
  });

  it("prints background demo snapshots and continuation decision", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await runCliMain(["background-demo", "--cwd=C:\\repo\\demo", "--prompt=\u540e\u53f0\u68c0\u67e5"]);

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]!) as {
      started: { backgroundTasks: Array<{ state: string }> };
      finished: { backgroundTasks: Array<{ state: string }> };
      decision: { action: string };
    };
    expect(parsed.started.backgroundTasks[0]?.state).toBe("running");
    expect(parsed.finished.backgroundTasks[0]?.state).toBe("succeeded");
    expect(parsed.decision.action).toBe("continue");
  });

  it("uses the explicit JSON config for run-json provider requests", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-config-"));
    const configDir = join(tempDir, ".tmp");
    const configPath = join(configDir, "provider.json");
    const promptPath = join(tempDir, "prompt.txt");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          id: "mimo-token-plan-test",
          baseUrl: "https://token-plan-cn.xiaomimimo.com",
          endpoint: "chat-completions",
          authHeader: "api-key",
          apiKey: "test-token",
          model: "mimo-v2.5",
          maxTokensField: "max_completion_tokens",
          stream: false,
          diagnostics: false
        },
        runBudget: {
          defaultDifficulty: "normal",
          profiles: {
            normal: {
              maxTotalTokens: 200000,
              maxTurns: 1,
              requestMaxOutputTokens: 32000
            }
          }
        }
      }),
      "utf8"
    );
    await writeFile(promptPath, "hi", "utf8");

    const logs: string[] = [];
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> = {};
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    globalThis.fetch = vi.fn(async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      await runCliMain(["run-json", `--cwd=${tempDir}`, "--config=.tmp/provider.json", "--prompt-file=prompt.txt", "--max-turns=1"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(requestUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    expect(requestHeaders?.get("api-key")).toBe("test-token");
    expect(requestHeaders?.get("authorization")).toBeNull();
    expect(requestBody.model).toBe("mimo-v2.5");
    expect(requestBody.max_completion_tokens).toBe(32_000);
    expect(JSON.parse(logs[0]!) as { events: unknown[] }).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ type: "run-start" })])
    });
  });

  it("writes line-delimited run events to an explicit UTF-8 event log", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-event-log-"));
    const configPath = join(tempDir, "provider.json");
    const eventLogPath = join(tempDir, "events.jsonl");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          id: "utf8-event-log-test",
          baseUrl: "https://token-plan-cn.xiaomimimo.com",
          endpoint: "chat-completions",
          authHeader: "api-key",
          apiKey: "test-token",
          model: "mimo-v2.5",
          maxTokensField: "max_completion_tokens",
          stream: false,
          diagnostics: false
        }
      }),
      "utf8"
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "\u4e2d\u6587\u4efb\u52a1\u5df2\u7ee7\u7eed" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      await runCliMain([
        "run",
        `--cwd=${tempDir}`,
        `--config=${configPath}`,
        "--prompt=\u7ee7\u7eed\u68c0\u67e5\u4e2d\u6587\u7f16\u7801",
        "--max-turns=1",
        `--event-log=${eventLogPath}`
      ]);
      const bytes = await readFile(eventLogPath);
      const text = bytes.toString("utf8");

      expect(bytes[0]).not.toBe(0xff);
      expect(text).toContain("\u4efb\u52a1\u5df2\u5f00\u59cb");
      expect(text).toContain("\u4e2d\u6587\u4efb\u52a1\u5df2\u7ee7\u7eed");
      expect(text.trim().split(/\r?\n/).every((line) => JSON.parse(line))).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resumes the latest registered goal run without explicit session or config arguments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-resume-latest-"));
    const registryPath = defaultRunRegistryPath(tempDir);
    const configPath = join(tempDir, "provider.json");
    const sessionPath = join(tempDir, ".codex", "agent-runs", "old-session.jsonl");
    const eventLogPath = join(tempDir, ".codex", "agent-runs", "old-events.jsonl");
    const outputRoot = join(tempDir, "agent-control-console");
    const oldSnapshot = applyUserGoal(buildInitialTaskSnapshot(tempDir), "\u7ee7\u7eed\u5b8c\u6210\u65e7\u4efb\u52a1");
    await mkdir(join(tempDir, ".codex", "agent-runs"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          id: "resume-latest-provider",
          baseUrl: "https://example.test",
          endpoint: "chat-completions",
          authHeader: "api-key",
          apiKey: "test-token",
          model: "mimo-v2.5",
          maxTokensField: "max_completion_tokens",
          stream: false,
          diagnostics: false
        }
      }),
      "utf8"
    );
    await writeFile(eventLogPath, `${JSON.stringify({ type: "snapshot", snapshot: oldSnapshot })}\n`, "utf8");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-06-05T00:00:00.000Z",
          records: [
            {
              id: "run_old",
              branchId: "branch_old",
              command: "goal-run",
              cwd: tempDir,
              createdAt: "2026-06-05T00:00:00.000Z",
              updatedAt: "2026-06-05T00:00:00.000Z",
              status: "paused",
              providerId: "resume-latest-provider",
              modelId: "mimo-v2.5",
              sessionPath,
              eventLogPath,
              configPath,
              outputRoot,
              userGoalPreview: "\u7ee7\u7eed\u5b8c\u6210\u65e7\u4efb\u52a1"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const logs: string[] = [];
    let requestUrl = "";
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    globalThis.fetch = vi.fn(async (input) => {
      requestUrl = String(input);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "\u5df2\u7ee7\u7eed\u68c0\u67e5\u65e7\u4efb\u52a1" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      await runCliMain(["goal-json", `--cwd=${tempDir}`, "--resume-latest", "--prompt=\u7ee7\u7eed", "--max-rounds=1", "--max-turns=1"]);
      const parsed = JSON.parse(logs[0]!) as { rounds: Array<{ prompt: string }> };
      const registry = await readRunRegistry(registryPath);
      const newest = registry.records.at(-1);

      expect(requestUrl).toBe("https://example.test/v1/chat/completions");
      expect(parsed.rounds[0]?.prompt).toContain("\u7ee7\u7eed\u5b8c\u6210\u65e7\u4efb\u52a1");
      expect(newest).toMatchObject({
        parentRunId: "run_old",
        parentBranchId: "branch_old",
        sessionPath,
        configPath,
        outputRoot
      });
      expect(registry.records).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips transient gateway error child runs when resuming the latest task line", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-resume-transient-error-"));
    const registryPath = defaultRunRegistryPath(tempDir);
    const parentConfigPath = join(tempDir, "parent-provider.json");
    const childConfigPath = join(tempDir, "child-provider.json");
    const parentSessionPath = join(tempDir, ".codex", "agent-runs", "parent-session.jsonl");
    const parentEventLogPath = join(tempDir, ".codex", "agent-runs", "parent-events.jsonl");
    const childEventLogPath = join(tempDir, ".codex", "agent-runs", "child-events.jsonl");
    const outputRoot = join(tempDir, "agent-control-console");
    const parentSnapshot = applyUserGoal(buildInitialTaskSnapshot(tempDir), "\u7ee7\u7eed\u5b8c\u6210\u7236\u4efb\u52a1\u7ebf");
    await mkdir(join(tempDir, ".codex", "agent-runs"), { recursive: true });
    await writeFile(
      parentConfigPath,
      JSON.stringify({
        provider: {
          id: "parent-provider",
          baseUrl: "https://parent.example.test",
          endpoint: "chat-completions",
          authHeader: "api-key",
          apiKey: "test-token",
          model: "mimo-v2.5",
          maxTokensField: "max_completion_tokens",
          stream: false,
          diagnostics: false
        }
      }),
      "utf8"
    );
    await writeFile(
      childConfigPath,
      JSON.stringify({
        provider: {
          id: "child-provider",
          baseUrl: "https://child.example.test",
          endpoint: "chat-completions",
          authHeader: "api-key",
          apiKey: "test-token",
          model: "mimo-v2.5",
          maxTokensField: "max_completion_tokens",
          stream: false,
          diagnostics: false
        }
      }),
      "utf8"
    );
    await writeFile(parentEventLogPath, `${JSON.stringify({ type: "snapshot", snapshot: parentSnapshot })}\n`, "utf8");
    await writeFile(childEventLogPath, `${JSON.stringify({ type: "run-error", message: "[gateway-challenge] Cloudflare managed challenge" })}\n`, "utf8");
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-06-05T00:00:02.000Z",
          records: [
            {
              id: "run_parent",
              branchId: "branch_parent",
              command: "goal-run",
              cwd: tempDir,
              createdAt: "2026-06-05T00:00:00.000Z",
              updatedAt: "2026-06-05T00:00:00.000Z",
              status: "paused",
              providerId: "parent-provider",
              modelId: "mimo-v2.5",
              sessionPath: parentSessionPath,
              eventLogPath: parentEventLogPath,
              configPath: parentConfigPath,
              outputRoot,
              userGoalPreview: "\u7ee7\u7eed\u5b8c\u6210\u7236\u4efb\u52a1\u7ebf"
            },
            {
              id: "run_child",
              branchId: "branch_child",
              parentRunId: "run_parent",
              parentBranchId: "branch_parent",
              command: "goal-run",
              cwd: tempDir,
              createdAt: "2026-06-05T00:00:01.000Z",
              updatedAt: "2026-06-05T00:00:01.000Z",
              status: "error",
              providerId: "child-provider",
              modelId: "mimo-v2.5",
              sessionPath: parentSessionPath,
              eventLogPath: childEventLogPath,
              configPath: childConfigPath,
              outputRoot,
              lastMessage: "[gateway-challenge] Cloudflare managed challenge HTML omitted (1000 chars)."
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const logs: string[] = [];
    let requestUrl = "";
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    globalThis.fetch = vi.fn(async (input) => {
      requestUrl = String(input);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "\u5df2\u56de\u5230\u7236\u4efb\u52a1\u7ebf\u7ee7\u7eed" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      await runCliMain(["goal-json", `--cwd=${tempDir}`, "--resume-latest", "--prompt=\u7ee7\u7eed", "--max-rounds=1", "--max-turns=1"]);
      const parsed = JSON.parse(logs[0]!) as { rounds: Array<{ prompt: string }> };
      const registry = await readRunRegistry(registryPath);
      const newest = registry.records.at(-1);

      expect(requestUrl).toBe("https://parent.example.test/v1/chat/completions");
      expect(parsed.rounds[0]?.prompt).toContain("\u7ee7\u7eed\u5b8c\u6210\u7236\u4efb\u52a1\u7ebf");
      expect(newest).toMatchObject({
        parentRunId: "run_parent",
        parentBranchId: "branch_parent",
        providerId: "parent-provider",
        configPath: parentConfigPath,
        outputRoot
      });
      expect(registry.records).toHaveLength(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function* toAsyncIterable(items: WorkbenchRunnerYield[]): AsyncGenerator<WorkbenchRunnerYield> {
  for (const item of items) {
    yield item;
  }
}
