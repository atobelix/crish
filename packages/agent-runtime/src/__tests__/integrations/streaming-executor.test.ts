import { describe, expect, it, vi } from "vitest";
import {
  StreamingToolExecutor,
  type TrackedTool,
  type ToolResult,
} from "../../stream/streaming-tool-executor";

async function collect(iterable: AsyncIterable<ToolResult>): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for await (const r of iterable) results.push(r);
  return results;
}

describe("StreamingToolExecutor - large scale (50+ tools)", () => {
  it("executes 50 parallel tools concurrently", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);

    for (let i = 0; i < 50; i++) {
      executor.addTool(`t${i}`, `tool-${i}`, "parallel");
    }

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      return { toolCallId: tool.id, output: tool.name, isError: false };
    });

    const results = await collect(executor.execute(runner));
    expect(results).toHaveLength(50);
    expect(runner).toHaveBeenCalledTimes(50);
    expect(results[0]!.toolCallId).toBe("t0");
    expect(results[49]!.toolCallId).toBe("t49");
  });

  it("executes 50 serial tools sequentially", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);

    for (let i = 0; i < 50; i++) {
      executor.addTool(`s${i}`, `serial-${i}`, "serial");
    }

    const executionOrder: number[] = [];
    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      executionOrder.push(tool.index);
      return { toolCallId: tool.id, output: tool.name, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toHaveLength(50);
    expect(executionOrder).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(executionOrder[i]).toBe(i);
    }
  });

  it("executes 50 mixed tools (25 parallel + 25 serial)", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);

    for (let i = 0; i < 25; i++) {
      executor.addTool(`p${i}`, `parallel-${i}`, "parallel");
    }
    for (let i = 0; i < 25; i++) {
      executor.addTool(`s${i}`, `serial-${i}`, "serial");
    }

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      return { toolCallId: tool.id, output: tool.name, isError: false };
    });

    const results = await collect(executor.execute(runner));
    expect(results).toHaveLength(50);
    expect(runner).toHaveBeenCalledTimes(50);
  });

  it("handles partial failures among 50 parallel tools", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);

    for (let i = 0; i < 50; i++) {
      executor.addTool(`t${i}`, `tool-${i}`, "parallel");
    }

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.index % 2 === 0) throw new Error(`error-${tool.index}`);
      return { toolCallId: tool.id, output: tool.name, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toHaveLength(50);

    const failed = results.filter((r) => r.isError);
    const succeeded = results.filter((r) => !r.isError);
    expect(failed).toHaveLength(25);
    expect(succeeded).toHaveLength(25);

    expect(executor.failedCount).toBe(25);
    expect(executor.completedCount).toBe(25);
  });
});

describe("StreamingToolExecutor - nested results", () => {
  it("passes through structured data in output", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "read", "parallel");

    const runner = async (): Promise<ToolResult> => {
      return {
        toolCallId: "t1",
        output: JSON.stringify({ files: ["a.txt", "b.txt"], count: 2 }),
        isError: false,
      };
    };

    const results = await collect(executor.execute(runner));
    const parsed = JSON.parse(results[0]!.output);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.count).toBe(2);
  });

  it("nested results from serial tools are ordered correctly", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "step1", "serial");
    executor.addTool("t2", "step2", "serial");

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      return {
        toolCallId: tool.id,
        output: `result-${tool.index}-${tool.name}`,
        isError: false,
      };
    });

    const results = await collect(executor.execute(runner));
    expect(results[0]!.output).toBe("result-0-step1");
    expect(results[1]!.output).toBe("result-1-step2");
  });

  it("nested results preserve tool names across parallel and serial", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("p1", "search", "parallel");
    executor.addTool("s1", "bash", "serial");
    executor.addTool("s2", "edit", "serial");

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      return { toolCallId: tool.id, output: `${tool.name}-done`, isError: false };
    });

    const results = await collect(executor.execute(runner));
    expect(results[0]!.output).toBe("search-done");
    expect(results[1]!.output).toBe("bash-done");
    expect(results[2]!.output).toBe("edit-done");
  });
});

describe("StreamingToolExecutor - timeout behavior", () => {
  it("continues with remaining tools after a single tool timeout", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("slow", "timeout-tool", "parallel");
    executor.addTool("fast", "quick-tool", "parallel");

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "timeout-tool") {
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT_EXCEEDED")), 10),
        );
      }
      return { toolCallId: tool.id, output: `${tool.name}`, isError: false };
    };

    const results = await collect(executor.execute(runner));
    const timedOut = results.find((r) => r.toolCallId === "slow");
    expect(timedOut!.isError).toBe(true);
    expect(timedOut!.output).toContain("TIMEOUT_EXCEEDED");

    const fastResult = results.find((r) => r.toolCallId === "fast");
    expect(fastResult!.isError).toBe(false);
  });

  it("serial tools respect overall abort signal", async () => {
    const controller = new AbortController();
    const executor = new StreamingToolExecutor(controller.signal);
    executor.addTool("s1", "first", "serial");
    executor.addTool("s2", "second", "serial");
    executor.addTool("s3", "third", "serial");

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.index === 1) controller.abort();
      return { toolCallId: tool.id, output: tool.name, isError: false };
    });

    await collect(executor.execute(runner));
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("tracks counts correctly after partial failures", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("ok1", "good", "parallel");
    executor.addTool("fail1", "bad", "parallel");
    executor.addTool("ok2", "good", "serial");

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "bad") throw new Error("FAILED");
      return { toolCallId: tool.id, output: "ok", isError: false };
    };

    await collect(executor.execute(runner));
    expect(executor.completedCount).toBe(2);
    expect(executor.failedCount).toBe(1);
    expect(executor.pendingCount).toBe(0);
  });
});

describe("StreamingToolExecutor - edge cases", () => {
  it("handles single tool execute", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("only", "solo", "serial");

    const runner = vi.fn(async (): Promise<ToolResult> => {
      return { toolCallId: "only", output: "done", isError: false };
    });

    const results = await collect(executor.execute(runner));
    expect(results).toHaveLength(1);
    expect(results[0]!.output).toBe("done");
  });

  it("maintains correct index ordering for parallel tools", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("a", "z-fast", "parallel");
    executor.addTool("b", "a-slow", "parallel");

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "a-slow") await new Promise((r) => setTimeout(r, 20));
      return { toolCallId: tool.id, output: tool.name, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results[0]!.toolCallId).toBe("a");
    expect(results[1]!.toolCallId).toBe("b");
  });

  it("yields results lazily (serial tools yield one by one)", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("s1", "first", "serial");
    executor.addTool("s2", "second", "serial");

    const yielded: string[] = [];
    for await (const r of executor.execute(
      async (tool) => {
        return { toolCallId: tool.id, output: tool.name, isError: false };
      },
    )) {
      yielded.push(r.output);
    }

    expect(yielded).toEqual(["first", "second"]);
  });
});
