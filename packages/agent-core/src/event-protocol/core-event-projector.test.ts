/**
 * Core Event Protocol tests - CoreEventProjector and type definitions
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@crish/shared-types";
import {
  CoreEventProjector,
  isCoreEventDomain,
  isPhasedCoreEvent,
  isDiagnosticCoreEvent,
  getCoreEventPhase,
  getCoreEventSeverity,
  CORE_EVENT_DOMAINS,
} from "./index";
import type {
  CoreAgentEvent,
} from "./index";

// ─── Helper factories ──────────────────────────────────────

const SID = "test-session";
const TS = "2024-01-01T00:00:00Z";

function makeEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, sessionId: SID, timestamp: TS, ...extra } as AgentEvent;
}

/**
 * Narrow a CoreAgentEvent to a specific domain and return the
 * domain-specific variant. Used in tests to access domain-specific
 * fields after verifying the domain type.
 */
function asDomain<T extends CoreAgentEvent["type"]>(
  core: CoreAgentEvent,
  domain: T,
): Extract<CoreAgentEvent, { type: T }> {
  if (core.type !== domain) {
    throw new Error(`Expected domain "${domain}" but got "${core.type}"`);
  }
  return core as Extract<CoreAgentEvent, { type: T }>;
}

// ─── CoreEventProjector: Agent domain ──────────────────────

describe("CoreEventProjector: agent domain", () => {
  const projector = new CoreEventProjector();

  it("maps agent-start → { type: 'agent', phase: 'start' }", () => {
    const event = makeEvent("agent-start");
    const core = projector.project(event);
    const agent = asDomain(core, "agent");

    expect(agent.type).toBe("agent");
    expect(agent.phase).toBe("start");
    expect(agent.sessionId).toBe(SID);
    expect(agent.timestamp).toBe(TS);
    expect(agent.meta).toEqual({});
  });

  it("maps agent-end → { type: 'agent', phase: 'end' } with reason and error", () => {
    const event = makeEvent("agent-end", { reason: "error", error: "something broke" });
    const core = projector.project(event);
    const agent = asDomain(core, "agent");

    expect(agent.type).toBe("agent");
    expect(agent.phase).toBe("end");
    expect(agent.meta.reason).toBe("error");
    expect(agent.meta.error).toBe("something broke");
  });

  it("maps runtime-intervention-required → { type: 'agent', phase: 'intervention-required' }", () => {
    const event = makeEvent("runtime-intervention-required", {
      reason: "tool-errors",
      choices: ["rollback", "pause"],
      message: "Intervention needed",
    });
    const core = projector.project(event);
    const agent = asDomain(core, "agent");

    expect(agent.type).toBe("agent");
    expect(agent.phase).toBe("intervention-required");
    expect(agent.meta.interventionReason).toBe("tool-errors");
    expect(agent.meta.choices).toEqual(["rollback", "pause"]);
    expect(agent.meta.interventionMessage).toBe("Intervention needed");
  });

  it("maps agent-end without error field", () => {
    const event = makeEvent("agent-end", { reason: "stop" });
    const core = projector.project(event);
    const agent = asDomain(core, "agent");

    expect(agent.type).toBe("agent");
    expect(agent.phase).toBe("end");
    expect(agent.meta.reason).toBe("stop");
    expect(agent.meta.error).toBeUndefined();
  });
});

// ─── CoreEventProjector: Turn domain ───────────────────────

describe("CoreEventProjector: turn domain", () => {
  const projector = new CoreEventProjector();

  it("maps turn-start → { type: 'turn', phase: 'start' }", () => {
    const event = makeEvent("turn-start", { turnIndex: 0 });
    const core = projector.project(event);
    const turn = asDomain(core, "turn");

    expect(turn.type).toBe("turn");
    expect(turn.phase).toBe("start");
    expect(turn.meta.turnIndex).toBe(0);
    expect(turn.meta.toolCallCount).toBeUndefined();
  });

  it("maps turn-end → { type: 'turn', phase: 'end' } with toolCallCount", () => {
    const event = makeEvent("turn-end", { turnIndex: 0, toolCallCount: 3 });
    const core = projector.project(event);
    const turn = asDomain(core, "turn");

    expect(turn.type).toBe("turn");
    expect(turn.phase).toBe("end");
    expect(turn.meta.turnIndex).toBe(0);
    expect(turn.meta.toolCallCount).toBe(3);
  });
});

