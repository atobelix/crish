import { AgentRuntime } from "./runtime";
import { createId, nowIso } from "./session";
import {
  renderStableProgressLines,
  renderRecentSubagentTaskLines,
  type ProjectProgressLedger,
  type ProjectProgressSnapshotOptions
} from "./project-progress-ledger";
import {
  buildSubagentContextPack,
  type SubagentForkPolicy,
  type SubagentTaskCard
} from "./subagent-context-pack";
import { defineTool } from "./tools";
import type {
  AgentEvent,
  AgentMessage,
  JsonObject,
  ToolExecutionContext
} from "@crish/shared-types";
import type {
  AgentProvider,
  AgentRuntimeOptions,
  AgentTool,
  ToolSource
} from "./types";
import type { InMemoryContextState } from "./context-state";

export type SubagentMode = "research" | "implement" | "verify";
export type SubagentStatus = "started" | "running" | "completed" | "failed";

/**
 * Subagent 递归守卫配置
 *
 * 防止 subagent 无限递归和过度并行：
 * - maxDepth: 最大递归深度（0 表示禁止嵌套，默认 2）
 * - maxSiblings: 同一父 agent 下最大并行 subagent 数量（默认 4）
 */
export interface SubagentDepthGuard {
  maxDepth: number;
  maxSiblings: number;
}

export const DEFAULT_SUBAGENT_DEPTH_GUARD: SubagentDepthGuard = {
  maxDepth: 2,
  maxSiblings: 4,
};

/**
 * 递归深度上下文
 *
 * 通过 ToolExecutionContext.metadata 在父子 agent 之间传递递归深度信息。
 * 每次 subagent 创建时，深度 +1；超过 maxDepth 时拒绝创建。
 */
