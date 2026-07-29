import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, JsonObject, ToolCallBlock } from "@crish/shared-types";
import type { AgentTool } from "../types";
import { LifecycleHookRegistry } from "../hooks";
import { ToolExecutor, ProgressEventQueue, type ToolExecuteHook } from "./tool-executor";
import { ExecutionStrategy } from "./execution-strategy";

function shellTool(name = "shell"): AgentTool {
  return {
    name,
    label: name,
    description: `Run ${name}`,
    category: "terminal",
    concurrency: "parallel",
    isReadOnly: () => true,
    summarize(input: JsonObject) {
      return String(input.command ?? name);
    },
    async execute(input) {
      return { text: `ok:${input.command}` };
    },
  };
}

function exclusiveTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    category: "filesystem",
    concurrency: "exclusive",
    allowParallel: false,
    isReadOnly: () => false,
    summarize: () => name,
    async execute() {
      return { text: `${name} done` };
    },
  };
}

function toolCall(id: string, toolName: string, input: JsonObject = {}): ToolCallBlock {
  return { type: "tool-call", id, toolName, input };
}

async function collectBatch(
  executor: ToolExecutor,
  calls: ToolCallBlock[],
  tools: AgentTool[],
  signal: AbortSignal = new AbortController().signal,
  onToolExecute?: ToolExecuteHook,
): Promise<{ events: AgentEvent[]; results: import("@crish/shared-types").ToolBatchResult[] }> {
  const events: AgentEvent[] = [];
  const iterator = executor.executeBatchWithEvents(calls, tools, "session", "C:/workspace", signal, onToolExecute);
  let results: import("@crish/shared-types").ToolBatchResult[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      results = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, results };
}