// ─── CoreEventProjector: Message domain ────────────────────

describe("CoreEventProjector: message domain", () => {
  const projector = new CoreEventProjector();

  it("maps message-start → { type: 'message', phase: 'start' }", () => {
    const msg = { id: "msg-1", role: "assistant", createdAt: TS, blocks: [] };
    const event = makeEvent("message-start", { message: msg });
    const core = projector.project(event);
    const message = asDomain(core, "message");

    expect(message.type).toBe("message");
    expect(message.phase).toBe("start");
    expect(message.meta.message).toEqual(msg);
  });

  it("maps message-delta → { type: 'message', phase: 'delta' }", () => {
    const block = { type: "text", text: "hello" };
    const event = makeEvent("message-delta", { messageId: "msg-1", block });
    const core = projector.project(event);
    const message = asDomain(core, "message");

    expect(message.type).toBe("message");
    expect(message.phase).toBe("delta");
    expect(message.meta.messageId).toBe("msg-1");
    expect(message.meta.block).toEqual(block);
  });

  it("maps message-end → { type: 'message', phase: 'end' }", () => {
    const msg = { id: "msg-1", role: "assistant", createdAt: TS, blocks: [{ type: "text", text: "hello" }] };
    const event = makeEvent("message-end", { message: msg });
    const core = projector.project(event);
    const message = asDomain(core, "message");

    expect(message.type).toBe("message");
    expect(message.phase).toBe("end");
    expect(message.meta.message).toEqual(msg);
  });
});

// ─── CoreEventProjector: Tool domain ───────────────────────

describe("CoreEventProjector: tool domain", () => {
  const projector = new CoreEventProjector();

  it("maps tool-batch-start → { type: 'tool', phase: 'start' } (aggregate)", () => {
    const calls = [{ id: "call-1", toolName: "read", summary: "Read file", input: {}, category: "filesystem", concurrency: "parallel" }];
    const event = makeEvent("tool-batch-start", { batchId: "batch-1", summary: "Batch", calls });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    expect(tool.phase).toBe("start");
    expect(tool.meta.batchId).toBe("batch-1");
    expect(tool.meta.summary).toBe("Batch");
    expect(tool.meta.calls).toEqual(calls);
  });

  it("maps tool-batch-end → { type: 'tool', phase: 'end' } (aggregate)", () => {
    const results = [{ id: "call-1", toolName: "read", output: { text: "file content" }, isError: false, durationMs: 100 }];
    const event = makeEvent("tool-batch-end", { batchId: "batch-1", calls: results });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    expect(tool.phase).toBe("end");
    expect(tool.meta.batchId).toBe("batch-1");
    expect(tool.meta.batchResults).toEqual(results);
  });

  it("maps tool-start → { type: 'tool', phase: 'start' }", () => {
    const call = { id: "call-1", toolName: "read", summary: "Read file", input: {}, category: "filesystem", concurrency: "parallel" };
    const event = makeEvent("tool-start", { batchId: "batch-1", call });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    expect(tool.phase).toBe("start");
    expect(tool.meta.batchId).toBe("batch-1");
    expect(tool.meta.call).toEqual(call);
  });

  it("maps tool-update → { type: 'tool', phase: 'delta' } (KEY: update renamed to delta)", () => {
    const update = { text: "progress..." };
    const event = makeEvent("tool-update", { batchId: "batch-1", toolCallId: "call-1", update });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    // This is the critical mapping: tool-update → phase "delta"
    expect(tool.phase).toBe("delta");
    expect(tool.meta.batchId).toBe("batch-1");
    expect(tool.meta.toolCallId).toBe("call-1");
    expect(tool.meta.update).toEqual(update);
  });

  it("maps tool-end → { type: 'tool', phase: 'end' }", () => {
    const result = { id: "call-1", toolName: "read", output: { text: "file content" }, isError: false, durationMs: 100 };
    const event = makeEvent("tool-end", { batchId: "batch-1", result });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    expect(tool.phase).toBe("end");
    expect(tool.meta.batchId).toBe("batch-1");
    expect(tool.meta.result).toEqual(result);
  });
});

