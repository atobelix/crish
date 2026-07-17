import { describe, expect, it } from "vitest";
import type { AgentEvent, ToolCallBlock } from "@crish/shared-types";
import type { AgentTool } from "../types";
import { ToolExecutor } from "./tool-executor";

describe("ToolExecutor timeout", () => {
  it("honors timeoutMs on the default executeSingleWithEvents path", async () => {
    let signalAborted = false;
    const hung: AgentTool = {
      name: "hung",
      label: "hung",
      description: "never resolves",
      category: "internal",
      concurrency: "exclusive",
      isReadOnly: () => true,
      summarize: () => "hung",
      async execute(_input, context) {
        context.signal.addEventListener("abort", () => {
          signalAborted = true;
        });
        return new Promise(() => {
          /* hang until timeout aborts */
        });
      },
    };

    const executor = new ToolExecutor({
      timeoutMs: 30,
      parallelFailurePolicy: "continue-drain",
    });

    const call: ToolCallBlock = {
      type: "tool-call",
      id: "call_timeout",
      toolName: "hung",
      input: {},
    };

    const events: AgentEvent[] = [];
    const iterator = executor.executeBatchWithEvents(
      [call],
      [hung],
      "session",
      "C:/repo",
      new AbortController().signal
    );

    let results;
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        results = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(signalAborted).toBe(true);
    expect(results).toHaveLength(1);
    expect(results![0]!.isError).toBe(true);
    expect(results![0]!.output.text).toMatch(/timed out/i);
    expect(results![0]!.output.json).toMatchObject({
      timedOut: true,
      runtimeToolExecution: {
        status: "timeout",
        timedOut: true,
        timeoutMs: 30,
      },
    });
    expect(events.some((e) => e.type === "tool-end")).toBe(true);
  });
});
