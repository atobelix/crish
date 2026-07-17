import { describe, expect, it } from "vitest";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "../types";
import {
  ConnectionManager,
  StreamInterruptedError,
  type ProviderTransport,
} from "./connection-manager";
import {
  StreamRecovery,
  StreamRecoveryError,
  synthesizeOrphanedToolResults,
  synthesizeOrphansFromPending,
} from "./stream-recovery";

function transport(id: string, events: ProviderStreamEvent[]): ProviderTransport {
  const provider: AgentProvider = {
    id,
    async *stream(_request: AgentProviderRequest) {
      for (const event of events) yield event;
    },
  };
  return {
    id,
    kind: "https",
    provider,
    avgLatency: 10,
    successRate: 1,
    lastUsed: 0,
  };
}

describe("StreamRecovery", () => {
  it("surfaces StreamRecoveryError with orphans when tool-call stream is interrupted", async () => {
    const manager = new ConnectionManager();
    const broken: AgentProvider = {
      id: "broken",
      async *stream() {
        yield { type: "tool-call", id: "call_1", toolName: "shell", input: { command: "echo hi" } };
        throw new Error("socket reset");
      },
    };
    manager.addTransport({
      id: "primary",
      kind: "https",
      provider: broken,
      avgLatency: 10,
      successRate: 1,
      lastUsed: 0,
    });
    manager.addTransport(
      transport("backup", [
        { type: "text-delta", text: "should not run" },
        { type: "stop", reason: "stop" },
      ])
    );

    const recovery = new StreamRecovery();
    const request: AgentProviderRequest = {
      sessionId: "s",
      cwd: "/",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    };

    const yielded: ProviderStreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of recovery.streamWithRecovery(manager, request)) {
        yielded.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(yielded).toEqual([
      { type: "tool-call", id: "call_1", toolName: "shell", input: { command: "echo hi" } },
    ]);
    expect(caught).toBeInstanceOf(StreamRecoveryError);
    const recoveryError = caught as StreamRecoveryError;
    expect(recoveryError.orphans).toHaveLength(1);
    expect(recoveryError.orphans[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "shell",
      isError: true,
    });
    expect(recoveryError.accumulator.pendingToolCalls).toHaveLength(1);
  });

  it("does not retry after partial text was already streamed", async () => {
    const manager = new ConnectionManager();
    const broken: AgentProvider = {
      id: "broken",
      async *stream() {
        yield { type: "text-delta", text: "hello" };
        throw new StreamInterruptedError("primary", "mid-stream", true);
      },
    };
    manager.addTransport({
      id: "primary",
      kind: "https",
      provider: broken,
      avgLatency: 10,
      successRate: 1,
      lastUsed: 0,
    });
    manager.addTransport(
      transport("backup", [
        { type: "text-delta", text: "retry-text" },
        { type: "stop", reason: "stop" },
      ])
    );

    const recovery = new StreamRecovery();
    await expect(async () => {
      for await (const _ of recovery.streamWithRecovery(manager, {
        sessionId: "s",
        cwd: "/",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(StreamRecoveryError);
  });

  it("synthesizeOrphanedToolResults pairs missing tool results", () => {
    const orphans = synthesizeOrphanedToolResults(
      {
        id: "a1",
        role: "assistant",
        createdAt: new Date().toISOString(),
        blocks: [
          { type: "tool-call", id: "c1", toolName: "read_file", input: { path: "a.ts" } },
          { type: "tool-call", id: "c2", toolName: "shell", input: { command: "ls" } },
        ],
      },
      [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: { text: "ok" },
          isError: false,
        },
      ]
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.toolCallId).toBe("c2");
    expect(orphans[0]?.isError).toBe(true);
  });

  it("synthesizeOrphansFromPending skips already resolved ids", () => {
    const orphans = synthesizeOrphansFromPending(
      [
        { id: "c1", toolName: "a", input: {}, resolved: false },
        { id: "c2", toolName: "b", input: {}, resolved: false },
      ],
      [{ type: "tool-result", toolCallId: "c1", toolName: "a", output: { text: "x" }, isError: false }]
    );
    expect(orphans.map((o) => o.toolCallId)).toEqual(["c2"]);
  });

  it("dedupes duplicate pending tool-call ids and skips resolved flag", () => {
    const orphans = synthesizeOrphansFromPending(
      [
        { id: "dup", toolName: "a", input: {}, resolved: false },
        { id: "dup", toolName: "a", input: {}, resolved: false },
        { id: "done", toolName: "b", input: {}, resolved: true },
        { id: "", toolName: "c", input: {}, resolved: false },
      ],
      []
    );
    expect(orphans.map((o) => o.toolCallId)).toEqual(["dup"]);
  });

  it("assigns stable missing ids for tool-calls without id", async () => {
    const manager = new ConnectionManager();
    const broken: AgentProvider = {
      id: "broken",
      async *stream() {
        yield { type: "tool-call", toolName: "read", input: { path: "a" } } as ProviderStreamEvent;
        yield { type: "tool-call", toolName: "  ", input: null as unknown as Record<string, never> } as ProviderStreamEvent;
        throw new Error("cut");
      },
    };
    manager.addTransport({
      id: "primary",
      kind: "https",
      provider: broken,
      avgLatency: 10,
      successRate: 1,
      lastUsed: 0,
    });

    const recovery = new StreamRecovery();
    let caught: unknown;
    try {
      for await (const _ of recovery.streamWithRecovery(manager, {
        sessionId: "s",
        cwd: "/",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        /* drain */
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StreamRecoveryError);
    const recoveryError = caught as StreamRecoveryError;
    expect(recoveryError.orphans).toHaveLength(2);
    expect(recoveryError.orphans[0]?.toolCallId).toBe("call-missing-1");
    expect(recoveryError.orphans[1]?.toolCallId).toBe("call-missing-2");
    expect(recoveryError.orphans[1]?.toolName).toBe("unknown-tool");
  });

  it("retries empty failure on backup transport when primary dies before content", async () => {
    const manager = new ConnectionManager();
    manager.addTransport({
      id: "primary",
      kind: "https",
      provider: {
        id: "primary",
        async *stream() {
          throw new Error("connect reset");
        },
      },
      avgLatency: 5,
      successRate: 1,
      lastUsed: 0,
    });
    manager.addTransport(
      transport("backup", [
        { type: "text-delta", text: "ok-from-backup" },
        { type: "stop", reason: "stop" },
      ])
    );

    const recovery = new StreamRecovery();
    const yielded: ProviderStreamEvent[] = [];
    for await (const event of recovery.streamWithRecovery(manager, {
      sessionId: "s",
      cwd: "/",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      yielded.push(event);
    }
    expect(yielded.some((e) => e.type === "text-delta" && e.text === "ok-from-backup")).toBe(true);
  });

  it("surfaces orphans when abort arrives after a tool-call", async () => {
    const controller = new AbortController();
    const manager = new ConnectionManager();
    manager.addTransport({
      id: "primary",
      kind: "https",
      provider: {
        id: "primary",
        async *stream() {
          yield { type: "tool-call", id: "c-abort", toolName: "shell", input: { command: "echo" } };
          controller.abort();
          yield { type: "text-delta", text: "after" };
        },
      },
      avgLatency: 10,
      successRate: 1,
      lastUsed: 0,
    });

    const recovery = new StreamRecovery();
    let caught: unknown;
    try {
      for await (const _ of recovery.streamWithRecovery(manager, {
        sessionId: "s",
        cwd: "/",
        messages: [],
        tools: [],
        signal: controller.signal,
      })) {
        /* drain */
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StreamRecoveryError);
    expect((caught as StreamRecoveryError).orphans.map((o) => o.toolCallId)).toEqual(["c-abort"]);
  });
});