// ─── CoreEventProjector: Compression domain ────────────────

describe("CoreEventProjector: compression domain", () => {
  const projector = new CoreEventProjector();

  it("maps context-compression-start → { type: 'compression', phase: 'start' }", () => {
    const event = makeEvent("context-compression-start", { reason: "threshold", tokensBefore: 50000 });
    const core = projector.project(event);
    const comp = asDomain(core, "compression");

    expect(comp.type).toBe("compression");
    expect(comp.phase).toBe("start");
    expect(comp.meta.reason).toBe("threshold");
    expect(comp.meta.tokensBefore).toBe(50000);
  });

  it("maps context-compression-end → { type: 'compression', phase: 'end' }", () => {
    const result = { id: "cp-1", trigger: "threshold", summary: "compressed", compressedMessageIds: [], keptMessageIds: [], tokensBefore: 50000, tokensAfter: 20000, createdAt: TS };
    const event = makeEvent("context-compression-end", { result, aborted: false });
    const core = projector.project(event);
    const comp = asDomain(core, "compression");

    expect(comp.type).toBe("compression");
    expect(comp.phase).toBe("end");
    expect(comp.meta.result).toEqual(result);
    expect(comp.meta.aborted).toBe(false);
    expect(comp.meta.error).toBeUndefined();
  });

  it("maps context-compression-end with error", () => {
    const event = makeEvent("context-compression-end", { aborted: true, error: "compression failed" });
    const core = projector.project(event);
    const comp = asDomain(core, "compression");

    expect(comp.type).toBe("compression");
    expect(comp.phase).toBe("end");
    expect(comp.meta.aborted).toBe(true);
    expect(comp.meta.error).toBe("compression failed");
  });
});

// ─── CoreEventProjector: Diagnostic domain ─────────────────

