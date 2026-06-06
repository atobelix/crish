import { AgentRuntime } from "./runtime";
import { createId, nowIso } from "./session";
import { defineTool } from "./tools";
import type {
  AgentEvent,
  AgentMessage,
  AgentProvider,
  AgentRuntimeOptions,
  AgentTool,
  JsonObject,
  ToolExecutionContext,
  ToolSource
} from "./types";
import type { InMemoryContextState } from "./context-state";

export type SubagentMode = "research" | "implement" | "verify";
export type SubagentStatus = "started" | "running" | "completed" | "failed";

export interface SubagentProgressEvent {
  id: string;
  subagentId: string;
  parentSessionId: string;
  parentToolCallId: string;
  description: string;
  mode: SubagentMode;
  status: SubagentStatus;
  event?: AgentEvent["type"];
  summary?: string;
  reason?: string;
  error?: string;
  finalReason?: Extract<AgentEvent, { type: "agent-end" }>["reason"];
  createdAt: string;
  stats: SubagentRunStats;
}

export interface SubagentRunStats {
  toolUses: number;
  turns: number;
  events: Record<string, number>;
}

export interface SubagentRunResult {
  subagentId: string;
  parentSessionId: string;
  parentToolCallId: string;
  description: string;
  mode: SubagentMode;
  status: "completed" | "failed";
  stats: SubagentRunStats;
  finalText: string;
  completionSummary: string;
  finalReason?: Extract<AgentEvent, { type: "agent-end" }>["reason"];
  error?: string;
  timeline: SubagentProgressEvent[];
}

export interface SubagentToolOptions {
  name?: string;
  label?: string;
  description?: string;
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number;
  provider: AgentProvider | ((input: JsonObject, context: ToolExecutionContext) => AgentProvider | Promise<AgentProvider>);
  tools?: AgentTool[] | ((input: JsonObject, context: ToolExecutionContext) => AgentTool[] | Promise<AgentTool[]>);
  toolSources?: ToolSource[];
  contextState?: InMemoryContextState;
  onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  permissionPolicy?:
    | AgentRuntimeOptions["permissionPolicy"]
    | ((input: JsonObject, context: ToolExecutionContext) => AgentRuntimeOptions["permissionPolicy"] | Promise<AgentRuntimeOptions["permissionPolicy"]>);
  approvalHandler?: AgentRuntimeOptions["approvalHandler"];
}

export function createSubagentTool(options: SubagentToolOptions): AgentTool {
  return defineTool({
    name: options.name ?? "run_subagent",
    label: options.label ?? "Run sub-agent",
    description:
      options.description ??
      "Run a focused child agent with an isolated conversation and return its final result plus structured progress.",
    category: "agent",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task prompt for the child agent." },
        description: { type: "string", description: "Short human-readable task label." },
        mode: { type: "string", enum: ["research", "implement", "verify"] }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    isReadOnly(input) {
      return input.mode === "research" || input.mode === "verify";
    },
    summarize(input) {
      return stringField(input, "description") ?? stringField(input, "prompt")?.slice(0, 120) ?? "run sub-agent";
    },
    async execute(input, context) {
      const prompt = requireString(input, "prompt");
      const description = stringField(input, "description") ?? prompt.slice(0, 120);
      const mode = subagentMode(input);
      const subagentId = createId("agent");
      const parentSessionId = context.sessionId;
      const parentToolCallId = context.toolCallId;
      const provider = await resolveMaybe(options.provider, input, context);
      const tools = await resolveMaybe(options.tools ?? [], input, context);
      const permissionPolicy = await resolveMaybe(options.permissionPolicy, input, context);
      const stats: SubagentRunStats = { toolUses: 0, turns: 0, events: {} };
      const timeline: SubagentProgressEvent[] = [];
      const emitProgress = async (
        event: Omit<SubagentProgressEvent, "id" | "createdAt" | "stats" | "parentSessionId" | "parentToolCallId">
      ): Promise<void> => {
        const progress: SubagentProgressEvent = {
          id: createId("subevent"),
          createdAt: nowIso(),
          stats: { toolUses: stats.toolUses, turns: stats.turns, events: { ...stats.events } },
          parentSessionId,
          parentToolCallId,
          ...event
        };
        timeline.push(progress);
        context.emit({ json: { subagent: progressToJson(progress) } });
        await options.onProgress?.(progress);
      };

      options.contextState?.addTask(description, subagentId);
      options.contextState?.recordEvent(`Sub-agent ${description} started in ${mode} mode.`);
      const runtime = new AgentRuntime({
        sessionId: subagentId,
        cwd: options.cwd,
        systemPrompt: buildSubagentSystemPrompt(options.systemPrompt, input),
        provider,
        tools,
        toolSources: options.toolSources,
        permissionPolicy,
        approvalHandler: options.approvalHandler,
        maxTurns: options.maxTurns
      });

      await emitProgress({
        subagentId,
        description,
        mode,
        status: "started",
        summary: "sub-agent started"
      });
      context.emit({
        text: `Sub-agent started: ${description}`,
        json: { subagentId, description, mode, status: "started" }
      });

      let messages: AgentMessage[] = [];
      let status: SubagentRunResult["status"] = "completed";
      let failure = "";
      let finalReason: Extract<AgentEvent, { type: "agent-end" }>["reason"] | undefined;
      try {
        const iterator = runtime.run(prompt);
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            messages = next.value;
            break;
          }
          if (next.value.type === "agent-end") {
            finalReason = next.value.reason;
            if (next.value.reason !== "stop") {
              status = "failed";
              failure = next.value.error ?? `child agent ended with ${next.value.reason}`;
            }
          }
          const progress = observeSubagentEvent(next.value, stats, subagentId, description, mode);
          if (progress) await emitProgress(progress);
        }
      } catch (cause) {
        status = "failed";
        failure = cause instanceof Error ? cause.message : String(cause);
        await emitProgress({
          subagentId,
          description,
          mode,
          status: "failed",
          event: "runtime-error",
          error: failure
        });
      }

      const finalText = extractFinalAssistantText(messages);
      const completionSummary = buildCompletionSummary({ description, mode, status, finalText, failure, stats });
      if (status === "completed") {
        options.contextState?.completeTask(subagentId, completionSummary);
      } else {
        options.contextState?.recordEvent(`Sub-agent ${description} failed: ${failure}`);
      }
      await emitProgress({
        subagentId,
        description,
        mode,
        status,
        event: "agent-end",
        summary: completionSummary,
        error: failure || undefined,
        finalReason
      });
      context.emit({
        text: `Sub-agent finished: ${description}`,
        json: {
          subagentId,
          description,
          mode,
          status,
          stats: statsToJson(stats),
          completionSummary,
          ...(finalReason ? { finalReason } : {}),
          ...(failure ? { error: failure } : {})
        }
      });

      const result: SubagentRunResult = {
        subagentId,
        parentSessionId,
        parentToolCallId,
        description,
        mode,
        status,
        stats,
        finalText,
        completionSummary,
        finalReason,
        error: failure || undefined,
        timeline
      };
      return {
        text: finalText || completionSummary || "Sub-agent completed without a final text response.",
        json: resultToJson(result)
      };
    }
  });
}