describe("ToolExecutor", () => {
  it("executes a single tool call successfully", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { events, results } = await collectBatch(executor, [toolCall("c1", "shell", { command: "pwd" })], [shellTool()]);

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.output.text).toBe("ok:pwd");
    expect(events.some((e) => e.type === "tool-start")).toBe(true);
    expect(events.some((e) => e.type === "tool-end")).toBe(true);
  });

  it("emits tool-batch-start and tool-batch-end events", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { events } = await collectBatch(executor, [toolCall("c1", "shell", { command: "ls" })], [shellTool()]);

    expect(events.some((e) => e.type === "tool-batch-start")).toBe(true);
    expect(events.some((e) => e.type === "tool-batch-end")).toBe(true);
    const batchStart = events.find((e) => e.type === "tool-batch-start") as Extract<AgentEvent, { type: "tool-batch-start" }>;
    expect(batchStart.sessionId).toBe("session");
  });

  it("executes parallel tools concurrently", async () => {
    const order: string[] = [];
    const slow: AgentTool = {
      name: "slow",
      label: "slow",
      description: "slow",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "slow",
      async execute() {
        order.push("slow-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("slow-end");
        return { text: "slow" };
      },
    };
    const fast: AgentTool = {
      ...slow,
      name: "fast",
      summarize: () => "fast",
      async execute() {
        order.push("fast-start");
        order.push("fast-end");
        return { text: "fast" };
      },
    };

    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    await collectBatch(executor, [toolCall("c1", "slow"), toolCall("c2", "fast")], [slow, fast]);

    expect(order.filter((s) => s === "fast-start")).toHaveLength(1);
  });

  it("returns error for unknown tool", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "nonexistent")], []);

    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.output.text).toContain("not found");
  });

  it("returns error for invalid tool input", async () => {
    const tool: AgentTool = {
      name: "write",
      label: "write",
      description: "write",
      category: "filesystem",
      concurrency: "exclusive",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      isReadOnly: () => false,
      summarize: () => "write",
      async execute() {
        return { text: "written" };
      },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "write", {})], [tool]);

    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.output.text).toContain("validation failed");
  });

  it("partitions parallel and exclusive tools correctly", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const groups = executor.partitionBatch(
      [toolCall("c1", "shell"), toolCall("c2", "writer"), toolCall("c3", "shell")],
      [shellTool(), exclusiveTool("writer")],
    );

    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(1);
    expect(groups[0]![0]!.toolName).toBe("shell");
    expect(groups[1]).toHaveLength(1);
    expect(groups[1]![0]!.toolName).toBe("writer");
    expect(groups[2]).toHaveLength(1);
    expect(groups[2]![0]!.toolName).toBe("shell");
  });

  it("groups parallel tools into a single batch", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const groups = executor.partitionBatch(
      [toolCall("c1", "shell"), toolCall("c2", "shell")],
      [shellTool()],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("detects fully parallel groups", async () => {
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    expect(executor.isFullyParallel([toolCall("c1", "shell")], [shellTool()])).toBe(true);
    expect(executor.isFullyParallel([toolCall("c1", "excl")], [exclusiveTool("excl")])).toBe(false);
  });

  it("handles tool execution error gracefully", async () => {
    const failing: AgentTool = {
      name: "fail",
      label: "fail",
      description: "fail",
      category: "internal",
      concurrency: "exclusive",
      isReadOnly: () => true,
      summarize: () => "fail",
      async execute() {
        throw new Error("boom");
      },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "fail")], [failing]);

    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.output.text).toContain("boom");
  });

  it("cancels sibling tools on failure when policy is cancel-siblings", async () => {
    let siblingAborted = false;
    const fail: AgentTool = {
      name: "fail",
      label: "fail",
      description: "fail",
      category: "internal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "fail",
      async execute() {
        throw new Error("boom");
      },
    };
    const slow: AgentTool = {
      name: "slow",
      label: "slow",
      description: "slow",
      category: "internal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "slow",
      async execute(_input, context) {
        context.signal.addEventListener("abort", () => { siblingAborted = true; });
        return new Promise(() => {});
      },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "cancel-siblings" });
    const { results } = await collectBatch(executor, [toolCall("c1", "fail"), toolCall("c2", "slow")], [fail, slow]);

    expect(siblingAborted).toBe(true);
    expect(results.find((r) => r.id === "c1")?.isError).toBe(true);
  });

  it("lifecycle tool.pre block prevents executeFn", async () => {
    const executeFn = vi.fn(async () => ({ text: "should-not-run" }));
    const tool: AgentTool = {
      name: "shell",
      label: "shell",
      description: "shell",
      category: "terminal",
      concurrency: "exclusive",
      isReadOnly: () => true,
      summarize: () => "shell",
      execute: executeFn,
    };
    const lifecycleHooks = new LifecycleHookRegistry();
    lifecycleHooks.on("tool.pre", () => ({ block: true, reason: "policy-deny" }));
    const executor = new ToolExecutor({
      timeoutMs: 5000,
      parallelFailurePolicy: "continue-drain",
      lifecycleHooks,
    });
    const { results } = await collectBatch(executor, [toolCall("c1", "shell", { command: "x" })], [tool]);

    expect(executeFn).not.toHaveBeenCalled();
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.output.text).toMatch(/policy-deny|Blocked by lifecycle/i);
  });

  it("lifecycle tool.post receives output", async () => {
    const lifecycleHooks = new LifecycleHookRegistry();
    const posts: Array<{ toolName: string; text?: string }> = [];
    lifecycleHooks.on("tool.post", (p) => {
      const text = p.output?.text;
      posts.push(
        text !== undefined ? { toolName: p.toolName, text } : { toolName: p.toolName },
      );
      return { modifiedOutput: { text: `post:${p.output?.text}` } };
    });
    const executor = new ToolExecutor({
      timeoutMs: 5000,
      parallelFailurePolicy: "continue-drain",
      lifecycleHooks,
    });
    const { results } = await collectBatch(
      executor,
      [toolCall("c1", "shell", { command: "pwd" })],
      [shellTool()],
    );

    expect(posts).toEqual([{ toolName: "shell", text: "ok:pwd" }]);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.output.text).toBe("post:ok:pwd");
  });
});