describe("CoreEventProjector: diagnostic domain", () => {
  const projector = new CoreEventProjector();

  it("maps approval-requested → { type: 'diagnostic', severity: 'info' }", () => {
    const request = {
      id: "appr-1",
      sessionId: SID,
      cwd: "/tmp",
      tool: { name: "bash", label: "Bash", description: "Run shell command", category: "terminal", concurrency: "sequential", isReadOnly: () => false, summarize: () => "shell", execute: async () => ({ text: "" }) },
      input: {},
      summary: "Run shell command",
    };
    const event = makeEvent("approval-requested", { request });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("approval-requested");
    expect(diag.meta.details?.kind).toBe("approval-requested");
  });

  it("maps approval-resolved → { type: 'diagnostic', severity: 'info' }", () => {
    const decision = { behavior: "allow", reason: "trusted" };
    const event = makeEvent("approval-resolved", { requestId: "appr-1", decision });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("approval-resolved");
    expect(diag.meta.details?.kind).toBe("approval-resolved");
  });

  it("maps runtime-steering → { type: 'diagnostic', severity: 'info' }", () => {
    const message = { id: "msg-s", role: "system", createdAt: TS, blocks: [] };
    const event = makeEvent("runtime-steering", { reason: "tool-loop", message });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("runtime-steering");
    expect(diag.meta.details?.kind).toBe("runtime-steering");
  });

  it("maps runtime-error → { type: 'diagnostic', severity: 'error' }", () => {
    const event = makeEvent("runtime-error", { error: "fatal error" });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("error");
    expect(diag.meta.originalType).toBe("runtime-error");
    expect(diag.meta.message).toContain("fatal error");
    expect(diag.meta.details?.kind).toBe("runtime-error");
  });

  it("maps provider-diagnostic with info phase → { type: 'diagnostic', severity: 'info' }", () => {
    const diagnostic = { phase: "request-start" };
    const event = makeEvent("provider-diagnostic", { diagnostic });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("provider-diagnostic");
  });

  it("maps provider-diagnostic with warn phase → { type: 'diagnostic', severity: 'warn' }", () => {
    const diagnostic = { phase: "retry" };
    const event = makeEvent("provider-diagnostic", { diagnostic });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("warn");
  });

  it("maps provider-diagnostic with error phase → { type: 'diagnostic', severity: 'error' }", () => {
    const diagnostic = { phase: "request-error" };
    const event = makeEvent("provider-diagnostic", { diagnostic });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("error");
  });

  it("maps checkpoint-created → { type: 'diagnostic', severity: 'info' }", () => {
    const checkpoint = { id: "cp-1", kind: "workspace-checkpoint", label: "Checkpoint", toolCallId: "call-1", toolName: "write" };
    const event = makeEvent("checkpoint-created", { checkpoint });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("checkpoint-created");
    expect(diag.meta.details?.kind).toBe("checkpoint-created");
  });

  it("maps checkpoint-restored → { type: 'diagnostic', severity: 'info' }", () => {
    const restore = { checkpointId: "cp-1", toolCallId: "call-1", toolName: "undo", restored: [], deleted: [], skipped: [] };
    const event = makeEvent("checkpoint-restored", { restore });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("checkpoint-restored");
  });

  it("maps tool-input-repaired → { type: 'diagnostic', severity: 'info' }", () => {
    const event = makeEvent("tool-input-repaired", { toolCallId: "call-1", toolName: "bash", notes: ["alias resolved"] });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("tool-input-repaired");
  });

  it("maps run-terminal completed → { type: 'diagnostic', severity: 'info' }", () => {
    const event = makeEvent("run-terminal", { runId: "run-1", terminal: "completed" });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.meta.originalType).toBe("run-terminal");
    expect(diag.meta.details?.kind).toBe("run-terminal");
  });

  it("maps run-terminal cancelled → { type: 'diagnostic', severity: 'warn' }", () => {
    const event = makeEvent("run-terminal", { runId: "run-1", terminal: "cancelled" });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("warn");
  });

  it("maps run-terminal failed → { type: 'diagnostic', severity: 'error' }", () => {
    const event = makeEvent("run-terminal", { runId: "run-1", terminal: "failed", error: "crash" });
    const core = projector.project(event);
    const diag = asDomain(core, "diagnostic");

    expect(diag.type).toBe("diagnostic");
    expect(diag.severity).toBe("error");
    expect(diag.meta.details?.kind).toBe("run-terminal");
  });
});

// ─── CoreEventProjector: Tracing context ──────────────────

describe("CoreEventProjector: tracing context", () => {
  const projector = new CoreEventProjector();

  it("adds traceId and spanId when tracing context is provided", () => {
    const event = makeEvent("agent-start");
    const core = projector.project(event, { traceId: "trace-1", spanId: "span-1" });

    expect(core.traceId).toBe("trace-1");
    expect(core.spanId).toBe("span-1");
  });

  it("leaves traceId and spanId undefined when no tracing context", () => {
    const event = makeEvent("agent-start");
    const core = projector.project(event);

    expect(core.traceId).toBeUndefined();
    expect(core.spanId).toBeUndefined();
  });
});

// ─── Exhaustive mapping: all 24 AgentEvent types ───────────

