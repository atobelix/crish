import { describe, expect, it, vi } from "vitest";
import { StreamingToolExecutor, type TrackedTool, type ToolResult } from "./streaming-tool-executor";

async function collect(iterable: AsyncIterable<ToolResult>): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for await (const r of iterable) results.push(r);
  return results;
}

describe("StreamingToolExecutor", () => {
  it("executes parallel tools concurrently", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "read", "parallel");
    executor.addTool("t2", "search", "parallel");

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      return { toolCallId: tool.id, output: `${tool.name}:done`, isError: false };
    });

    const results = await collect(executor.execute(runner));
    expect(results).toEqual([
      { toolCallId: "t1", output: "read:done", isError: false },
      { toolCallId: "t2", output: "search:done", isError: false },
    ]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("executes serial tools sequentially", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "bash", "serial");
    executor.addTool("t2", "edit", "serial");

    const order: number[] = [];
    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      order.push(tool.index);
      return { toolCallId: tool.id, output: `${tool.name}:done`, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toEqual([
      { toolCallId: "t1", output: "bash:done", isError: false },
      { toolCallId: "t2", output: "edit:done", isError: false },
    ]);
    expect(order).toEqual([0, 1]);
  });

  it("executes mixed tools with correct ordering (parallel first, then serial)", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "read", "parallel");
    executor.addTool("t2", "search", "parallel");
    executor.addTool("t3", "bash", "serial");

    const serialStart: number[] = [];
    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.concurrency === "serial") serialStart.push(tool.index);
      return { toolCallId: tool.id, output: `${tool.name}:done`, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toEqual([
      { toolCallId: "t1", output: "read:done", isError: false },
      { toolCallId: "t2", output: "search:done", isError: false },
      { toolCallId: "t3", output: "bash:done", isError: false },
    ]);
    expect(serialStart).toEqual([2]);
  });

  it("results ordered by index even when parallel tools finish out of order", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "slow", "parallel");
    executor.addTool("t2", "fast", "parallel");

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "slow") await new Promise(r => setTimeout(r, 50));
      return { toolCallId: tool.id, output: tool.name, isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toEqual([
      { toolCallId: "t1", output: "slow", isError: false },
      { toolCallId: "t2", output: "fast", isError: false },
    ]);
  });

  it("propagates errors as isError results", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "read", "parallel");
    executor.addTool("t2", "bash", "serial");

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "read") throw new Error("permission denied");
      if (tool.name === "bash") throw new Error("command not found");
      return { toolCallId: tool.id, output: "ok", isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(results).toEqual([
      { toolCallId: "t1", output: "Error: permission denied", isError: true },
      { toolCallId: "t2", output: "Error: command not found", isError: true },
    ]);
  });

  it("stops serial execution on abort", async () => {
    const controller = new AbortController();
    const executor = new StreamingToolExecutor(controller.signal);
    executor.addTool("t1", "parallel1", "parallel");
    executor.addTool("t2", "serial1", "serial");
    executor.addTool("t3", "serial2", "serial");

    const runner = vi.fn(async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "serial1") controller.abort();
      return { toolCallId: tool.id, output: tool.name, isError: false };
    });

    await collect(executor.execute(runner));
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ name: "parallel1" }));
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ name: "serial1" }));
  });

  it("handles empty tool list", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    const runner = vi.fn();
    const results = await collect(executor.execute(runner));
    expect(results).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("tracks pending, completed, and failed counts", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    expect(executor.pendingCount).toBe(0);
    expect(executor.completedCount).toBe(0);
    expect(executor.failedCount).toBe(0);

    executor.addTool("t1", "read", "parallel");
    executor.addTool("t2", "bash", "serial");
    expect(executor.pendingCount).toBe(2);

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "bash") throw new Error("fail");
      return { toolCallId: tool.id, output: "ok", isError: false };
    };

    await collect(executor.execute(runner));
    expect(executor.pendingCount).toBe(0);
    expect(executor.completedCount).toBe(1);
    expect(executor.failedCount).toBe(1);
  });

  it("serial tools wait for all parallel tools to finish", async () => {
    const signal = new AbortController().signal;
    const executor = new StreamingToolExecutor(signal);
    executor.addTool("t1", "slow-parallel", "parallel");
    executor.addTool("t2", "fast-parallel", "parallel");
    executor.addTool("t3", "serial", "serial");

    let serialStarted = false;
    let parallelFinished = false;

    const runner = async (tool: TrackedTool): Promise<ToolResult> => {
      if (tool.name === "slow-parallel") {
        await new Promise(r => setTimeout(r, 30));
        parallelFinished = true;
        return { toolCallId: tool.id, output: "slow", isError: false };
      }
      if (tool.name === "fast-parallel") {
        return { toolCallId: tool.id, output: "fast", isError: false };
      }
      if (tool.name === "serial") {
        serialStarted = true;
        return { toolCallId: tool.id, output: "serial", isError: false };
      }
      return { toolCallId: tool.id, output: "unknown", isError: false };
    };

    const results = await collect(executor.execute(runner));
    expect(serialStarted).toBe(true);
    expect(parallelFinished).toBe(true);
    expect(results).toEqual([
      { toolCallId: "t1", output: "slow", isError: false },
      { toolCallId: "t2", output: "fast", isError: false },
      { toolCallId: "t3", output: "serial", isError: false },
    ]);
  });
});