export interface SubagentDepthContext {
  currentDepth: number;
  parentDepthContext?: SubagentDepthContext;
}

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
  contextPack: JsonObject;
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
  /** 递归深度守卫配置，默认使用 DEFAULT_SUBAGENT_DEPTH_GUARD */
  depthGuard?: SubagentDepthGuard;
  provider: AgentProvider | ((input: JsonObject, context: ToolExecutionContext) => AgentProvider | Promise<AgentProvider>);
  tools?: AgentTool[] | ((input: JsonObject, context: ToolExecutionContext) => AgentTool[] | Promise<AgentTool[]>);
  toolSources?: ToolSource[];
  contextState?: InMemoryContextState;
  onProgress?(event: SubagentProgressEvent): void | Promise<void>;
  permissionPolicy?:
    | AgentRuntimeOptions["permissionPolicy"]
    | ((input: JsonObject, context: ToolExecutionContext) => AgentRuntimeOptions["permissionPolicy"] | Promise<AgentRuntimeOptions["permissionPolicy"]>);
  approvalHandler?: AgentRuntimeOptions["approvalHandler"];
  forkPolicy?:
    | SubagentForkPolicy
    | ((input: JsonObject, context: ToolExecutionContext) => SubagentForkPolicy | Promise<SubagentForkPolicy>);
  policyPack?: string[] | ((input: JsonObject, context: ToolExecutionContext) => string[] | Promise<string[]>);
  projectProgress?: string[] | ((input: JsonObject, context: ToolExecutionContext) => string[] | Promise<string[]>);
  projectProgressLedger?:
    | ProjectProgressLedger
    | ((input: JsonObject, context: ToolExecutionContext) => ProjectProgressLedger | undefined | Promise<ProjectProgressLedger | undefined>);
  projectProgressOptions?: ProjectProgressSnapshotOptions;
  taskCard?: Partial<Omit<SubagentTaskCard, "objective" | "description" | "mode">>;
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
        mode: { type: "string", enum: ["research", "implement", "verify"] },
        forkPolicy: { type: "string", enum: ["task-only", "summary", "full"] }
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

      // ─── 递归深度守卫 ───────────────────────────────
      const guard = options.depthGuard ?? DEFAULT_SUBAGENT_DEPTH_GUARD;
      const parentDepth = extractDepthContext(context);
      const currentDepth = parentDepth.currentDepth + 1;
      if (currentDepth > guard.maxDepth) {
        return {
          text: `Sub-agent creation denied: maximum recursion depth (${guard.maxDepth}) exceeded. Current depth: ${currentDepth}.`,
          json: {
            error: "max-depth-exceeded",
            maxDepth: guard.maxDepth,
            currentDepth,
            description
          }
        };
      }
      const subagentId = createId("agent");
      const parentSessionId = context.sessionId;
      const parentToolCallId = context.toolCallId;
      const provider = await resolveMaybe(options.provider, input, context);
      const tools = await resolveMaybe(options.tools ?? [], input, context);
      const permissionPolicy = await resolveMaybe(options.permissionPolicy, input, context);
      const forkPolicy = forkPolicyField(input) ?? (await resolveMaybe(options.forkPolicy ?? "summary", input, context));
      const policyPack = await resolveMaybe(options.policyPack ?? [], input, context);
      const { projectProgress, recentSubagentTasks } = await resolveSubagentProjectProgress(options, input, context);
      const parentContextState = await options.contextState?.snapshotForCompression();
      const contextPack = buildSubagentContextPack({
        forkPolicy,
        mode,
        prompt,
        description,
        cwd: options.cwd,
        parentSessionId,
        parentToolCallId,
        baseSystemPrompt: options.systemPrompt,
        policyPack,
        projectProgress,
        recentSubagentTasks,
        contextState: parentContextState,
        taskCard: options.taskCard
      });
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
        systemPrompt: `${contextPack.stablePrefix}\n\n${contextPack.volatileContext}`,
        provider,
        tools,
        toolSources: options.toolSources,
        permissionPolicy,
        approvalHandler: options.approvalHandler,
        maxTurns: options.maxTurns,
        subagentDepth: currentDepth,
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
        json: { subagentId, description, mode, status: "started", contextPack: contextPack.metadata }
      });

      let messages: AgentMessage[] = [];
      let status: SubagentRunResult["status"] = "completed";
      let failure = "";
      let finalReason: Extract<AgentEvent, { type: "agent-end" }>["reason"] | undefined;
      try {
        const iterator = runtime.run(contextPack.taskCard);
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
          contextPack: contextPack.metadata,
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
        contextPack: contextPack.metadata,
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
    contextPack: result.contextPack,
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

async function resolveSubagentProjectProgress(
  options: SubagentToolOptions,
  input: JsonObject,
  context: ToolExecutionContext
): Promise<{ projectProgress: string[]; recentSubagentTasks: string[] }> {
  const explicitProgress = await resolveMaybe(options.projectProgress ?? [], input, context);
  const ledger = await resolveMaybe(options.projectProgressLedger ?? undefined, input, context);
  if (!ledger) {
    return { projectProgress: explicitProgress, recentSubagentTasks: [] };
  }
  return {
    projectProgress: [
      ...renderStableProgressLines(ledger, options.projectProgressOptions),
      ...explicitProgress
    ],
    recentSubagentTasks: renderRecentSubagentTaskLines(ledger, options.projectProgressOptions)
  };
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

function forkPolicyField(input: JsonObject): SubagentForkPolicy | undefined {
  const value = stringField(input, "forkPolicy");
  return value === "task-only" || value === "summary" || value === "full" ? value : undefined;
}

/**
 * 从 ToolExecutionContext 中提取递归深度上下文
 *
 * 如果 context.metadata 中包含 subagentDepth，使用该值；
 * 否则默认为 0（顶层 agent）。
 */
function extractDepthContext(context: ToolExecutionContext): SubagentDepthContext {
  const depth = typeof context.metadata?.subagentDepth === "number"
    ? context.metadata.subagentDepth
    : 0;
  return {
    currentDepth: depth,
    parentDepthContext: depth > 0
      ? { currentDepth: depth - 1 }
      : undefined,
  };
}
