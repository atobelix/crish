import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  allowAllPermissionPolicy,
  createTextMessage,
  InMemorySessionStore,
  nowIso,
  SessionRecorder,
} from ".";
import type { AgentEvent, ContextCompressionRecord, JsonObject } from "@crish/shared-types";
import type { AgentProvider, AgentProviderRequest, AgentTool } from "./types";

function terminalTool(name: string): AgentTool {
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
    async execute(input, context) {
      context.emit({ text: `running ${input.command}` });
      return { text: `ok:${input.command}` };
    }
  };
}

describe("AgentRuntime", () => {
  it("nudges a text synthesis turn when the model only runs tools and never writes prose", async () => {
    let requestCount = 0;
    const provider: AgentProvider = {
      id: "scripted-tools-only",
      async *stream() {
        requestCount += 1;
        if (requestCount === 1) {
          yield { type: "tool-call", id: "call_only", toolName: "shell", input: { command: "pwd" } };
          yield { type: "stop", reason: "tool-call" };
          return;
        }
        if (requestCount === 2) {
          // 工具后只给极短废话（不足总结阈值），应触发收尾 nudge
          yield { type: "text-delta", text: "嗯" };
          yield { type: "stop", reason: "stop" };
          return;
        }
        // 第 3 次调用：收尾 nudge 后的总结
        yield { type: "text-delta", text: "综合结论：工具已检查完毕，仓库状态正常。" };
        yield { type: "stop", reason: "stop" };
      },
    };

    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_synthesis_nudge",
      cwd: "C:/repo",
      provider,
      tools: [terminalTool("shell")],
      sessionStore: store,
      maxTurns: 8,
    });

    const texts: string[] = [];
    const userTexts: string[] = [];
    for await (const event of runtime.run("check without prose")) {
      if (event.type === "message-end" && event.message.role === "assistant") {
        const t = event.message.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => (b as { text?: string }).text ?? "")
          .join("");
        if (t) texts.push(t);
      }
      if (event.type === "message-end" && (event.message.role === "user" || event.message.role === "system")) {
        const t = event.message.blocks
          ?.filter((b) => b.type === "text")
          .map((b) => (b as { text?: string }).text ?? "")
          .join("");
        if (t) userTexts.push(t);
      }
    }

    expect(requestCount).toBeGreaterThanOrEqual(2);
    expect(userTexts.some((t) => t.includes("不要再调用工具") || t.includes("分析结论") || t.includes("Runtime steering") || t.includes("Do not stop silently"))).toBe(true);
    expect(texts.some((t) => t.includes("综合结论"))).toBe(true);
  });

  it("keeps assistant text and tool calls in source order while batching parallel tools", async () => {
    let requestCount = 0;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        requestCount += 1;
        if (requestCount === 1) {
          yield { type: "text-delta", text: "I will inspect first.\n" };
          yield { type: "tool-call", id: "call_one", toolName: "shell", input: { command: "pwd" } };
          yield { type: "tool-call", id: "call_two", toolName: "shell", input: { command: "git status --short" } };
          yield { type: "stop", reason: "tool-call" };
          return;
        }
        yield { type: "text-delta", text: "Inspection complete." };
        yield { type: "stop", reason: "stop" };
      }
    };

    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_test",
      cwd: "C:/repo",
      provider,
      tools: [terminalTool("shell")],
      sessionStore: store
    });

    const events = [];
    for await (const event of runtime.run("check repo")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("tool-batch-start");
    const batch = events.find((event) => event.type === "tool-batch-start");
    expect(batch).toMatchObject({
      type: "tool-batch-start",
      summary: "2 terminal"
    });
    expect(store.entries.some((entry) => entry.type === "message" && entry.message.role === "tool")).toBe(true);
    expect(requestCount).toBe(2);
  });

  it("adds prompt assembly metadata to projected provider requests", async () => {
    let capturedRequest: AgentProviderRequest | undefined;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        capturedRequest = request;
        yield { type: "text-delta", text: "done" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_prompt_assembly",
      cwd: "C:/repo",
      systemPrompt: "You are concise.",
      provider,
      tools: [terminalTool("shell")],
      sessionStore: store,
      maxTurns: 1
    });

    for await (const _event of runtime.run("check repo")) {
      // drain
    }

    expect(capturedRequest?.systemPrompt).toBe("You are concise.");
    expect(capturedRequest?.messages.map((message) => message.role)).toEqual(["user"]);
    expect(capturedRequest?.tools.map((tool) => tool.name)).toEqual(["shell"]);
    expect(capturedRequest?.promptAssembly).toMatchObject({
      version: 1,
      layout: "stable-prefix-v1",
      providerFamily: "openai-compatible",
      modelFamily: "unknown",
      cacheStrategy: "conservative-stable-prefix",
      stablePrefixHash: expect.any(String),
      toolSchemaHash: expect.any(String),
      cacheKey: expect.any(String)
    });
    expect(capturedRequest?.promptAssembly?.cacheBlocks.map((block) => [block.kind, block.stability])).toEqual([
      ["system-prompt", "stable"],
      ["tool-schemas", "stable"],
      ["current-user-turn", "volatile"]
    ]);

    const assistantEntry = store.entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const assistantMetadata = assistantEntry?.type === "message" ? assistantEntry.message.metadata : undefined;
    expect(assistantMetadata?.promptAssembly).toMatchObject({
      stablePrefixHash: capturedRequest?.promptAssembly?.stablePrefixHash,
      toolSchemaHash: capturedRequest?.promptAssembly?.toolSchemaHash,
      cacheStrategy: "conservative-stable-prefix"
    });
  });

  it("passes native prompt context to the provider without storing injected context messages", async () => {
    let capturedRequest: AgentProviderRequest | undefined;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        capturedRequest = request;
        yield { type: "text-delta", text: "done" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_prompt_context",
      cwd: "C:/repo",
      systemPrompt: "Base product prompt.",
      promptContext: {
        stableContext: [
          {
            id: "scoped-context:rules",
            kind: "custom-stable",
            label: "Scoped Rules",
            content: { rules: [{ id: "single-track", text: "Use daemon as the product state source." }] }
          }
        ],
        volatileContext: [
          {
            id: "project-progress:recent-tasks",
            kind: "custom-volatile",
            content: { lines: ["Task[in_progress]: worker-a"] }
          }
        ],
        metadata: { stableContextHash: "stable_hash" }
      },
      provider,
      tools: [],
      sessionStore: store,
      maxTurns: 1
    });

    for await (const _event of runtime.run("check repo")) {
      // drain
    }

    expect(capturedRequest?.systemPrompt).toContain("Base product prompt.");
    expect(capturedRequest?.systemPrompt).toContain("<prompt_context stability=\"stable\"");
    expect(capturedRequest?.systemPrompt).toContain("Use daemon as the product state source.");
    expect(capturedRequest?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(capturedRequest?.messages[0]?.metadata).toMatchObject({ kind: "prompt-context", stability: "volatile" });
    expect(JSON.stringify(capturedRequest?.messages[0])).toContain("worker-a");
    expect(capturedRequest?.promptAssembly?.cacheBlocks.map((block) => [block.id, block.kind, block.stability])).toEqual([
      ["system-prompt", "system-prompt", "stable"],
      ["scoped-context:rules", "custom-stable", "stable"],
      ["project-progress:recent-tasks", "custom-volatile", "volatile"],
      [expect.stringMatching(/^message:/), "current-user-turn", "volatile"]
    ]);

    expect(store.entries.filter((entry) => entry.type === "message").map((entry) => (entry.type === "message" ? entry.message.role : ""))).toEqual([
      "user",
      "assistant"
    ]);
    const assistantEntry = store.entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const assistantMetadata = assistantEntry?.type === "message" ? assistantEntry.message.metadata : undefined;
    expect(assistantMetadata?.promptContext).toMatchObject({ stableContextHash: "stable_hash" });
  });

  it("turns ask decisions into approval requests before executing tools", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "danger", toolName: "write", input: { path: "a.txt" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "write",
      label: "write",
      description: "write file",
      category: "filesystem",
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: (input) => `write ${input.path}`,
      async execute() {
        return { text: "written" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_approval",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1,
      permissionPolicy: {
        decide: () => ({
          behavior: "ask",
          reason: "Write requires confirmation",
          metadata: { risk: "write", recommendSnapshot: true }
        })
      },
      approvalHandler: {
        requestApproval: async (request) => {
          expect(request.metadata).toMatchObject({
            risk: "write",
            reason: "Write requires confirmation",
            recommendSnapshot: true
          });
          return { behavior: "deny", reason: "not now" };
        }
      }
    });

    const events = [];
    for await (const event of runtime.run("write file")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("approval-requested");
    expect(events.map((event) => event.type)).toContain("approval-resolved");
    // 仅 strategy=ask 时广播 approval-requested，且 request 已带上 decision metadata
    const approvalEvent = events.find((event) => event.type === "approval-requested") as unknown as {
      request: { id: string; toolName: string; toolCallId?: string; metadata?: Record<string, unknown> };
    };
    expect(approvalEvent.request.id).toBeDefined();
    expect(approvalEvent.request.toolCallId).toBe(approvalEvent.request.id);
    expect(approvalEvent.request.toolName).toBe("write");
    expect(approvalEvent.request.metadata).toMatchObject({
      risk: "write",
      reason: "Write requires confirmation",
      recommendSnapshot: true,
    });
  });

  it("uses the smart project permission policy when no explicit policy is provided", async () => {
    let executed = false;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "hardline", toolName: "shell", input: { command: "shutdown /s" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "shell",
      label: "shell",
      description: "run shell",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: (input) => String(input.command),
      async execute() {
        executed = true;
        return { text: "should not execute" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_default_permission",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run dangerous command")) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.isError).toBe(true);
    // hardline block reasons may be localized
    expect(toolEnd?.result.output.text).toMatch(/T4|hardline|Hardline|Blocked|shutdown|denied/i);
  });

  it("returns a tool-result error instead of executing invalid tool input", async () => {
    let executed = false;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "bad_input", toolName: "write", input: { __parseError: "Unexpected token", mode: "bad" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "write",
      label: "write",
      description: "write file",
      category: "filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          mode: { type: "string", enum: ["create", "overwrite"] }
        },
        required: ["path"]
      },
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: () => "write file",
      async execute() {
        executed = true;
        return { text: "written" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_invalid_input",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("write file")) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.isError).toBe(true);
    expect(toolEnd?.result.output.text).toContain("Tool input validation failed");
    expect(toolEnd?.result.output.text).toContain("missing required field: path");
  });

  it("steers malformed long write_file arguments toward chunked edit calls", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield {
          type: "tool-call",
          id: "bad_write",
          toolName: "write_file",
          input: {
            __rawArguments: '{"path":"reports/evidence-ledger.json","content":"very long',
            __parseError: "Unterminated string in JSON at position 56"
          }
        };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "write_file",
      label: "write file",
      description: "write file",
      category: "filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: () => "write file",
      async execute() {
        return { text: "written" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_bad_write",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("write file")) {
      events.push(event);
    }

    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.output.text).toContain("do not retry write_file");
    expect(toolEnd?.result.output.text).toContain("edit");
    expect(toolEnd?.result.output.text).toContain("insert_tail");
    expect(toolEnd?.result.output.text).toContain("Raw argument preview");
  });

  it("steers malformed edit arguments toward numbered lines and snapshot tags", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield {
          type: "tool-call",
          id: "bad_edit",
          toolName: "edit",
          input: {
            __rawArguments: '{"path":"src/app.ts","edits":[{"op":"replace","content":"unterminated',
            __parseError: "Unterminated string in JSON at position 70"
          }
        };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "edit",
      label: "edit",
      description: "edit",
      category: "filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          snapshotTag: { type: "string" },
          edits: { type: "array" }
        },
        required: ["path"]
      },
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: () => "edit",
      async execute() {
        return { text: "edited" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_bad_edit",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("edit file")) {
      events.push(event);
    }

    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.output.text).toContain("numbered lines");
    expect(toolEnd?.result.output.text).toContain("snapshotTag");
    expect(toolEnd?.result.output.text).not.toContain("hash" + "line");
  });

  it("repairs provider tool-call inputs before validation and execution", async () => {
    let executedInput: JsonObject | undefined;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield {
          type: "tool-call",
          id: "write_aliases",
          toolName: "write",
          input: { file_path: "index.html", text: "<main>ok</main>" }
        };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "write",
      label: "write",
      description: "write file",
      category: "filesystem",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      inputAliases: {
        path: ["file_path"],
        content: ["text"]
      },
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: (input) => `write ${input.path}`,
      async execute(input) {
        executedInput = input;
        return { text: "written" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_repaired_input",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("write file")) {
      events.push(event);
    }

    expect(executedInput).toEqual({ path: "index.html", content: "<main>ok</main>" });
    expect(events.map((event) => event.type)).toContain("tool-input-repaired");
    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.isError).toBe(false);
  });

  it("does not let tool summary failures abort the turn before validation can report bad input", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "bad_read", toolName: "read_file", input: {} };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "read_file",
      label: "read file",
      description: "read file",
      category: "filesystem",
      concurrency: "parallel",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        },
        required: ["path"]
      },
      isReadOnly: () => true,
      summarize() {
        throw new Error("path must be a non-empty string");
      },
      async execute() {
        return { text: "should not execute" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_bad_summary",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("read file")) {
      events.push(event);
    }

    const startEvent = events.find((event) => event.type === "tool-batch-start" || event.type === "tool-start") as any;
    const summary = startEvent?.type === "tool-batch-start" ? startEvent.calls[0]?.summary : startEvent?.call?.summary;
    expect(summary).toContain("invalid input");
    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.isError).toBe(true);
    expect(toolEnd?.result.output.text).toContain("missing required field: path");
  });

  it("forwards provider diagnostics as runtime events without adding assistant blocks", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield {
          type: "provider-diagnostic",
          diagnostic: {
            phase: "request-start",
            providerId: "scripted",
            endpoint: "chat-completions"
          }
        };
        yield { type: "text-delta", text: "你好" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_diag",
      cwd: "C:/repo",
      provider,
      sessionStore: store
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("测试诊断")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("provider-diagnostic");
    const assistantEntry = store.entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
    expect(assistantEntry?.type === "message" ? assistantEntry.message.blocks : []).toEqual([{ type: "text", text: "你好" }]);
  });

  it("yields assistant deltas before the provider stream finishes", async () => {
    let resolveFirstGate: (() => void) | undefined;
    const firstGate = new Promise<void>((r) => { resolveFirstGate = r; });

    const provider: AgentProvider = {
      id: "slow-scripted",
      async *stream(request) {
        await firstGate;
        if (request.signal.aborted) return;
        yield { type: "text-delta", text: "first" };
        yield { type: "text-delta", text: "second" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_stream_live",
      cwd: "C:/repo",
      provider,
      permissionPolicy: allowAllPermissionPolicy,
    });
    const startedAt = Date.now();
    const iterator = runtime.run("stream");
    let firstDeltaMs = -1;

    // Unblock the stream gate on microtask queue
    queueMicrotask(() => resolveFirstGate?.());

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "message-delta" && next.value.block.type === "text") {
        firstDeltaMs = Date.now() - startedAt;
        runtime.abort("test complete");
        while (!(await iterator.next()).done) {}
        break;
      }
    }

    expect(firstDeltaMs).toBeGreaterThanOrEqual(0);
    expect(firstDeltaMs).toBeLessThan(1000);
  });

  it("yields tool progress before the tool completes", async () => {
    let resolveFirstGate: (() => void) | undefined;
    let resolveSecondGate: (() => void) | undefined;
    const firstGate = new Promise<void>((r) => { resolveFirstGate = r; });
    const secondGate = new Promise<void>((r) => { resolveSecondGate = r; });

    const provider: AgentProvider = {
      id: "tool-progress-scripted",
      async *stream() {
        yield { type: "tool-call", id: "call_slow", toolName: "slow_tool", input: { value: "x" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "slow_tool",
      label: "slow",
      description: "slow tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "slow tool",
      async execute(_input, context) {
        await firstGate;
        context.emit({ text: "halfway" });
        await secondGate;
        return { text: "done" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_tool_progress_live",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1
    });
    const startedAt = Date.now();
    const iterator = runtime.run("run slow tool");
    let updateMs = -1;
    let toolEndMs = -1;

    queueMicrotask(() => resolveFirstGate?.());

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "tool-update") {
        updateMs = Date.now() - startedAt;
        queueMicrotask(() => resolveSecondGate?.());
      }
      if (next.value.type === "tool-end") {
        toolEndMs = Date.now() - startedAt;
        break;
      }
    }

    expect(updateMs).toBeGreaterThanOrEqual(0);
    expect(updateMs).toBeLessThan(1000);
    expect(toolEndMs).toBeGreaterThanOrEqual(0);
  });

  it("times out a hung tool with a typed tool result", async () => {
    let signalAborted = false;
    let callCount = 0;
    const provider: AgentProvider = {
      id: "timeout-scripted",
      async *stream() {
        callCount++;
        if (callCount > 1) {
          yield { type: "text-delta", text: "Summary" };
          yield { type: "stop", reason: "stop" };
          return;
        }
        yield { type: "tool-call", id: "call_hung", toolName: "hung_tool", input: { value: "x" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "hung_tool",
      label: "hung",
      description: "hung tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "hung tool",
      async execute(_input, context) {
        return new Promise((_, reject) => {
          if (context.signal.aborted) {
            signalAborted = true;
            reject(new Error("aborted"));
            return;
          }
          context.signal.addEventListener("abort", () => {
            signalAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_tool_timeout",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1,
      toolExecution: {
        timeoutMs: 25
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run hung tool")) {
      events.push(event);
    }

    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(signalAborted).toBe(true);
    expect(toolEnd?.result.isError).toBe(true);
    expect(toolEnd?.result.output.text).toContain("timed out");
    expect(toolEnd?.result.output.json).toMatchObject({
      timedOut: true,
      runtimeToolExecution: {
        status: "timeout",
        timedOut: true,
        timeoutMs: 25
      }
    });
  });

  it("keeps draining sibling tools after a parallel tool failure by default", async () => {
    let resolveSlowGate: (() => void) | undefined;
    const slowGate = new Promise<void>((r) => { resolveSlowGate = r; });

    const provider: AgentProvider = {
      id: "parallel-continue-scripted",
      async *stream() {
        yield { type: "tool-call", id: "call_fail", toolName: "fail_tool", input: {} };
        yield { type: "tool-call", id: "call_slow", toolName: "slow_tool", input: {} };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    let slowSignalAborted = false;
    const failTool: AgentTool = {
      name: "fail_tool",
      label: "fail",
      description: "fail tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "fail",
      async execute() {
        throw new Error("boom");
      }
    };
    const slowTool: AgentTool = {
      name: "slow_tool",
      label: "slow",
      description: "slow tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "slow",
      async execute(_input, context) {
        context.signal.addEventListener("abort", () => {
          slowSignalAborted = true;
        });
        await slowGate;
        return { text: "slow done" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_parallel_continue",
      cwd: "C:/repo",
      provider,
      tools: [failTool, slowTool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1,
      toolExecution: {
        timeoutMs: 500
      }
    });

    const events: AgentEvent[] = [];
    queueMicrotask(() => resolveSlowGate?.());
    for await (const event of runtime.run("run tools")) {
      events.push(event);
    }

    const results = events
      .filter((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end")
      .map((event) => event.result);
    expect(slowSignalAborted).toBe(false);
    expect(results.find((result) => result.id === "call_fail")).toMatchObject({ isError: true });
    expect(results.find((result) => result.id === "call_slow")).toMatchObject({ isError: false, output: { text: "slow done" } });
  });

  it("can cancel sibling tools after a parallel tool failure", async () => {
    const provider: AgentProvider = {
      id: "parallel-cancel-scripted",
      async *stream() {
        yield { type: "tool-call", id: "call_fail", toolName: "fail_tool", input: {} };
        yield { type: "tool-call", id: "call_hung", toolName: "hung_tool", input: {} };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    let siblingSignalAborted = false;
    const failTool: AgentTool = {
      name: "fail_tool",
      label: "fail",
      description: "fail tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "fail",
      async execute() {
        throw new Error("boom");
      }
    };
    const hungTool: AgentTool = {
      name: "hung_tool",
      label: "hung",
      description: "hung tool",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "hung",
      async execute(_input, context) {
        context.signal.addEventListener("abort", () => {
          siblingSignalAborted = true;
        });
        return new Promise(() => {
          // The sibling cancellation signal must settle this runtime call.
        });
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_parallel_cancel",
      cwd: "C:/repo",
      provider,
      tools: [failTool, hungTool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1,
      toolExecution: {
        timeoutMs: 500,
        parallelFailurePolicy: "cancel-siblings"
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run tools")) {
      events.push(event);
    }

    const results = events
      .filter((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end")
      .map((event) => event.result);
    const cancelled = results.find((result) => result.id === "call_hung");
    expect(siblingSignalAborted).toBe(true);
    expect(results.find((result) => result.id === "call_fail")).toMatchObject({ isError: true });
    expect(cancelled?.isError).toBe(true);
    expect(cancelled?.output.json).toMatchObject({
      cancelled: true,
      runtimeToolExecution: {
        status: "cancelled",
        cancelled: true
      }
    });
  });

  it("resumes model context from session entries without duplicating old transcript entries", async () => {
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    await store.open({
      type: "session",
      id: "s_resume",
      cwd: "C:/repo",
      createdAt: nowIso(),
      version: 1
    });
    const oldUser = createTextMessage("user", "旧问题");
    const oldAssistant = createTextMessage("assistant", "旧回答");
    const keptUser = createTextMessage("user", "压缩前保留的问题");
    await recorder.recordMessage(oldUser);
    await recorder.recordMessage(oldAssistant);
    await recorder.recordMessage(keptUser);
    const record: ContextCompressionRecord = {
      id: "compact_resume",
      trigger: "auto",
      summary: "旧问题已经处理，继续当前任务。",
      firstKeptMessageId: keptUser.id,
      compressedMessageIds: [oldUser.id, oldAssistant.id],
      keptMessageIds: [keptUser.id],
      tokensBefore: 200,
      tokensAfter: 40,
      createdAt: nowIso()
    };
    await recorder.recordCompaction(record);

    let providerMessages: Array<{ role: string; text: string }> = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        providerMessages = request.messages.map((message) => ({
          role: message.role,
          text: message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
        }));
        yield { type: "text-delta", text: "已恢复" };
        yield { type: "stop", reason: "stop" };
      }
    };

    const entriesBefore = store.entries.length;
    const runtime = new AgentRuntime({
      sessionId: "s_resume",
      cwd: "C:/repo",
      provider,
      sessionStore: store,
      resumeSession: true
    });

    for await (const _event of runtime.run("继续处理")) {
      // drain
    }

    expect(providerMessages.map((message) => message.role)).toEqual(["user", "user", "user"]);
    expect(providerMessages[0]?.text).toContain("<context_checkpoint>");
    expect(providerMessages[0]?.text).toContain("旧问题已经处理");
    expect(providerMessages[1]?.text).toBe("压缩前保留的问题");
    expect(providerMessages[2]?.text).toBe("继续处理");
    const oldUserOccurrences = store.entries.filter((entry) => entry.type === "message" && entry.message.id === oldUser.id);
    expect(oldUserOccurrences).toHaveLength(1);
    expect(store.entries.length).toBeGreaterThan(entriesBefore);
  });

  it("records checkpoint artifacts from tool output as session checkpoints and runtime events", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "call_checkpoint", toolName: "write_file", input: { path: "a.txt" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "write_file",
      label: "write",
      description: "write with checkpoint",
      category: "filesystem",
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: () => "write a.txt",
      async execute() {
        return {
          text: "written",
          artifacts: [
            {
              kind: "file",
              title: "Checkpoint: before write",
              uri: "C:/repo/.agent-runtime/snapshots/session/checkpoints/cp/checkpoint.json",
              metadata: {
                checkpointId: "cp_1",
                label: "before write",
                manifestPath: "C:/repo/.agent-runtime/snapshots/session/checkpoints/cp/checkpoint.json",
                files: 1
              }
            }
          ]
        };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_checkpoint",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      sessionStore: store,
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("write")) {
      events.push(event);
    }

    const checkpointEvent = events.find((event): event is Extract<AgentEvent, { type: "checkpoint-created" }> => event.type === "checkpoint-created");
    expect(checkpointEvent?.checkpoint).toMatchObject({
      id: "cp_1",
      kind: "workspace-checkpoint",
      label: "before write",
      toolCallId: "call_checkpoint",
      toolName: "write_file"
    });
    const sessionCheckpoint = store.entries.find((entry) => entry.type === "checkpoint");
    expect(sessionCheckpoint?.type === "checkpoint" ? sessionCheckpoint.metadata : undefined).toMatchObject({
      id: "cp_1",
      kind: "workspace-checkpoint"
    });
  });

  it("emits checkpoint restore events from restore tool results", async () => {
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        yield { type: "tool-call", id: "call_restore", toolName: "restore_workspace_checkpoint", input: { checkpointPath: "checkpoint.json" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const tool: AgentTool = {
      name: "restore_workspace_checkpoint",
      label: "restore",
      description: "restore checkpoint",
      category: "filesystem",
      concurrency: "exclusive",
      isReadOnly: () => false,
      summarize: () => "restore checkpoint",
      async execute() {
        return {
          text: "restored",
          json: {
            checkpointId: "cp_1",
            restored: ["a.txt"],
            deleted: ["b.txt"],
            skipped: ["large.bin: file-too-large"]
          }
        };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_restore",
      cwd: "C:/repo",
      provider,
      tools: [tool],
      permissionPolicy: allowAllPermissionPolicy,
      maxTurns: 1
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("restore")) {
      events.push(event);
    }

    const restoreEvent = events.find((event): event is Extract<AgentEvent, { type: "checkpoint-restored" }> => event.type === "checkpoint-restored");
    expect(restoreEvent?.restore).toMatchObject({
      checkpointId: "cp_1",
      toolCallId: "call_restore",
      restored: ["a.txt"],
      deleted: ["b.txt"],
      skipped: ["large.bin: file-too-large"]
    });
  });

  it("sends budgeted tool output to the provider while preserving raw tool output in events and storage", async () => {
    let requestCount = 0;
    let secondRequestMessages: Array<{ role: string; toolOutput?: string }> = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        requestCount += 1;
        if (requestCount === 1) {
          yield { type: "tool-call", id: "call_long_context", toolName: "shell", input: { command: "long-output" } };
          yield { type: "stop", reason: "tool-call" };
          return;
        }
        secondRequestMessages = request.messages.map((message) => ({
          role: message.role,
          toolOutput: message.blocks
            .filter((block) => block.type === "tool-result")
            .map((block) => (block.type === "tool-result" ? block.output.text : undefined))
            .filter((value): value is string => Boolean(value))
            .join("\n")
        }));
        yield { type: "text-delta", text: "continued" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const longOutput = "0123456789".repeat(20);
    const tool: AgentTool = {
      name: "shell",
      label: "shell",
      description: "shell",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: (input) => String(input.command),
      async execute() {
        return { text: longOutput, json: { exitCode: 0 } };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_projected_context",
      permissionPolicy: allowAllPermissionPolicy,
      cwd: "C:/repo",
      provider,
      tools: [tool],
      sessionStore: store,
      maxTurns: 2,
      toolOutputBudget: {
        inlineChars: 40,
        headRatio: 0.5
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run long command")) {
      events.push(event);
    }

    const providerToolOutput = secondRequestMessages.find((message) => message.role === "tool")?.toolOutput ?? "";
    expect(providerToolOutput).toContain("characters omitted");
    expect(providerToolOutput).not.toBe(longOutput);

    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.output.text).toBe(longOutput);
    const storedTool = store.entries.find((entry) => entry.type === "message" && entry.message.role === "tool");
    expect(storedTool?.type === "message" ? storedTool.message.blocks[0] : undefined).toMatchObject({
      type: "tool-result",
      output: { text: longOutput }
    });
  });

  it("redacts provider requests by default while preserving raw session and tool state", async () => {
    const envName = "CONEX_RUNTIME_TEST_API_KEY";
    const secret = "runtime_secret_abcdefghijklmnopqrstuvwxyz123456";
    const previousSecret = process.env[envName];
    process.env[envName] = secret;

    try {
      let requestCount = 0;
      let placeholder = "";
      const serializedRequests: string[] = [];
      let executedInput: JsonObject | undefined;
      const provider: AgentProvider = {
        id: "scripted",
        async *stream(request) {
          requestCount += 1;
          const serialized = JSON.stringify({
            systemPrompt: request.systemPrompt,
            messages: request.messages
          });
          serializedRequests.push(serialized);
          placeholder = placeholder || serialized.match(/\[SECRET_\d+\]/)?.[0] || "";
          if (requestCount === 1) {
            yield { type: "tool-call", id: "call_secret", toolName: "echo_secret", input: { value: placeholder } };
            yield { type: "stop", reason: "tool-call" };
            return;
          }
          // Keep post-tool prose long enough to avoid synthesis-nudge extra turn
          yield {
            type: "text-delta",
            text: "Secret echo finished successfully; no further tool calls are required.",
          };
          yield { type: "stop", reason: "stop" };
        }
      };
      const tool: AgentTool = {
        name: "echo_secret",
        label: "echo secret",
        description: "echo secret",
        category: "internal",
        concurrency: "exclusive",
        isReadOnly: () => true,
        summarize: () => "echo secret",
        async execute(input) {
          executedInput = input;
          return {
            text: `tool saw ${input.value}`,
            json: { apiKey: secret }
          };
        }
      };
      const store = new InMemorySessionStore();
      const runtime = new AgentRuntime({
        sessionId: "s_secret_redaction",
      permissionPolicy: allowAllPermissionPolicy,
        cwd: "C:/repo",
        systemPrompt: `system has ${secret}`,
        provider,
        tools: [tool],
        sessionStore: store,
        maxTurns: 2
      });

      const events: AgentEvent[] = [];
      for await (const event of runtime.run(`user has ${secret}`)) {
        events.push(event);
      }

      expect(requestCount).toBe(2);
      expect(placeholder).toMatch(/^\[SECRET_\d+\]$/);
      expect(serializedRequests.every((request) => !request.includes(secret))).toBe(true);
      expect(serializedRequests[0]).toContain(placeholder);
      expect(serializedRequests[1]).toContain(placeholder);
      expect(executedInput).toEqual({ value: secret });

      const storedUser = store.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
      expect(JSON.stringify(storedUser)).toContain(secret);
      const storedTool = store.entries.find((entry) => entry.type === "message" && entry.message.role === "tool");
      expect(JSON.stringify(storedTool)).toContain(`tool saw ${secret}`);
      expect(JSON.stringify(storedTool)).toContain(`"apiKey":"${secret}"`);
      const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
      expect(JSON.stringify(toolEnd?.result.output)).toContain(secret);
    } finally {
      if (previousSecret === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousSecret;
      }
    }
  });

  it("materializes very large tool output into a local artifact before storing the tool result", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "agent-runtime-artifacts-"));
    try {
      const provider: AgentProvider = {
        id: "scripted",
        async *stream() {
          yield { type: "tool-call", id: "call_large", toolName: "shell", input: { command: "large-output" } };
          yield { type: "stop", reason: "tool-call" };
        }
      };
      const longOutput = "0123456789".repeat(20);
      const tool: AgentTool = {
        name: "shell",
        label: "shell",
        description: "shell",
        category: "terminal",
        concurrency: "parallel",
        isReadOnly: () => true,
        summarize: (input) => String(input.command),
        async execute() {
          return { text: longOutput };
        }
      };
      const store = new InMemorySessionStore();
      const runtime = new AgentRuntime({
        sessionId: "s_artifact",
      permissionPolicy: allowAllPermissionPolicy,
        cwd: "C:/repo",
        provider,
        tools: [tool],
        sessionStore: store,
        maxTurns: 1,
        toolOutputBudget: {
          artifactChars: 80,
          artifactDir: artifactRoot,
          inlineChars: 40
        }
      });

      const events: AgentEvent[] = [];
      for await (const event of runtime.run("run large command")) {
        events.push(event);
      }

      const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
      expect(toolEnd?.result.output.text).toContain("Full tool output saved to artifact");
      expect(toolEnd?.result.output.text).not.toBe(longOutput);
      const artifactPath = toolEnd?.result.output.artifacts?.find((artifact) => artifact.metadata?.artifactKind === "tool-output")?.uri;
      expect(artifactPath).toBeTruthy();
      await expect(readFile(String(artifactPath), "utf8")).resolves.toBe(longOutput);

      const storedTool = store.entries.find((entry) => entry.type === "message" && entry.message.role === "tool");
      const storedOutput = storedTool?.type === "message" ? storedTool.message.blocks[0] : undefined;
      expect(storedOutput).toMatchObject({
        type: "tool-result",
        output: {
          artifacts: [expect.objectContaining({ uri: artifactPath })]
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("compresses context between tool rounds while preserving raw tool-end output", async () => {
    let requestCount = 0;
    const requests: JsonObject[] = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        requestCount += 1;
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            text: message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
          }))
        });
        if (requestCount === 1) {
          yield { type: "tool-call", id: "call_long", toolName: "shell", input: { command: "long-output" } };
          yield { type: "stop", reason: "tool-call" };
          return;
        }
        yield { type: "text-delta", text: "continued" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const longOutput = "x".repeat(120);
    const tool: AgentTool = {
      name: "shell",
      label: "shell",
      description: "shell",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: (input) => String(input.command),
      async execute() {
        return { text: longOutput, json: { exitCode: 0 } };
      }
    };
    const store = new InMemorySessionStore();
    const runtime = new AgentRuntime({
      sessionId: "s_compress",
      permissionPolicy: allowAllPermissionPolicy,
      cwd: "C:/repo",
      provider,
      tools: [tool],
      sessionStore: store,
      initialMessages: [
        {
          id: "old_user",
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          blocks: [{ type: "text", text: "old request ".repeat(80) }]
        },
        {
          id: "old_assistant",
          role: "assistant",
          createdAt: "2026-01-01T00:00:01.000Z",
          blocks: [{ type: "text", text: "old answer ".repeat(80) }]
        }
      ],
      maxTurns: 2,
      contextCompression: {
        contextWindowTokens: 64,
        thresholdTokens: 1,
        targetRecentTokens: 1,
        minRecentMessages: 1,
        minMessagesToCompress: 1,
        summarizer: {
          async summarize() {
            return "Earlier turn ran long-output successfully.";
          }
        }
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run a long command")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("context-compression-start");
    expect(events.map((event) => event.type)).toContain("context-compression-end");
    expect(store.entries.some((entry) => entry.type === "compaction")).toBe(true);
    const toolEnd = events.find((event): event is Extract<AgentEvent, { type: "tool-end" }> => event.type === "tool-end");
    expect(toolEnd?.result.output.text).toBe(longOutput);
    const storedTool = store.entries.find((entry) => entry.type === "message" && entry.message.role === "tool");
    expect(storedTool?.type === "message" ? storedTool.message.blocks[0] : undefined).toMatchObject({
      type: "tool-result",
      output: { text: longOutput }
    });
    expect(JSON.stringify(requests[1])).toContain("<context_checkpoint>");
  });

  it("injects runtime steering for repeated tool failures, then pauses for intervention if unrecovered", async () => {
    let requestCount = 0;
    const requests: JsonObject[] = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        requestCount += 1;
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            text: message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
          }))
        });
        yield { type: "tool-call", id: `fail_a_${requestCount}`, toolName: "fail", input: { value: "a" } };
        yield { type: "tool-call", id: `fail_b_${requestCount}`, toolName: "fail", input: { value: "b" } };
        yield { type: "stop", reason: "tool-call" };
      }
    };
    const failingTool: AgentTool = {
      name: "fail",
      label: "fail",
      description: "always fail",
      category: "filesystem",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "fail",
      async execute() {
        throw new Error("boom");
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_recovery",
      cwd: "C:/repo",
      provider,
      tools: [failingTool],
      maxTurns: 4,
      recovery: {
        maxConsecutiveToolErrors: 2,
        maxSteeringMessages: 1
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("trigger failures")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("runtime-steering");
    expect(events.map((event) => event.type)).toContain("runtime-intervention-required");
    expect(JSON.stringify(requests[1])).toContain("Runtime steering: recent tool calls failed repeatedly.");
    expect(requestCount).toBe(2);
  });

  it("treats repeated non-zero terminal exit codes as recoverable tool failures", async () => {
    let requestCount = 0;
    const requests: JsonObject[] = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        requestCount += 1;
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            text: message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
          }))
        });
        if (requestCount <= 2) {
          yield { type: "tool-call", id: `shell_fail_${requestCount}`, toolName: "shell", input: { command: "bad-command" } };
          yield { type: "stop", reason: "tool-call" };
          return;
        }
        yield { type: "text-delta", text: "Recovered after checking the failed command." };
        yield { type: "stop", reason: "stop" };
      }
    };
    const shellTool: AgentTool = {
      name: "shell",
      label: "shell",
      description: "shell",
      category: "terminal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: (input) => String(input.command),
      async execute() {
        return {
          text: "Exit code: 1\nstderr: command not found",
          json: { exitCode: 1, stderr: "command not found" }
        };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_exit_code_recovery",
      cwd: "C:/repo",
      provider,
      tools: [shellTool],
      maxTurns: 4,
      recovery: {
        maxConsecutiveToolErrors: 2,
        maxSteeringMessages: 1
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("run the check")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("runtime-steering");
    expect(JSON.stringify(requests[2])).toContain("Runtime steering: recent tool calls failed repeatedly.");
    expect(requestCount).toBe(3);
  });

  it("steers once when the provider returns an empty assistant turn", async () => {
    let requestCount = 0;
    const requests: JsonObject[] = [];
    const provider: AgentProvider = {
      id: "scripted",
      async *stream(request) {
        requestCount += 1;
        requests.push({
          messages: request.messages.map((message) => ({
            role: message.role,
            text: message.blocks.filter((block) => block.type === "text").map((block) => block.text).join("")
          }))
        });
        if (requestCount === 1) {
          yield { type: "stop", reason: "stop" };
          return;
        }
        yield { type: "text-delta", text: "Recovered after steering." };
        yield { type: "stop", reason: "stop" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_empty",
      cwd: "C:/repo",
      provider,
      maxTurns: 3,
      recovery: {
        maxSteeringMessages: 1
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("do the work")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("runtime-steering");
    expect(JSON.stringify(requests[1])).toContain("previous assistant turn produced no visible text");
    expect(requestCount).toBe(2);
  });

  it("pauses instead of repeatedly steering unrecovered empty assistant turns", async () => {
    let requestCount = 0;
    const provider: AgentProvider = {
      id: "scripted",
      async *stream() {
        requestCount += 1;
        yield { type: "stop", reason: "stop" };
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_empty_loop",
      cwd: "C:/repo",
      provider,
      maxTurns: 5,
      recovery: {
        maxSteeringMessages: 1
      }
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("do the work")) {
      events.push(event);
    }

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.filter((type) => type === "runtime-steering")).toHaveLength(1);
    expect(eventTypes).toContain("runtime-intervention-required");
    expect(requestCount).toBe(2);
  });

  it("records provider startup failures as runtime errors without appending assistant messages", async () => {
    const store = new InMemorySessionStore();
    const provider: AgentProvider = {
      id: "failing-provider",
      async *stream() {
        throw new Error("upstream unavailable");
      }
    };
    const runtime = new AgentRuntime({
      sessionId: "s_provider_failure",
      cwd: "C:/repo",
      provider,
      sessionStore: store
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run("do the work")) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime-error",
        error: "upstream unavailable"
      })
    );
    expect(events.at(-1)).toMatchObject({
      type: "agent-end",
      reason: "error",
      error: "upstream unavailable"
    });
    expect(store.entries.filter((entry) => entry.type === "message").map((entry) => (entry.type === "message" ? entry.message.role : ""))).toEqual(["user"]);
  });
});