function resultToJson(result: SubagentRunResult): JsonObject {
  return {
    subagentId: result.subagentId,
    parentSessionId: result.parentSessionId,
    parentToolCallId: result.parentToolCallId,
    description: result.description,
    mode: result.mode,
    status: result.status,
    stats: statsToJson(result.stats),
    finalText: result.finalText,
    completionSummary: result.completionSummary,
    ...(result.finalReason ? { finalReason: result.finalReason } : {}),
    ...(result.error ? { error: result.error } : {}),
    timeline: result.timeline.map(progressToJson)
  };
}

function progressToJson(progress: SubagentProgressEvent): JsonObject {
  return {
    id: progress.id,
    subagentId: progress.subagentId,
    parentSessionId: progress.parentSessionId,
    parentToolCallId: progress.parentToolCallId,
    description: progress.description,
    mode: progress.mode,
    status: progress.status,
    ...(progress.event ? { event: progress.event } : {}),
    ...(progress.summary ? { summary: progress.summary } : {}),
    ...(progress.reason ? { reason: progress.reason } : {}),
    ...(progress.error ? { error: progress.error } : {}),
    ...(progress.finalReason ? { finalReason: progress.finalReason } : {}),
    createdAt: progress.createdAt,
    stats: statsToJson(progress.stats)
  };
}

function statsToJson(stats: SubagentRunStats): JsonObject {
  return {
    toolUses: stats.toolUses,
    turns: stats.turns,
    events: { ...stats.events }
  };
}

function observeSubagentEvent(
  event: AgentEvent,
  stats: SubagentRunStats,
  subagentId: string,
  description: string,
  mode: SubagentMode
): Omit<SubagentProgressEvent, "id" | "createdAt" | "stats" | "parentSessionId" | "parentToolCallId"> | null {
  stats.events[event.type] = (stats.events[event.type] ?? 0) + 1;
  if (event.type === "tool-start") stats.toolUses += 1;
  if (event.type === "turn-start") stats.turns += 1;
  if (event.type === "tool-batch-start" || event.type === "runtime-steering" || event.type === "runtime-intervention-required" || event.type === "agent-end" || event.type === "runtime-error") {
    const failedEnd = event.type === "agent-end" && event.reason !== "stop";
    return {
      subagentId,
      description,
      mode,
      status: failedEnd || event.type === "runtime-error" ? "failed" : "running",
      event: event.type,
      summary: "summary" in event ? event.summary : undefined,
      reason: "reason" in event ? event.reason : undefined,
      error: "error" in event ? event.error : undefined,
      finalReason: event.type === "agent-end" ? event.reason : undefined
    };
  }
  return null;
}

function buildSubagentSystemPrompt(basePrompt: string | undefined, input: JsonObject): string {
  const mode = subagentMode(input);
  return [
    basePrompt,
    `You are a focused ${mode} sub-agent. Your prompt is self-contained; do not assume access to the parent conversation.`,
    "Report concrete findings, files, commands, and verification results. If you modify files, explain exactly what changed."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractFinalAssistantText(messages: AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "";
  return assistant.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function buildCompletionSummary(input: {
  description: string;
  mode: SubagentMode;
  status: SubagentRunResult["status"];
  finalText: string;
  failure: string;
  stats: SubagentRunStats;
}): string {
  const outcome = input.status === "completed" ? "completed" : `failed: ${input.failure || "unknown error"}`;
  const text = input.finalText ? input.finalText.slice(0, 1_000) : "No final text response.";
  return [
    `${input.description} ${outcome}.`,
    `mode=${input.mode}; turns=${input.stats.turns}; tools=${input.stats.toolUses}.`,
    text
  ].join("\n");
}

async function resolveMaybe<T>(
  value: T | ((input: JsonObject, context: ToolExecutionContext) => T | Promise<T>),
  input: JsonObject,
  context: ToolExecutionContext
): Promise<T> {
  return typeof value === "function" ? (value as (input: JsonObject, context: ToolExecutionContext) => T | Promise<T>)(input, context) : value;
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

function subagentMode(input: JsonObject): SubagentMode {
  const mode = stringField(input, "mode");
  return mode === "implement" || mode === "verify" || mode === "research" ? mode : "research";
}