describe("CoreEventProjector: exhaustive mapping", () => {
  const projector = new CoreEventProjector();

  const ALL_AGENT_EVENT_TYPES: string[] = [
    "agent-start",
    "agent-end",
    "turn-start",
    "turn-end",
    "message-start",
    "message-delta",
    "message-end",
    "tool-batch-start",
    "tool-batch-end",
    "tool-start",
    "tool-update",
    "tool-end",
    "context-compression-start",
    "context-compression-end",
    "runtime-steering",
    "runtime-intervention-required",
    "approval-requested",
    "approval-resolved",
    "runtime-error",
    "provider-diagnostic",
    "checkpoint-created",
    "checkpoint-restored",
    "tool-input-repaired",
    "run-terminal",
  ];

  it("maps all 24 AgentEvent types without error", () => {
    for (const type of ALL_AGENT_EVENT_TYPES) {
      const event = makeEvent(type, {
        turnIndex: 0, reason: "stop",
        message: { id: "m", role: "assistant", createdAt: TS, blocks: [] },
        choices: [],
        call: { id: "c", toolName: "read", summary: "", input: {}, category: "filesystem", concurrency: "parallel" },
        update: {},
        result: { id: "c", toolName: "read", output: {}, isError: false, durationMs: 0 },
        calls: [],
        batchId: "b",
        toolCallId: "c",
        messageId: "m",
        block: { type: "text", text: "" },
        diagnostic: { phase: "request-start" },
        checkpoint: { id: "cp", kind: "workspace-checkpoint", label: "", toolCallId: "", toolName: "" },
        restore: { checkpointId: "", toolCallId: "", toolName: "", restored: [], deleted: [], skipped: [] },
        notes: [],
        toolName: "",
        request: { id: "", sessionId: "", cwd: "", tool: { name: "", label: "", description: "", category: "terminal", concurrency: "sequential", isReadOnly: () => false, summarize: () => "", execute: async () => ({}) }, input: {}, summary: "" },
        decision: { behavior: "allow" },
        requestId: "",
        error: "",
        tokensBefore: 0,
        aborted: false,
        runId: "",
        terminal: "completed",
      });
      const core = projector.project(event);
      expect(core.type).toBeDefined();
      expect(CORE_EVENT_DOMAINS).toContain(core.type);
    }
  });

  it("maps each type to the expected domain", () => {
    const expectedDomains: Record<string, string> = {
      "agent-start": "agent",
      "agent-end": "agent",
      "turn-start": "turn",
      "turn-end": "turn",
      "message-start": "message",
      "message-delta": "message",
      "message-end": "message",
      "tool-batch-start": "tool",
      "tool-batch-end": "tool",
      "tool-start": "tool",
      "tool-update": "tool",
      "tool-end": "tool",
      "context-compression-start": "compression",
      "context-compression-end": "compression",
      "runtime-steering": "diagnostic",
      "runtime-intervention-required": "agent",
      "approval-requested": "diagnostic",
      "approval-resolved": "diagnostic",
      "runtime-error": "diagnostic",
      "provider-diagnostic": "diagnostic",
      "checkpoint-created": "diagnostic",
      "checkpoint-restored": "diagnostic",
      "tool-input-repaired": "diagnostic",
      "run-terminal": "diagnostic",
    };

    for (const [agentType, expectedDomain] of Object.entries(expectedDomains)) {
      const event = makeEvent(agentType, {
        turnIndex: 0, reason: "stop",
        message: { id: "m", role: "assistant", createdAt: TS, blocks: [] },
        choices: [],
        call: { id: "c", toolName: "read", summary: "", input: {}, category: "filesystem", concurrency: "parallel" },
        update: {},
        result: { id: "c", toolName: "read", output: {}, isError: false, durationMs: 0 },
        calls: [],
        batchId: "b",
        toolCallId: "c",
        messageId: "m",
        block: { type: "text", text: "" },
        diagnostic: { phase: "request-start" },
        checkpoint: { id: "cp", kind: "workspace-checkpoint", label: "", toolCallId: "", toolName: "" },
        restore: { checkpointId: "", toolCallId: "", toolName: "", restored: [], deleted: [], skipped: [] },
        notes: [],
        toolName: "",
        request: { id: "", sessionId: "", cwd: "", tool: { name: "", label: "", description: "", category: "terminal", concurrency: "sequential", isReadOnly: () => false, summarize: () => "", execute: async () => ({}) }, input: {}, summary: "" },
        decision: { behavior: "allow" },
        requestId: "",
        error: "",
        tokensBefore: 0,
        aborted: false,
        runId: "",
        terminal: "completed",
      });
      const core = projector.project(event);
      expect(core.type).toBe(expectedDomain);
    }
  });
});

