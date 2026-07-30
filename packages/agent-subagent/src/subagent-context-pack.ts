import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@crish/shared-types";
import type { ContextStateSnapshot } from "@crish/agent-core";

export const SUBAGENT_CONTEXT_PACK_VERSION = 2;

export type SubagentForkPolicy = "task-only" | "summary" | "full";
export type SubagentContextMode = "research" | "implement" | "verify";

export interface SubagentTaskCard {
  objective: string;
  description: string;
  mode: SubagentContextMode;
  writeScope: string[];
  constraints: string[];
  acceptanceChecks: string[];
  verificationCommands: string[];
}

export interface SubagentContextPackInput {
  forkPolicy?: SubagentForkPolicy;
  mode: SubagentContextMode;
  prompt: string;
  description?: string;
  cwd: string;
  parentSessionId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
  baseSystemPrompt?: string;
  policyPack?: string[];
  projectProgress?: string[];
  recentSubagentTasks?: string[];
  contextState?: ContextStateSnapshot;
  taskCard?: Partial<Omit<SubagentTaskCard, "objective" | "description" | "mode">>;
}

export interface SubagentContextPack {
  version: typeof SUBAGENT_CONTEXT_PACK_VERSION;
  forkPolicy: SubagentForkPolicy;
  stablePrefix: string;
  volatileContext: string;
  taskCard: string;
  prompt: string;
  cache: {
    stablePrefixHash: string;
    volatileContextHash: string;
    taskCardHash: string;
    volatileTaskHash: string;
    cacheKey: string;
    stablePrefixBytes: number;
    volatileContextBytes: number;
    taskCardBytes: number;
    boundary: {
      stablePrefix: string[];
      volatileContext: string[];
      taskCard: string[];
    };
  };
  metadata: JsonObject;
}

const DEFAULT_POLICY_PACK = [
  "Use the single product path: Workbench/Tauri -> daemon -> AgentOrchestrator -> AgentRuntime.",
  "Do not create duplicate implementations or compatibility fallbacks.",
  "Borrow reference-project ideas conceptually only; do not copy source code.",
  "Keep edits inside the assigned write scope and do not revert changes made by others.",
  "For Chinese-bearing files, follow the chinese-encoding-guard workflow before and after edits.",
  "Report changed files, verification commands, results, and residual risks."
];

export function buildSubagentContextPack(input: SubagentContextPackInput): SubagentContextPack {
  const forkPolicy = normalizeForkPolicy(input.forkPolicy);
  const task = normalizeTaskCard(input);
  const stablePrefix = renderStablePrefix(input);
  const volatileContext = renderVolatileContext(input, forkPolicy);
  const taskCard = renderTaskCard(task);
  const prompt = `${stablePrefix}\n\n${volatileContext}\n\n${taskCard}`;
  const stablePrefixHash = hashText(stablePrefix);
  const volatileContextHash = hashText(volatileContext);
  const taskCardHash = hashText(taskCard);
  const boundary = subagentCacheBoundary(forkPolicy);
  return {
    version: SUBAGENT_CONTEXT_PACK_VERSION,
    forkPolicy,
    stablePrefix,
    volatileContext,
    taskCard,
    prompt,
    cache: {
      stablePrefixHash,
      volatileContextHash,
      taskCardHash,
      volatileTaskHash: taskCardHash,
      cacheKey: `subagent-context:v${SUBAGENT_CONTEXT_PACK_VERSION}:${stablePrefixHash}`,
      stablePrefixBytes: Buffer.byteLength(stablePrefix, "utf8"),
      volatileContextBytes: Buffer.byteLength(volatileContext, "utf8"),
      taskCardBytes: Buffer.byteLength(taskCard, "utf8"),
      boundary
    },
    metadata: compactJson({
      kind: "subagent-context-pack",
      version: SUBAGENT_CONTEXT_PACK_VERSION,
      forkPolicy,
      stablePrefixHash,
      volatileContextHash,
      taskCardHash,
      volatileTaskHash: taskCardHash,
      cacheKey: `subagent-context:v${SUBAGENT_CONTEXT_PACK_VERSION}:${stablePrefixHash}`,
      cacheBoundary: boundary as unknown as JsonObject,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      parentToolCallId: input.parentToolCallId,
      cwd: input.cwd,
      mode: task.mode,
      description: task.description
    })
  };
}

export function renderSubagentPromptFromPack(pack: SubagentContextPack): string {
  return pack.prompt;
}

