import { describe, expect, it } from "vitest";
import {
  ContextCompressor,
  estimateContextTokens,
  extractRecentTerminalCommandFacts,
  findFirstKeptMessageIndex,
  serializeMessagesForSummary
} from "./context-compression";
import { createTextMessage, nowIso } from "./session";
import type { AgentMessage } from "@crish/shared-types";
import type { ContextStateReader, ContextSummaryRequest } from "./types";

function assistantWithToolCall(): AgentMessage {
  return {
    id: "assistant_tool",
    role: "assistant",
    createdAt: nowIso(),
    blocks: [
      { type: "thought", text: "private chain of thought" },
      { type: "text", text: "I will inspect the repo." },
      { type: "tool-call", id: "call_status", toolName: "shell_command", input: { command: "git status --short", cwd: "C:/repo" } }
    ]
  };
}

function toolResult(): AgentMessage {
  return {
    id: "tool_status",
    role: "tool",
    createdAt: nowIso(),
    blocks: [
      {
        type: "tool-result",
        toolCallId: "call_status",
        toolName: "shell_command",
        isError: false,
        output: {
          text: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\n M src/runtime.ts",
          json: { exitCode: 0 }
        }
      }
    ]
  };
}

function compressibleMessages(): AgentMessage[] {
  return [
    createTextMessage("user", "old request ".repeat(20)),
    createTextMessage("assistant", "old answer ".repeat(20)),
    assistantWithToolCall(),
    toolResult(),
    createTextMessage("assistant", "I checked the repo."),
    createTextMessage("user", "continue from here")
  ];
}

function testCompressor(requests: ContextSummaryRequest[], options: Partial<ConstructorParameters<typeof ContextCompressor>[0]> = {}): ContextCompressor {
  return new ContextCompressor({
    contextWindowTokens: 128,
    thresholdTokens: 1,
    targetRecentTokens: 1,
    minRecentMessages: 1,
    minMessagesToCompress: 1,
    summarizer: {
      async summarize(input) {
        requests.push(input);
        return `summary:${input.reason}`;
      }
    },
    ...options
  });
}