describe("ToolExecutor — Options pattern and strategies", () => {
  it("continues draining on failure when policy is continue-drain", async () => {
    const fail: AgentTool = {
      name: "fail", label: "fail", description: "fail", category: "internal",
      concurrency: "parallel", isReadOnly: () => true, summarize: () => "fail",
      async execute() { throw new Error("fail"); },
    };
    const ok: AgentTool = {
      name: "ok", label: "ok", description: "ok", category: "internal",
      concurrency: "parallel", isReadOnly: () => true, summarize: () => "ok",
      async execute() { return { text: "ok" }; },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "fail"), toolCall("c2", "ok")], [fail, ok]);

    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(true);
    expect(results[1]!.isError).toBe(false);
  });

  it("executes sequential tools (allowParallel=false) in order", async () => {
    const order: number[] = [];
    const seq: AgentTool = {
      name: "seq", label: "seq", description: "seq", category: "filesystem",
      concurrency: "exclusive", allowParallel: false, isReadOnly: () => false,
      summarize: () => "seq",
      async execute() {
        order.push(1);
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
        return { text: "seq done" };
      },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "seq"), toolCall("c2", "seq")], [seq]);

    expect(results).toHaveLength(2);
    expect(results[0]!.isError).toBe(false);
    expect(results[1]!.isError).toBe(false);
  });

  it("executes batch sequentially when shouldExecuteSequential triggers", async () => {
    const order: string[] = [];
    const parTool: AgentTool = {
      name: "parallel", label: "parallel", description: "p", category: "terminal",
      concurrency: "parallel", isReadOnly: () => true, summarize: () => "p",
      async execute() { order.push("par"); return { text: "par" }; },
    };
    const seqTool: AgentTool = {
      name: "sequential", label: "sequential", description: "s", category: "filesystem",
      concurrency: "exclusive", allowParallel: false, isReadOnly: () => false,
      summarize: () => "s",
      async execute() { order.push("seq"); return { text: "seq" }; },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    await collectBatch(executor, [toolCall("c1", "parallel"), toolCall("c2", "sequential")], [parTool, seqTool]);

    expect(order).toEqual(["par", "seq"]);
  });

  it("injects a custom ToolExecuteHook and emits its events", async () => {
    const hookEvents: string[] = [];
    const customHook: ToolExecuteHook = async function* (toolCall, _tools, _sessionId, _cwd, _signal, _batchId) {
      hookEvents.push("hook-start");
      yield { type: "tool-start", sessionId: _sessionId, batchId: _batchId, call: { id: toolCall.id, toolName: toolCall.toolName, input: toolCall.input, summary: "", category: "internal", concurrency: "exclusive" }, timestamp: new Date().toISOString() };
      hookEvents.push("hook-end");
      yield { type: "tool-end", sessionId: _sessionId, batchId: _batchId, result: { id: toolCall.id, toolName: toolCall.toolName, output: { text: "hooked" }, isError: false, durationMs: 1 }, timestamp: new Date().toISOString() };
      return { id: toolCall.id, toolName: toolCall.toolName, output: { text: "hooked" }, isError: false, durationMs: 1 };
    };

    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results, events } = await collectBatch(executor, [toolCall("c1", "shell", { command: "test" })], [shellTool()], new AbortController().signal, customHook);

    expect(results[0]!.output.text).toBe("hooked");
    expect(hookEvents).toContain("hook-start");
    expect(hookEvents).toContain("hook-end");
    expect(events.some((e) => e.type === "tool-start")).toBe(true);
  });

  it("cancels sequential execution when abort signal is already aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const seqTool: AgentTool = {
      name: "seq", label: "seq", description: "seq", category: "filesystem",
      concurrency: "exclusive", allowParallel: false, isReadOnly: () => false,
      summarize: () => "seq",
      async execute() { return { text: "seq" }; },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "seq")], [seqTool], aborted.signal);

    expect(results).toHaveLength(0);
  });

  it("handles batch with mixed parallel-then-sequential groups", async () => {
    const execOrder: string[] = [];
    const par: AgentTool = {
      name: "par", label: "par", description: "par", category: "terminal",
      concurrency: "parallel", isReadOnly: () => true, summarize: () => "par",
      async execute() { execOrder.push("par"); return { text: "par" }; },
    };
    const excl: AgentTool = {
      name: "excl", label: "excl", description: "excl", category: "filesystem",
      concurrency: "exclusive", allowParallel: false, isReadOnly: () => false,
      summarize: () => "excl",
      async execute() { execOrder.push("excl"); return { text: "excl" }; },
    };
    const executor = new ToolExecutor({ timeoutMs: 5000, parallelFailurePolicy: "continue-drain" });
    const { results } = await collectBatch(executor, [toolCall("c1", "par"), toolCall("c2", "excl"), toolCall("c3", "par")], [par, excl]);

    expect(results).toHaveLength(3);
    expect(results[0]!.isError).toBe(false);
    expect(results[1]!.isError).toBe(false);
    expect(results[2]!.isError).toBe(false);
  });
});