function renderStablePrefix(input: SubagentContextPackInput): string {
  const policyPack = normalizeList(input.policyPack, DEFAULT_POLICY_PACK);
  const projectProgress = normalizeList(input.projectProgress, []);

  return [
    "<subagent_context stable_prefix=\"true\" version=\"1\">",
    "# Role",
    "You are a focused sub-agent. Work independently, but stay aligned with the parent run.",
    "",
    input.baseSystemPrompt?.trim() ? section("Base System Prompt", input.baseSystemPrompt.trim()) : "",
    section("Policy Pack", bullets(policyPack)),
    projectProgress.length > 0 ? section("Shared Project Progress", bullets(projectProgress)) : "",
    "</subagent_context>"
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function renderVolatileContext(input: SubagentContextPackInput, forkPolicy: SubagentForkPolicy): string {
  const recentSubagentTasks = normalizeList(input.recentSubagentTasks, []);
  const state = input.contextState;
  const includeSummary = forkPolicy !== "task-only";
  const includeFullContext = forkPolicy === "full";

  return [
    "<subagent_context volatile=\"true\" version=\"1\">",
    section("Runtime Scope", bullets([
      `mode: ${input.mode}`,
      `cwd: ${input.cwd}`,
      input.parentSessionId ? `parentSessionId: ${input.parentSessionId}` : undefined,
      input.parentRunId ? `parentRunId: ${input.parentRunId}` : undefined,
      input.parentToolCallId ? `parentToolCallId: ${input.parentToolCallId}` : undefined,
      `forkPolicy: ${forkPolicy}`
    ])),
    recentSubagentTasks.length > 0 ? section("Recent Subagent Task Records", bullets(recentSubagentTasks)) : "",
    includeSummary && state ? section("Parent Context Snapshot", renderContextState(state, includeFullContext)) : "",
    "</subagent_context>"
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function renderTaskCard(task: SubagentTaskCard): string {
  return [
    "<subagent_task_card volatile=\"true\" version=\"1\">",
    "# Task Card",
    `Mode: ${task.mode}`,
    `Description: ${task.description}`,
    "",
    "## Objective",
    task.objective,
    "",
    section("Write Scope", bulletsOrNone(task.writeScope)),
    section("Constraints", bulletsOrNone(task.constraints)),
    section("Acceptance Checks", bulletsOrNone(task.acceptanceChecks)),
    section("Verification Commands", bulletsOrNone(task.verificationCommands)),
    "</subagent_task_card>"
  ].join("\n");
}

function normalizeTaskCard(input: SubagentContextPackInput): SubagentTaskCard {
  return {
    objective: input.prompt.trim(),
    description: (input.description ?? input.prompt).trim().slice(0, 180),
    mode: input.mode,
    writeScope: normalizeList(input.taskCard?.writeScope, []),
    constraints: normalizeList(input.taskCard?.constraints, []),
    acceptanceChecks: normalizeList(input.taskCard?.acceptanceChecks, []),
    verificationCommands: normalizeList(input.taskCard?.verificationCommands, [])
  };
}

function renderContextState(state: ContextStateSnapshot, includeFullContext: boolean): string {
  const taskLimit = includeFullContext ? 24 : 12;
  const eventLimit = includeFullContext ? 32 : 16;
  const fileLimit = includeFullContext ? 24 : 12;
  return [
    section("Previous Compression Summary", state.previousCompressionSummary?.trim() || "None recorded."),
    section("Completed Task Summaries", bulletsOrNone(state.completedTaskSummaries.slice(-taskLimit))),
    section("Pending Tasks", bulletsOrNone(state.pendingTasks.slice(-taskLimit))),
    section("Recent Session Events", bulletsOrNone(state.sessionEvents.slice(-eventLimit))),
    section("File Snapshot Hints", bulletsOrNone(state.fileSnapshotHints.slice(-fileLimit)))
  ].join("\n\n");
}

function subagentCacheBoundary(forkPolicy: SubagentForkPolicy): SubagentContextPack["cache"]["boundary"] {
  return {
    stablePrefix: ["baseSystemPrompt", "policyPack", "sharedProjectProgress"],
    volatileContext: [
      "cwd",
      "parentSessionId",
      "parentRunId",
      "parentToolCallId",
      "forkPolicy",
      "recentSubagentTasks",
      ...(forkPolicy === "task-only" ? [] : ["structuredSummary"]),
      ...(forkPolicy === "full" ? ["completedTaskSummaries", "pendingTasks", "sessionEvents", "fileSnapshotHints"] : [])
    ],
    taskCard: ["mode", "description", "objective", "writeScope", "constraints", "acceptanceChecks", "verificationCommands"]
  };
}

function section(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

function bullets(values: Array<string | undefined>): string {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => `- ${value.trim()}`).join("\n");
}

function bulletsOrNone(values: string[]): string {
  return values.length > 0 ? bullets(values) : "- None";
}

function normalizeList(values: string[] | undefined, fallback: string[]): string[] {
  const normalized = (values ?? fallback).map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeForkPolicy(value: SubagentForkPolicy | undefined): SubagentForkPolicy {
  return value === "task-only" || value === "full" || value === "summary" ? value : "summary";
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}