// ─── Type guards ───────────────────────────────────────────

describe("Type guards", () => {
  const projector = new CoreEventProjector();

  it("isCoreEventDomain narrows type correctly", () => {
    const event = makeEvent("agent-start");
    const core = projector.project(event);

    expect(isCoreEventDomain(core, "agent")).toBe(true);
    expect(isCoreEventDomain(core, "turn")).toBe(false);
    expect(isCoreEventDomain(core, "diagnostic")).toBe(false);
  });

  it("isPhasedCoreEvent identifies phased events", () => {
    const agentStart = projector.project(makeEvent("agent-start"));
    const runtimeError = projector.project(makeEvent("runtime-error", { error: "err" }));

    expect(isPhasedCoreEvent(agentStart)).toBe(true);
    expect(isPhasedCoreEvent(runtimeError)).toBe(false);
  });

  it("isDiagnosticCoreEvent identifies diagnostic events", () => {
    const agentStart = projector.project(makeEvent("agent-start"));
    const runtimeError = projector.project(makeEvent("runtime-error", { error: "err" }));

    expect(isDiagnosticCoreEvent(agentStart)).toBe(false);
    expect(isDiagnosticCoreEvent(runtimeError)).toBe(true);
  });

  it("getCoreEventPhase returns phase for phased events", () => {
    const agentStart = projector.project(makeEvent("agent-start"));
    const runtimeError = projector.project(makeEvent("runtime-error", { error: "err" }));

    expect(getCoreEventPhase(agentStart)).toBe("start");
    expect(getCoreEventPhase(runtimeError)).toBeUndefined();
  });

  it("getCoreEventSeverity returns severity for diagnostic events", () => {
    const agentStart = projector.project(makeEvent("agent-start"));
    const runtimeError = projector.project(makeEvent("runtime-error", { error: "err" }));

    expect(getCoreEventSeverity(agentStart)).toBeUndefined();
    expect(getCoreEventSeverity(runtimeError)).toBe("error");
  });
});

// ─── CORE_EVENT_DOMAINS constant ──────────────────────────

describe("CORE_EVENT_DOMAINS constant", () => {
  it("contains exactly 6 domains", () => {
    expect(CORE_EVENT_DOMAINS).toHaveLength(6);
    expect(CORE_EVENT_DOMAINS).toEqual(["agent", "turn", "message", "tool", "compression", "diagnostic"]);
  });
});

// ─── Phase naming: delta vs update ─────────────────────────

describe("Phase naming: delta replaces update for tool events", () => {
  const projector = new CoreEventProjector();

  it("tool-update maps to phase 'delta' (not 'update')", () => {
    const event = makeEvent("tool-update", { batchId: "b1", toolCallId: "c1", update: { text: "progress" } });
    const core = projector.project(event);
    const tool = asDomain(core, "tool");

    expect(tool.type).toBe("tool");
    // The critical assertion: phase is "delta", NOT "update"
    expect(tool.phase).toBe("delta");
  });

  it("message-delta maps to phase 'delta' (consistent naming)", () => {
    const event = makeEvent("message-delta", { messageId: "m1", block: { type: "text", text: "hi" } });
    const core = projector.project(event);
    const message = asDomain(core, "message");

    expect(message.type).toBe("message");
    expect(message.phase).toBe("delta");
  });
});