describe("ExecutionStrategy", () => {
  it("sets and gets timeout", () => {
    const s = new ExecutionStrategy().timeout(5000);
    expect(s.getTimeoutMs()).toBe(5000);
  });

  it("sets and gets retry count", () => {
    const s = new ExecutionStrategy().retry(3);
    expect(s.getRetryCount()).toBe(3);
  });

  it("sets and gets concurrent mode", () => {
    const s = new ExecutionStrategy().concurrent("parallel");
    expect(s.getConcurrentMode()).toBe("parallel");
  });

  it("compose merges with left priority", () => {
    const a = new ExecutionStrategy().timeout(1000).retry(3).concurrent("sequential");
    const b = new ExecutionStrategy().timeout(5000).retry(1).concurrent("parallel");
    const composed = a.compose(b);
    expect(composed.getTimeoutMs()).toBe(1000);
    expect(composed.getRetryCount()).toBe(3);
    expect(composed.getConcurrentMode()).toBe("parallel");
  });

  it("compose falls back to right when left is not set", () => {
    const a = new ExecutionStrategy();
    const b = new ExecutionStrategy().retry(2);
    const composed = a.compose(b);
    expect(composed.getTimeoutMs()).toBeUndefined();
    expect(composed.getRetryCount()).toBe(2);
  });

  it("compose preserves left concurrent mode when right is sequential", () => {
    const a = new ExecutionStrategy().concurrent("parallel");
    const b = new ExecutionStrategy();
    const composed = a.compose(b);
    expect(composed.getConcurrentMode()).toBe("parallel");
  });
});

describe("ProgressEventQueue", () => {
  it("queues and retrieves items in FIFO order", async () => {
    const queue = new ProgressEventQueue<number>();
    queue.push(1);
    queue.push(2);
    expect((await queue.next()).value).toBe(1);
    expect((await queue.next()).value).toBe(2);
  });

  it("resolves pending waiters when items are pushed", async () => {
    const queue = new ProgressEventQueue<number>();
    const promise = queue.next();
    queue.push(42);
    const result = await promise;
    expect(result.value).toBe(42);
  });

  it("closes and wakes all waiters", async () => {
    const queue = new ProgressEventQueue<number>();
    const promise = queue.next();
    queue.close();
    const result = await promise;
    expect(result.done).toBe(true);
  });

  it("ignores push after close", async () => {
    const queue = new ProgressEventQueue<number>();
    queue.close();
    queue.push(1);
    const result = await queue.next();
    expect(result.done).toBe(true);
  });

  it("expands buffer when capacity is exceeded", async () => {
    const bufferSize = 256;
    const queue = new ProgressEventQueue<number>();
    for (let i = 0; i < bufferSize + 10; i++) {
      queue.push(i);
    }
    for (let i = 0; i < bufferSize + 10; i++) {
      const result = await queue.next();
      expect(result.value).toBe(i);
    }
  });
});
