import type { OrchestratorEvent, OrchestratorRunHandle, StartRunRequest } from "@crish/agent-orchestrator";
import { isRecord } from "@crish/shared-utils";
import type { AgentEvent, AgentMessage, JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";
import {
  buildSubagentContextPack,
  createId,
  defineTool,
  type AgentTool,
  type SubagentForkPolicy,
} from "@crish/agent-runtime";

export const DAEMON_SUBAGENT_BRIDGE_KIND = "daemon-subagent-runtime";
/** 默认子 agent 嵌套深度；可用 CRISH_MAX_SUBAGENT_DEPTH 覆盖，0 表示实际上限 32 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 8;
/** 深度「不限制」时的安全封顶，防止无限递归 */
export const SUBAGENT_DEPTH_HARD_CAP = 32;

export type DaemonSubagentMode = "research" | "implement" | "verify";

export interface DaemonSubagentRunRequest {
  id: string;
  sessionId: string;
  cwd: string;
  input: string;
  metadata: JsonObject;
}

export interface DaemonSubagentToolOptions {
  parentRunId: string;
  parentSessionId: string;
  cwd: string;
  depth: number;
  maxDepth?: number;
  /** 与 DaemonPermissionMode / TrustPolicyMode 对齐（含 unattended） */
  permissionMode: "ask" | "auto" | "full-access" | "plan" | "unattended";
  maxTurns?: number;
  startRun(request: StartRunRequest): Promise<OrchestratorRunHandle>;
  cancelRun(runId: string, reason?: string): boolean;
}

export interface DaemonSubagentBridgeBase {
  kind: typeof DAEMON_SUBAGENT_BRIDGE_KIND;
  parentRunId: string;
  parentSessionId: string;
  parentToolCallId: string;
  subagentRunId: string;
  subagentId: string;
  description: string;
  mode: DaemonSubagentMode;
  depth: number;
}

export type DaemonSubagentBridgeUpdate =
  | (DaemonSubagentBridgeBase & { phase: "started" })
  | (DaemonSubagentBridgeBase & { phase: "event"; event: AgentEvent })
  | (DaemonSubagentBridgeBase & { phase: "ended"; status: "completed" | "failed"; summary: string; error?: string });

interface SubagentRunState {
  status: "completed" | "failed";
  finalReason?: Extract<AgentEvent, { type: "agent-end" }>["reason"];
  finalText: string;
  error?: string;
  events: number;
  toolUses: number;
  turns: number;
}

export function resolveMaxSubagentDepth(configured?: number): number {
  if (configured === undefined || configured === null || Number.isNaN(configured)) {
    return DEFAULT_MAX_SUBAGENT_DEPTH;
  }
  if (configured <= 0) return SUBAGENT_DEPTH_HARD_CAP;
  return Math.min(Math.floor(configured), SUBAGENT_DEPTH_HARD_CAP);
}

export function createDaemonSubagentTool(options: DaemonSubagentToolOptions): AgentTool {
  const maxDepth = resolveMaxSubagentDepth(options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH);

  return defineTool({
    name: "run_subagent",
    label: "Run sub-agent",
    description:
      "Spawn a focused collaborator agent as a separate daemon run (parallel-safe). " +
      "Use multiple run_subagent calls in one turn for concurrent research/implement/verify. " +
      "Each child has its own session; results stream back to this parent tool call.",
    category: "agent",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task prompt for the child agent." },
        description: { type: "string", description: "Short human-readable task label." },
        mode: { type: "string", enum: ["research", "implement", "verify"] },
        forkPolicy: { type: "string", enum: ["task-only", "summary", "full"] }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    isReadOnly(input) {
      const mode = subagentMode(input);
      return mode === "research" || mode === "verify";
    },
    summarize(input) {
      return stringField(input, "description") ?? stringField(input, "prompt")?.slice(0, 120) ?? "run sub-agent";
    },
    async execute(input, context): Promise<ToolOutput> {
      if (options.depth >= maxDepth) {
        throw new Error(`Maximum sub-agent depth (${maxDepth}) reached`);
      }

      const prompt = requireString(input, "prompt");
      const description = stringField(input, "description") ?? prompt.slice(0, 120);
      const mode = subagentMode(input);
      const forkPolicy = forkPolicyField(input) ?? "summary";
      const subagentRunId = createId("subrun");
      const subagentId = createId("subsession");
      const contextPack = buildSubagentContextPack({
        forkPolicy,
        mode,
        prompt,
        description,
        cwd: options.cwd,
        parentSessionId: options.parentSessionId,
        parentRunId: options.parentRunId,
        parentToolCallId: context.toolCallId,
        baseSystemPrompt: buildDaemonSubagentBasePrompt(mode),
        projectProgress: [
          `parentRunId: ${options.parentRunId}`,
          `parentSessionId: ${options.parentSessionId}`,
          `subagentDepth: ${options.depth + 1}/${maxDepth}`
        ]
      });
      const base: DaemonSubagentBridgeBase = {
        kind: DAEMON_SUBAGENT_BRIDGE_KIND,
        parentRunId: options.parentRunId,
        parentSessionId: options.parentSessionId,
        parentToolCallId: context.toolCallId,
        subagentRunId,
        subagentId,
        description,
        mode,
        depth: options.depth + 1
      };

      const emitBridge = (update: DaemonSubagentBridgeUpdate): void => {
        context.emit({ json: update as unknown as JsonValue });
      };

      emitBridge({ ...base, phase: "started" });

      const handle = await options.startRun({
        id: subagentRunId,
        sessionId: subagentId,
        cwd: options.cwd,
        input: contextPack.taskCard,
        metadata: {
          parentRunId: options.parentRunId,
          parentSessionId: options.parentSessionId,
          parentToolCallId: context.toolCallId,
          subagentDepth: options.depth + 1,
          subagentDescription: description,
          subagentMode: mode,
          subagentForkPolicy: forkPolicy,
          permissionMode: options.permissionMode,
          prompt,
          systemPrompt: contextPack.stablePrefix,
          subagentContextPack: contextPack.metadata,
          ...(options.maxTurns !== undefined ? { maxRounds: options.maxTurns } : {})
        }
      });

      const onAbort = (): void => {
        options.cancelRun(handle.runId, "parent-run-aborted");
      };
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      const state: SubagentRunState = {
        status: "completed",
        finalText: "",
        events: 0,
        toolUses: 0,
        turns: 0
      };

      try {
        await consumeSubagentEvents(handle.events, base, emitBridge, state);
      } catch (cause) {
        state.status = "failed";
        state.error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }

      const summary = buildCompletionSummary(description, mode, state);
      emitBridge({
        ...base,
        phase: "ended",
        status: state.status,
        summary,
        ...(state.error ? { error: state.error } : {})
      });

      return {
        text: state.finalText || summary,
        json: {
          subagentRunId,
          subagentId,
          parentRunId: options.parentRunId,
          parentSessionId: options.parentSessionId,
          parentToolCallId: context.toolCallId,
          description,
          mode,
          status: state.status,
          summary,
          finalText: state.finalText,
          events: state.events,
          toolUses: state.toolUses,
          turns: state.turns,
          contextPack: contextPack.metadata,
          ...(state.finalReason ? { finalReason: state.finalReason } : {}),
          ...(state.error ? { error: state.error } : {})
        }
      };
    }
  });
}

export function readDaemonSubagentBridgeUpdate(value: unknown): DaemonSubagentBridgeUpdate | undefined {
  if (!isRecord(value) || value.kind !== DAEMON_SUBAGENT_BRIDGE_KIND) return undefined;
  if (
    typeof value.parentRunId !== "string" ||
    typeof value.parentSessionId !== "string" ||
    typeof value.parentToolCallId !== "string" ||
    typeof value.subagentRunId !== "string" ||
    typeof value.subagentId !== "string" ||
    typeof value.description !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.depth !== "number"
  ) {
    return undefined;
  }

  const base = value as unknown as DaemonSubagentBridgeBase;
  if (value.phase === "started") {
    return { ...base, phase: "started" };
  }

  if (value.phase === "event" && isRecord(value.event) && typeof value.event.type === "string") {
    return { ...base, phase: "event", event: value.event as unknown as AgentEvent };
  }

  if (
    value.phase === "ended" &&
    (value.status === "completed" || value.status === "failed") &&
    typeof value.summary === "string"
  ) {
    return {
      ...base,
      phase: "ended",
      status: value.status,
      summary: value.summary,
      ...(typeof value.error === "string" ? { error: value.error } : {})
    };
  }

  return undefined;
}

export function readDaemonSubagentBridgeUpdateFromAgentEvent(
  event: AgentEvent
): DaemonSubagentBridgeUpdate | undefined {
  if (event.type !== "tool-update") return undefined;
  return readDaemonSubagentBridgeUpdate(event.update.json);
}

async function consumeSubagentEvents(
  events: AsyncIterable<OrchestratorEvent>,
  base: DaemonSubagentBridgeBase,
  emitBridge: (update: DaemonSubagentBridgeUpdate) => void,
  state: SubagentRunState
): Promise<void> {
  for await (const orchestratorEvent of events) {
    if (orchestratorEvent.type === "run-failed") {
      const err = stringPayload(orchestratorEvent.payload, "error") ?? "Sub-agent run failed";
      state.error = err;
      // 有产出则软完成，便于父 agent 继续决策
      if (state.toolUses > 0 || state.finalText?.trim()) {
        state.status = "completed";
      } else {
        state.status = "failed";
      }
      continue;
    }

    if (orchestratorEvent.type === "run-cancelled") {
      state.error = "Sub-agent run was cancelled";
      state.status =
        state.toolUses > 0 || state.finalText?.trim() ? "completed" : "failed";
      continue;
    }

    if (orchestratorEvent.type !== "runtime-event") {
      continue;
    }

    const childEvent = readRuntimeEvent(orchestratorEvent.payload);
    if (!childEvent) {
      continue;
    }

    observeSubagentEvent(childEvent, state);
    emitBridge({ ...base, phase: "event", event: childEvent });
  }
}

function observeSubagentEvent(event: AgentEvent, state: SubagentRunState): void {
  state.events += 1;
  if (event.type === "tool-start") state.toolUses += 1;
  if (event.type === "turn-start") state.turns += 1;
  if (event.type === "message-end" && event.message.role === "assistant") {
    const text = extractAssistantText(event.message);
    if (text) state.finalText = text;
  }
  if (event.type === "agent-end") {
    state.finalReason = event.reason;
    if (event.reason !== "stop") {
      // 已有工具/正文时软完成：把错误写进摘要，不把整次协作打成 failed
      // （上游 502 等瞬时故障常见，父 agent 仍可基于 partial 结果继续）
      const soft =
        state.toolUses > 0 ||
        Boolean(state.finalText?.trim()) ||
        event.reason === "max-turns";
      if (soft) {
        state.status = "completed";
        state.error = event.error ?? `ended with ${event.reason}`;
      } else {
        state.status = "failed";
        state.error = event.error ?? `Sub-agent ended with ${event.reason}`;
      }
    }
  }
  if (event.type === "runtime-error") {
    if (state.toolUses > 0 || state.finalText?.trim()) {
      state.status = "completed";
      state.error = event.error;
    } else {
      state.status = "failed";
      state.error = event.error;
    }
  }
}

function readRuntimeEvent(payload: JsonObject): AgentEvent | undefined {
  const event = payload.event;
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  return event as unknown as AgentEvent;
}

function extractAssistantText(message: AgentMessage): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function buildCompletionSummary(description: string, mode: DaemonSubagentMode, state: SubagentRunState): string {
  // 用户向摘要：优先模型中文收尾；禁止 mode=/turns= 技术行进 UI
  const title = (description || "协作任务").trim() || "协作任务";
  if (state.finalText && state.finalText.trim()) {
    return state.finalText.trim().slice(0, 1_500);
  }
  if (state.status === "completed") {
    if (state.toolUses > 0) {
      return `${title}已完成（${state.toolUses} 次工具 · ${state.turns} 轮）`;
    }
    return `${title}已完成`;
  }
  if (state.status === "stopped") {
    return `${title}已停止`;
  }
  const err = (state.error || "").trim();
  if (err) {
    const short = err.length > 120 ? `${err.slice(0, 119)}…` : err;
    return `${title}未完成：${short}`;
  }
  // 技术诊断仅进日志，不进 summary
  try {
    console.info("[subagent-summary-fallback]", {
      mode,
      turns: state.turns,
      tools: state.toolUses,
      events: state.events,
      status: state.status,
    });
  } catch {
    /* ignore */
  }
  return `${title}未完成`;
}

function buildDaemonSubagentBasePrompt(mode: DaemonSubagentMode): string {
  return [
    `You are a focused ${mode} sub-agent running inside the daemon backend.`,
    "Your prompt is self-contained; do not assume access to the parent conversation.",
    "Report concrete findings, files, commands, and verification results. If you modify files, explain exactly what changed.",
    "If a tool fails for policy reasons, skip it and continue with alternatives; do not abort the whole task unless impossible.",
    "Always leave a short Chinese summary at the end even if some steps failed.",
  ].join("\n\n");
}

function requireString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function subagentMode(input: JsonObject): DaemonSubagentMode {
  const mode = stringField(input, "mode");
  return mode === "implement" || mode === "verify" || mode === "research" ? mode : "research";
}

function forkPolicyField(input: JsonObject): SubagentForkPolicy | undefined {
  const value = stringField(input, "forkPolicy");
  return value === "task-only" || value === "summary" || value === "full" ? value : undefined;
}

function stringPayload(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}