describe("context compression", () => {
  it("serializes model-visible history without thought blocks", () => {
    const serialized = serializeMessagesForSummary([assistantWithToolCall(), toolResult()]);

    expect(serialized).toContain("I will inspect the repo.");
    expect(serialized).toContain("shell_command");
    expect(serialized).toContain("Exit code: 0");
    expect(serialized).not.toContain("private chain of thought");
  });

  it("extracts recent terminal command evidence", () => {
    const facts = extractRecentTerminalCommandFacts([assistantWithToolCall(), toolResult()]);

    expect(facts.successful).toEqual([
      "$ git status --short | cwd=C:/repo | exit=0 | result=Exit code: 0"
    ]);
    expect(facts.failed).toEqual([]);
  });

  it("keeps tool call messages when their tool results are retained", () => {
    const messages = [createTextMessage("user", "old"), assistantWithToolCall(), toolResult(), createTextMessage("user", "latest")];

    expect(findFirstKeptMessageIndex(messages, 20, 1)).toBe(1);
  });

  it("always keeps the latest user message even when many assistant messages follow it", () => {
    const messages = [
      createTextMessage("user", "old"),
      createTextMessage("assistant", "old answer"),
      createTextMessage("user", "latest user request"),
      createTextMessage("assistant", "step 1 ".repeat(40)),
      createTextMessage("assistant", "step 2 ".repeat(40)),
      createTextMessage("assistant", "step 3 ".repeat(40))
    ];

    expect(findFirstKeptMessageIndex(messages, 10, 1)).toBe(2);
  });

  it("ignores retained pre-compaction usage after a compression summary boundary", () => {
    const summary: AgentMessage = {
      id: "compact_boundary",
      role: "user",
      createdAt: "2026-01-01T00:00:10.000Z",
      blocks: [{ type: "text", text: "<context_checkpoint>\nsummary\n</context_checkpoint>" }],
      metadata: { kind: "context-compression-summary" }
    };
    const retainedAssistant: AgentMessage = {
      id: "retained_assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:00:01.000Z",
      blocks: [{ type: "text", text: "retained answer" }],
      metadata: { usage: { totalTokens: 100_000 } }
    };
    const retainedUser: AgentMessage = {
      id: "retained_user",
      role: "user",
      createdAt: "2026-01-01T00:00:02.000Z",
      blocks: [{ type: "text", text: "retained user turn" }]
    };

    const estimate = estimateContextTokens([summary, retainedAssistant, retainedUser]);

    expect(estimate.usageTokens).toBe(0);
    expect(estimate.lastUsageMessageIndex).toBeNull();
    expect(estimate.tokens).toBeLessThan(100_000);
  });

  it("uses post-compaction assistant usage once a new response arrives", () => {
    const summary: AgentMessage = {
      id: "compact_boundary",
      role: "user",
      createdAt: "2026-01-01T00:00:10.000Z",
      blocks: [{ type: "text", text: "<context_checkpoint>\nsummary\n</context_checkpoint>" }],
      metadata: { kind: "context-compression-summary" }
    };
    const retainedAssistant: AgentMessage = {
      id: "retained_assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:00:01.000Z",
      blocks: [{ type: "text", text: "retained answer" }],
      metadata: { usage: { totalTokens: 100_000 } }
    };
    const newAssistant: AgentMessage = {
      id: "new_assistant",
      role: "assistant",
      createdAt: "2026-01-01T00:00:11.000Z",
      blocks: [{ type: "text", text: "new answer" }],
      metadata: { usage: { totalTokens: 90 } }
    };

    const estimate = estimateContextTokens([summary, retainedAssistant, newAssistant, createTextMessage("user", "tail")]);

    expect(estimate.usageTokens).toBe(90);
    expect(estimate.lastUsageMessageIndex).toBe(2);
    expect(estimate.tokens).toBeGreaterThan(90);
    expect(estimate.tokens).toBeLessThan(100_000);
  });

  it("builds a summary message and passes bounded evidence to the summarizer", async () => {
    let request: ContextSummaryRequest | undefined;
    const messages = [
      createTextMessage("user", "old request"),
      assistantWithToolCall(),
      toolResult(),
      createTextMessage("assistant", "I checked the repo."),
      createTextMessage("user", "continue from here")
    ];
    const compressor = new ContextCompressor({
      contextWindowTokens: 128,
      thresholdTokens: 1,
      targetRecentTokens: 1,
      minRecentMessages: 1,
      minMessagesToCompress: 1,
      summarizer: {
        async summarize(input) {
          request = input;
          return "Repo status was checked; continue with the latest user request.";
        }
      }
    });

    const result = await compressor.maybeCompress(messages);

    expect(result).not.toBeNull();
    expect(request?.reason).toBe("threshold");
    expect(request?.policy).toMatchObject({ tier: "proactive", action: "compact", providerRetry: false });
    expect(request?.serializedConversation).not.toContain("private chain of thought");
    expect(request?.recentSuccessfulCommands[0]).toContain("git status --short");
    expect(result?.record).toMatchObject({
      reason: "threshold",
      policy: { tier: "proactive", action: "compact", providerRetry: false }
    });
    expect(result?.messages[0]?.blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<context_checkpoint>")
    });
    expect(result?.messages.at(-1)?.blocks[0]).toMatchObject({ type: "text", text: "continue from here" });
  });

  it("gates threshold compaction while forced triggers can compact below the threshold", async () => {
    const requests: ContextSummaryRequest[] = [];
    const messages = compressibleMessages();
    const compressor = testCompressor(requests, { thresholdTokens: 100_000 });

    expect(compressor.shouldCompress(messages, "auto")).toMatchObject({
      shouldCompress: false,
      reason: "threshold",
      policy: { forced: false, thresholdExceeded: false, providerRetry: false }
    });
    expect(compressor.shouldCompress(messages, "threshold")).toMatchObject({
      shouldCompress: false,
      reason: "threshold",
      policy: { forced: false, thresholdExceeded: false, providerRetry: false }
    });
    await expect(compressor.maybeCompress(messages, "threshold")).resolves.toBeNull();

    const manual = await compressor.maybeCompress(messages, "manual");

    expect(manual?.record).toMatchObject({
      trigger: "manual",
      reason: "manual",
      policy: { tier: "manual", action: "compact", forced: true, thresholdExceeded: false, providerRetry: false }
    });
    expect(requests.at(-1)).toMatchObject({
      trigger: "manual",
      reason: "manual",
      handoffIntent: false,
      policy: { providerRetry: false }
    });
  });

  it.each([
    ["manual", "manual", "compact", false],
    ["threshold", "proactive", "compact", false],
    ["idle", "background", "compact", false],
    ["overflow", "recovery", "promote-handoff", true],
    ["incomplete", "recovery", "promote-handoff", true],
    ["handoff", "handoff", "promote-handoff", true]
  ] as const)("passes typed %s policy to the summarizer and record", async (trigger, tier, action, handoffIntent) => {
    const requests: ContextSummaryRequest[] = [];
    const messages = compressibleMessages();
    const compressor = testCompressor(requests);

    const result = await compressor.maybeCompress(messages, trigger);

    expect(result?.record).toMatchObject({
      trigger,
      reason: trigger,
      policy: { tier, action, providerRetry: false }
    });
    expect(requests[0]).toMatchObject({
      trigger,
      reason: trigger,
      handoffIntent,
      policy: { tier, action, providerRetry: false }
    });
  });

  it("marks overflow compaction as recovery promotion instead of provider retry", async () => {
    const requests: ContextSummaryRequest[] = [];
    const messages = compressibleMessages();
    const compressor = testCompressor(requests, { thresholdTokens: 100_000 });

    expect(compressor.shouldCompress(messages, "overflow")).toMatchObject({
      shouldCompress: true,
      reason: "overflow",
      handoffIntent: true,
      policy: { tier: "recovery", action: "promote-handoff", forced: true, thresholdExceeded: false, providerRetry: false }
    });

    const result = await compressor.maybeCompress(messages, "overflow");

    expect(requests[0]).toMatchObject({
      trigger: "overflow",
      reason: "overflow",
      handoffIntent: true,
      policy: { providerRetry: false }
    });
    expect(result?.record.handoff).toMatchObject({
      reason: "overflow",
      action: "promote-handoff",
      providerRetry: false
    });
  });

  it("emits handoff metadata through the record and summary message metadata", async () => {
    const requests: ContextSummaryRequest[] = [];
    let recorded: unknown;
    const contextState: ContextStateReader = {
      snapshotForCompression() {
        return {
          completedTaskSummaries: ["wire compression: done"],
          pendingTasks: ["task_2: finish UI event"],
          sessionEvents: ["2026-01-01T00:00:00.000Z: user asked for handoff"],
          fileSnapshotHints: ["src/runtime.ts: before compaction (snap_1)"],
          previousCompressionSummary: "previous summary"
        };
      },
      recordCompression(record) {
        recorded = record;
      }
    };
    const messages = compressibleMessages();
    const compressor = testCompressor(requests, {
      contextState,
      summarizer: {
        async summarize(input) {
          requests.push(input);
          return "handoff summary";
        }
      }
    });

    const result = await compressor.maybeCompress(messages, "handoff");
    if (!result) throw new Error("expected handoff compression");

    expect(requests[0]?.previousSummary).toBe("previous summary");
    expect(result.record.handoff).toMatchObject({
      trigger: "handoff",
      reason: "handoff",
      tier: "handoff",
      action: "promote-handoff",
      summary: "handoff summary",
      firstKeptMessageId: result.record.firstKeptMessageId,
      lastMessageId: messages.at(-1)?.id,
      lastUserMessageId: messages.at(-1)?.id,
      completedTaskSummaries: ["wire compression: done"],
      pendingTasks: ["task_2: finish UI event"],
      sessionEvents: ["2026-01-01T00:00:00.000Z: user asked for handoff"],
      fileSnapshotHints: ["src/runtime.ts: before compaction (snap_1)"]
    });
    expect(result.record.details?.structuredSummary).toMatchObject({
      version: 1,
      kind: "context-compression",
      goal: "continue from here",
      progress: ["handoff summary", "wire compression: done"],
      nextSteps: ["task_2: finish UI event"],
      readFiles: ["src/runtime.ts"],
      sourceIds: expect.arrayContaining(messages.map((message) => message.id))
    });
    expect(result.record.cacheBoundary).toMatchObject({
      kind: "context-compression-cache-boundary",
      version: 1,
      cacheKey: expect.stringMatching(/^context-compression:v1:/),
      structuredSummaryCacheKey: expect.stringMatching(/^structured-summary:v1:/),
      structuredSummaryStableHash: result.record.cacheBoundary?.stablePrefixHash,
      invalidates: ["prompt-stable-prefix", "message-history", "usage-baseline", "volatile-context"],
      invalidationReason: "handoff",
      compressedMessageIds: result.record.compressedMessageIds,
      keptMessageIds: result.record.keptMessageIds,
      firstKeptMessageId: result.record.firstKeptMessageId
    });
    expect(result.record.details?.structuredSummaryCacheKey).toBe(result.record.cacheBoundary?.structuredSummaryCacheKey);
    expect(result.record.details?.cacheBoundary).toMatchObject({
      cacheKey: result.record.cacheBoundary?.cacheKey,
      invalidationReason: "handoff"
    });
    expect(result.summaryMessage.metadata).toMatchObject({
      kind: "context-compression-summary",
      reason: "handoff",
      policy: { tier: "handoff", action: "promote-handoff", providerRetry: false },
      cacheBoundary: expect.objectContaining({
        structuredSummaryCacheKey: result.record.cacheBoundary?.structuredSummaryCacheKey,
        invalidationReason: "handoff"
      }),
      handoff: expect.objectContaining({
        summary: "handoff summary",
        pendingTasks: ["task_2: finish UI event"]
      })
    });
    expect(recorded).toMatchObject({
      handoff: expect.objectContaining({ summary: "handoff summary" })
    });
  });

  it("does not mutate the original message array or message objects", async () => {
    const requests: ContextSummaryRequest[] = [];
    const messages = compressibleMessages();
    const before = JSON.parse(JSON.stringify(messages));
    const compressor = testCompressor(requests);

    const result = await compressor.maybeCompress(messages, "manual");

    expect(result).not.toBeNull();
    expect(messages).toEqual(before);
    expect(result?.messages).not.toBe(messages);
    expect(result?.summaryMessage).toBe(result?.messages[0]);
  });

  it("returns null when summarizer throws instead of crashing preparing-turn", async () => {
    const messages = compressibleMessages();
    const compressor = new ContextCompressor({
      contextWindowTokens: 128,
      thresholdTokens: 1,
      targetRecentTokens: 1,
      minRecentMessages: 1,
      minMessagesToCompress: 1,
      summarizer: {
        async summarize() {
          throw new Error("summarizer unavailable");
        }
      }
    });

    await expect(compressor.maybeCompress(messages)).resolves.toBeNull();
    await expect(compressor.compress(messages, "manual")).resolves.toBeNull();
  });
});
