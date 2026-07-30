import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentEvent, AgentMessage, ProviderStreamEvent } from '@crish/shared-types';
import type { AgentProvider, AgentProviderRequest } from './core/runtime-options';
import type { IAgentRuntime } from "./core/IAgentRuntime";

export type ScriptedProviderStep =
  | ProviderStreamEvent[]
  | ((request: AgentProviderRequest, callIndex: number) => ProviderStreamEvent[] | Promise<ProviderStreamEvent[]>);

export type ScriptedProviderExhaustPolicy = "repeat-last" | "empty" | "throw";

export interface ScriptedProviderOptions {
  id?: string | undefined;
  /** Behavior when callIndex exceeds the last step. Default: "repeat-last" (legacy). */
  onExhausted?: ScriptedProviderExhaustPolicy | undefined;
  /** Cap stored request snapshots (0 disables storage). Default: 32. */
  maxStoredRequests?: number | undefined;
}

export interface ScriptedAgentProvider extends AgentProvider {
  /** Number of completed stream() invocations. */
  readonly callCount: number;
  /** Snapshots of provider requests observed so far (bounded). */
  getRequests(): readonly AgentProviderRequest[];
  /** Reset call index and stored requests (does not clear step definitions). */
  reset(): void;
}

/**
 * Build a deterministic provider that walks a step list (or step factories).
 * Returns a ScriptedAgentProvider so tests can inspect callCount / requests.
 */
export function createScriptedProvider(
  steps: ScriptedProviderStep[],
  idOrOptions: string | ScriptedProviderOptions = "scripted"
): ScriptedAgentProvider {
  const options: ScriptedProviderOptions =
    typeof idOrOptions === "string" ? { id: idOrOptions } : (idOrOptions ?? {});
  const id = options.id ?? "scripted";
  const onExhausted: ScriptedProviderExhaustPolicy = options.onExhausted ?? "repeat-last";
  const maxStoredRequests = Math.max(0, Math.floor(options.maxStoredRequests ?? 32));

  let callIndex = 0;
  const storedRequests: AgentProviderRequest[] = [];

  return {
    id,
    get callCount() {
      return callIndex;
    },
    getRequests() {
      return storedRequests;
    },
    reset() {
      callIndex = 0;
      storedRequests.length = 0;
    },
    async *stream(request) {
      if (maxStoredRequests > 0) {
        storedRequests.push(request);
        while (storedRequests.length > maxStoredRequests) {
          storedRequests.shift();
        }
      }

      const currentIndex = callIndex;
      callIndex += 1;

      let step: ScriptedProviderStep | undefined;
      if (steps.length === 0) {
        step = undefined;
      } else if (currentIndex < steps.length) {
        step = steps[currentIndex];
      } else if (onExhausted === "repeat-last") {
        step = steps[steps.length - 1];
      } else if (onExhausted === "empty") {
        step = [];
      } else {
        throw new Error(
          `Scripted provider "${id}" exhausted after ${steps.length} step(s); callIndex=${currentIndex}`
        );
      }

      const events = typeof step === "function" ? await step(request, currentIndex) : step;
      for (const event of events ?? []) {
        yield event;
      }
    }
  };
}

/** Convenience: one stop-terminated text reply per string. */
export function createScriptedTextProvider(
  replies: string[],
  idOrOptions: string | ScriptedProviderOptions = "scripted-text"
): ScriptedAgentProvider {
  return createScriptedProvider(
    replies.map((text) => [{ type: "text-delta" as const, text }, { type: "stop" as const, reason: "stop" as const }]),
    idOrOptions
  );
}

export interface RuntimeProbeReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  firstEventMs: RuntimeProbeFirstEventTimings;
  eventCount: number;
  messageCount: number;
  toolCallCount: number;
  toolBatchCount: number;
  approvalCount: number;
  /** Count of provider-diagnostic request-start events (== provider turns). */
  providerCallCount: number;
  maxEventGapMs: number;
  eventsByType: Record<string, number>;
  toolCallsByName: Record<string, number>;
  errors: string[];
  /** Set when the run ended with agent-end reason "aborted". */
  abortReason?: string | undefined;
}

export interface RuntimeProbeFirstEventTimings {
  assistantDelta?: number | undefined;
  textDelta?: number | undefined;
  thoughtDelta?: number | undefined;
  toolCallDelta?: number | undefined;
  providerRequest?: number | undefined;
  providerResponse?: number | undefined;
  providerFirstByte?: number | undefined;
  toolStart?: number | undefined;
  toolEnd?: number | undefined;
}

export interface RuntimeProbeResult {
  messages: AgentMessage[];
  events: AgentEvent[];
  report: RuntimeProbeReport;
}

export interface RuntimeProbeOptions {
  maxStoredEvents?: number;
  /** Cap collected error strings (default unlimited). Oldest kept when exceeded. */
  maxErrors?: number;
  onEvent?(event: AgentEvent, report: RuntimeProbeReport): void | Promise<void>;
}

export interface RuntimeStage {
  name: string;
  prompt: string | AgentMessage;
  maxAttempts?: number | undefined;
  retryPrompt?: string | AgentMessage | undefined;
  resetContextOnRetry?: boolean | undefined;
  fallback?: RuntimeStageFallback | undefined;
  requiredFiles?: string[] | undefined;
  requiredToolCalls?: string[] | undefined;
  requiredToolCallCounts?: Record<string, number> | undefined;
  forbiddenToolCalls?: string[] | undefined;
  requiredFileIncludes?: RuntimeStageFileIncludeRequirement[] | undefined;
  /** Substrings that must appear in assistant message text (joined). */
  requiredAssistantIncludes?: string[] | undefined;
  stopWhenRequirementsMet?: boolean | undefined;
}

export interface RuntimeStageFallbackInput {
  stage: RuntimeStage;
  index: number;
  attemptErrors: string[];
  workspaceRoot?: string | undefined;
}

export type RuntimeStageFallback = (input: RuntimeStageFallbackInput) => void | Promise<void>;

export interface RuntimeStageFileIncludeRequirement {
  file: string;
  text: string;
}

export interface RuntimeStageRequirementResult {
  kind: "file" | "file-content" | "tool" | "assistant";
  target: string;
  passed: boolean;
  reason?: string | undefined;
}

export interface RuntimeStageResult {
  index: number;
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attemptCount?: number;
  attemptErrors?: string[];
  report: RuntimeProbeReport;
  requirements: RuntimeStageRequirementResult[];
  fatalError?: string;
  fallbackApplied?: boolean;
  fallbackError?: string;
}

export interface RuntimeStageSuiteResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stageCount: number;
  completedStageCount: number;
  stoppedAtStage?: string;
  stages: RuntimeStageResult[];
  aggregateEventsByType: Record<string, number>;
  aggregateToolCallsByName: Record<string, number>;
  errors: string[];
}

export interface RuntimeStageSuiteOptions {
  stages: RuntimeStage[];
  workspaceRoot?: string;
  maxContextMessages?: number;
  stopOnRequirementFailure?: boolean;
  probe?: RuntimeProbeOptions;
  createRuntime(input: { stage: RuntimeStage; index: number; attempt: number; initialMessages: AgentMessage[] }): IAgentRuntime | Promise<IAgentRuntime>;
  onStageStart?(stage: RuntimeStage, index: number): void | Promise<void>;
  onStageComplete?(result: RuntimeStageResult, suite: RuntimeStageSuiteResult): void | Promise<void>;
}

export async function runRuntimeWithProbe(
  runtime: IAgentRuntime,
  input: string | AgentMessage,
  options: RuntimeProbeOptions = {}
): Promise<RuntimeProbeResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const events: AgentEvent[] = [];
  const eventsByType: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const errors: string[] = [];
  const firstEventMs: RuntimeProbeFirstEventTimings = {};
  let maxEventGapMs = 0;
  let lastEventAtMs = startedAtMs;
  let messages: AgentMessage[] = [];
  let abortReason: string | undefined;
  const maxErrors = options.maxErrors !== undefined ? Math.max(0, Math.floor(options.maxErrors)) : undefined;

  const report: RuntimeProbeReport = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    firstEventMs,
    eventCount: 0,
    messageCount: 0,
    toolCallCount: 0,
    toolBatchCount: 0,
    approvalCount: 0,
    providerCallCount: 0,
    maxEventGapMs: 0,
    eventsByType,
    toolCallsByName,
    errors
  };

  const pushError = (message: string) => {
    if (maxErrors === 0) return;
    if (maxErrors !== undefined && errors.length >= maxErrors) return;
    errors.push(message);
  };

  const iterator = runtime.run(input);
  while (true) {
    const next = await iterator.next();
    const now = Date.now();
    maxEventGapMs = Math.max(maxEventGapMs, now - lastEventAtMs);
    lastEventAtMs = now;

    if (next.done) {
      messages = next.value;
      break;
    }

    const event = next.value;
    if (options.maxStoredEvents === undefined || events.length < options.maxStoredEvents) {
      events.push(event);
    }
    captureFirstEventMs(event, now - startedAtMs, firstEventMs);
    eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;
    if (event.type === "tool-start") {
      toolCallsByName[event.call.toolName] = (toolCallsByName[event.call.toolName] ?? 0) + 1;
    }
    if (event.type === "provider-diagnostic" && event.diagnostic.phase === "request-start") {
      report.providerCallCount += 1;
    }
    if (event.type === "agent-end") {
      if (event.reason === "aborted") {
        abortReason = event.error ?? "aborted";
        report.abortReason = abortReason;
      } else if (event.error) {
        pushError(event.error);
      }
    }
    if (event.type === "runtime-error") pushError(event.error);
    if (event.type === "tool-end" && event.result.isError) {
      pushError(event.result.output.text ?? event.result.toolName);
    }
    updateReport(report, {
      finishedAtMs: now,
      startedAtMs,
      eventCount: (report.eventCount += 1),
      messageCount: messages.length,
      firstEventMs,
      maxEventGapMs,
      eventsByType,
      toolCallsByName,
      errors,
      abortReason,
      providerCallCount: report.providerCallCount
    });
    await options.onEvent?.(event, report);
  }

  const finishedAtMs = Date.now();
  updateReport(report, {
    finishedAtMs,
    startedAtMs,
    eventCount: report.eventCount,
    messageCount: messages.length,
    firstEventMs,
    maxEventGapMs,
    eventsByType,
    toolCallsByName,
    errors,
    abortReason,
    providerCallCount: report.providerCallCount
  });
  return {
    messages,
    events,
    report
  };
}

export async function runRuntimeStageSuite(options: RuntimeStageSuiteOptions): Promise<RuntimeStageSuiteResult> {
  const startedAtMs = Date.now();
  const suite: RuntimeStageSuiteResult = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    stageCount: options.stages.length,
    completedStageCount: 0,
    stages: [],
    aggregateEventsByType: {},
    aggregateToolCallsByName: {},
    errors: []
  };
  let initialMessages: AgentMessage[] = [];
  const stopOnRequirementFailure = options.stopOnRequirementFailure ?? true;

  for (let index = 0; index < options.stages.length; index++) {
    const stage = options.stages[index]!;
    await options.onStageStart?.(stage, index);
    const stageStartedAtMs = Date.now();
    const stageStartedAt = new Date(stageStartedAtMs).toISOString();
    let result: RuntimeStageResult | undefined;
    const maxAttempts = Math.max(1, Math.floor(stage.maxAttempts ?? 1));
    const attemptErrors: string[] = [];
    let lastMessages: AgentMessage[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStartedAtMs = Date.now();
      const attemptStartedAt = new Date(attemptStartedAtMs).toISOString();
      try {
        const attemptMessages = attempt > 1 && stage.resetContextOnRetry ? [] : initialMessages;
        const prompt = attempt === 1 ? stage.prompt : stage.retryPrompt ?? retryPromptForFailedStage(stage, attemptErrors);
        const runtime = await options.createRuntime({ stage, index, attempt, initialMessages: attemptMessages });
        const probe = await runRuntimeWithProbe(runtime, prompt, {
          ...options.probe,
          async onEvent(event, report) {
            await options.probe?.onEvent?.(event, report);
            if (!stage.stopWhenRequirementsMet || !shouldCheckRequirementsDuringRun(event)) return;
            // Live stop only considers requirements evaluable without final messages
            // (tools/files). Assistant-text requirements are checked after the run.
            const liveRequirements = await evaluateRuntimeStageRequirements(
              {
                ...stage,
                requiredAssistantIncludes: undefined
              },
              report,
              { workspaceRoot: options.workspaceRoot }
            );
            if (liveRequirements.length > 0 && liveRequirements.every((requirement) => requirement.passed)) {
              runtime.abort("stage requirements met");
            }
          }
        });
        lastMessages = probe.messages;
        const requirements = await evaluateRuntimeStageRequirements(stage, probe.report, {
          workspaceRoot: options.workspaceRoot,
          messages: probe.messages
        });
        result = {
          index,
          name: stage.name,
          startedAt: stageStartedAt,
          finishedAt: probe.report.finishedAt,
          durationMs: Date.now() - stageStartedAtMs,
          attemptCount: attempt,
          attemptErrors: [...attemptErrors],
          report: probe.report,
          requirements
        };
        const failedRequirements = requirements.filter((requirement) => !requirement.passed);
        if (failedRequirements.length === 0) {
          initialMessages = limitContextMessages(probe.messages, options.maxContextMessages ?? 40);
          break;
        }
        attemptErrors.push(...failedRequirements.map((requirement) => `${requirement.kind} ${requirement.target} failed: ${requirement.reason}`));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        result = {
          index,
          name: stage.name,
          startedAt: stageStartedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - stageStartedAtMs,
          attemptCount: attempt,
          attemptErrors: [...attemptErrors],
          report: emptyProbeReport(attemptStartedAt),
          requirements: [],
          fatalError: message
        };
        attemptErrors.push(message);
      }
    }

    result ??= {
      index,
      name: stage.name,
      startedAt: stageStartedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - stageStartedAtMs,
      attemptCount: 0,
      attemptErrors,
      report: emptyProbeReport(stageStartedAt),
      requirements: [],
      fatalError: "stage did not run"
    };

    let failedRequirements = result.requirements.filter((requirement) => !requirement.passed);
    if (!result.fatalError && failedRequirements.length > 0 && stage.fallback) {
      try {
        await stage.fallback({
          stage,
          index,
          attemptErrors: [...attemptErrors],
          workspaceRoot: options.workspaceRoot
        });
        result.requirements = await evaluateRuntimeStageRequirements(stage, result.report, {
          workspaceRoot: options.workspaceRoot,
          messages: lastMessages
        });
        result.finishedAt = new Date().toISOString();
        result.durationMs = Date.now() - stageStartedAtMs;
        result.fallbackApplied = true;
        failedRequirements = result.requirements.filter((requirement) => !requirement.passed);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        result.fallbackApplied = true;
        result.fallbackError = message;
        attemptErrors.push(`fallback failed: ${message}`);
      }
    }

    if (attemptErrors.length > 0) {
      result.attemptErrors = attemptErrors;
    }

    suite.stages.push(result);
    mergeCounts(suite.aggregateEventsByType, result.report.eventsByType);
    mergeCounts(suite.aggregateToolCallsByName, result.report.toolCallsByName);
    suite.errors.push(...result.report.errors.map((error) => `${stage.name}: ${error}`));
    if (result.fatalError) suite.errors.push(`${stage.name}: ${result.fatalError}`);
    failedRequirements = result.requirements.filter((requirement) => !requirement.passed);
    suite.errors.push(...failedRequirements.map((requirement) => `${stage.name}: ${requirement.kind} ${requirement.target} failed: ${requirement.reason}`));
    suite.completedStageCount = suite.stages.length;
    updateSuiteTiming(suite, startedAtMs);
    await options.onStageComplete?.(result, suite);

    if (result.fatalError || result.fallbackError || (stopOnRequirementFailure && failedRequirements.length > 0)) {
      suite.stoppedAtStage = stage.name;
      break;
    }
  }

  updateSuiteTiming(suite, startedAtMs);
  return suite;
}

/** True when every evaluated requirement passed (empty list counts as passed). */
export function stageRequirementsPassed(requirements: RuntimeStageRequirementResult[]): boolean {
  return requirements.every((requirement) => requirement.passed);
}

/** Compact one-line probe summary for assertions and smoke logs. */
export function summarizeRuntimeProbeReport(report: RuntimeProbeReport): string {
  const tools =
    Object.keys(report.toolCallsByName).length === 0
      ? "none"
      : Object.entries(report.toolCallsByName)
          .map(([name, count]) => `${name}×${count}`)
          .join(",");
  const errorPart = report.errors.length > 0 ? ` errors=${report.errors.length}` : "";
  const abortPart = report.abortReason ? ` abort=${JSON.stringify(report.abortReason)}` : "";
  return [
    `events=${report.eventCount}`,
    `tools=${tools}`,
    `batches=${report.toolBatchCount}`,
    `approvals=${report.approvalCount}`,
    `providerCalls=${report.providerCallCount}`,
    `durationMs=${report.durationMs}`,
    `gapMs=${report.maxEventGapMs}`
  ].join(" ") + errorPart + abortPart;
}

/** Multi-line suite summary for debugging long-run harnesses. */
export function formatRuntimeStageSuiteResult(suite: RuntimeStageSuiteResult): string {
  const lines = [
    `stages=${suite.completedStageCount}/${suite.stageCount} durationMs=${suite.durationMs}`,
    suite.stoppedAtStage ? `stoppedAt=${suite.stoppedAtStage}` : "stoppedAt=",
    `errors=${suite.errors.length}`
  ];
  for (const stage of suite.stages) {
    const failed = stage.requirements.filter((requirement) => !requirement.passed).length;
    const status = stage.fatalError
      ? `fatal:${stage.fatalError}`
      : failed > 0
        ? `failedRequirements=${failed}`
        : stage.fallbackApplied
          ? "ok(fallback)"
          : "ok";
    lines.push(
      `- [${stage.index}] ${stage.name} attempts=${stage.attemptCount ?? 0} ${status} ${summarizeRuntimeProbeReport(stage.report)}`
    );
  }
  if (suite.errors.length > 0) {
    lines.push("errorDetails:");
    for (const error of suite.errors.slice(0, 20)) {
      lines.push(`  • ${error}`);
    }
    if (suite.errors.length > 20) {
      lines.push(`  … +${suite.errors.length - 20} more`);
    }
  }
  return lines.join("\n");
}

export interface EvaluateStageRequirementsOptions {
  workspaceRoot?: string | undefined;
  messages?: AgentMessage[] | undefined;
}

/**
 * Evaluate stage success criteria against a probe report (and optional messages / workspace).
 * Public so unit tests and harnesses can assert requirements without running a full suite.
 */
export async function evaluateRuntimeStageRequirements(
  stage: RuntimeStage,
  report: RuntimeProbeReport,
  options: EvaluateStageRequirementsOptions = {}
): Promise<RuntimeStageRequirementResult[]> {
  const workspaceRoot = options.workspaceRoot;
  const requirements: RuntimeStageRequirementResult[] = [];

  for (const toolName of stage.requiredToolCalls ?? []) {
    const count = report.toolCallsByName[toolName] ?? 0;
    requirements.push({
      kind: "tool",
      target: toolName,
      passed: count > 0,
      reason: count > 0 ? undefined : "tool was not called"
    });
  }

  for (const [toolName, minimum] of Object.entries(stage.requiredToolCallCounts ?? {})) {
    const count = report.toolCallsByName[toolName] ?? 0;
    requirements.push({
      kind: "tool",
      target: `${toolName}>=${minimum}`,
      passed: count >= minimum,
      reason: count >= minimum ? undefined : `tool was called ${count} time(s)`
    });
  }

  for (const toolName of stage.forbiddenToolCalls ?? []) {
    const count = report.toolCallsByName[toolName] ?? 0;
    requirements.push({
      kind: "tool",
      target: `!${toolName}`,
      passed: count === 0,
      reason: count === 0 ? undefined : `tool was called ${count} time(s)`
    });
  }

  for (const file of stage.requiredFiles ?? []) {
    if (!workspaceRoot) {
      requirements.push({ kind: "file", target: file, passed: false, reason: "workspaceRoot is required for file checks" });
      continue;
    }
    try {
      const filePath = resolveWorkspacePath(workspaceRoot, file);
      const fileStat = await stat(filePath).catch(() => null);
      requirements.push({
        kind: "file",
        target: file,
        passed: !!fileStat?.isFile(),
        reason: fileStat?.isFile() ? undefined : "file does not exist"
      });
    } catch (cause) {
      requirements.push({
        kind: "file",
        target: file,
        passed: false,
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  for (const requirement of stage.requiredFileIncludes ?? []) {
    if (!workspaceRoot) {
      requirements.push({ kind: "file-content", target: requirement.file, passed: false, reason: "workspaceRoot is required for file checks" });
      continue;
    }
    try {
      const filePath = resolveWorkspacePath(workspaceRoot, requirement.file);
      const content = await readFile(filePath, "utf8").catch(() => null);
      const found = typeof content === "string" && content.includes(requirement.text);
      requirements.push({
        kind: "file-content",
        target: `${requirement.file} includes ${JSON.stringify(requirement.text)}`,
        passed: found,
        reason: found
          ? undefined
          : typeof content === "string"
            ? "required text was not found"
            : "file could not be read"
      });
    } catch (cause) {
      requirements.push({
        kind: "file-content",
        target: `${requirement.file} includes ${JSON.stringify(requirement.text)}`,
        passed: false,
        reason: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  for (const text of stage.requiredAssistantIncludes ?? []) {
    const assistantText = collectAssistantText(options.messages ?? []);
    const found = assistantText.includes(text);
    requirements.push({
      kind: "assistant",
      target: `includes ${JSON.stringify(text)}`,
      passed: found,
      reason: found ? undefined : "required text was not found in assistant messages"
    });
  }

  return requirements;
}

function shouldCheckRequirementsDuringRun(event: AgentEvent): boolean {
  return event.type === "tool-end" || event.type === "message-end";
}

function retryPromptForFailedStage(stage: RuntimeStage, attemptErrors: string[]): string {
  return [
    `Retry stage: ${stage.name}`,
    "",
    "The previous attempt failed these requirements:",
    ...attemptErrors.slice(-8).map((error) => `- ${error}`),
    "",
    "Retry with the shortest possible path. If a file is required, call write_file immediately before any prose.",
    "",
    typeof stage.prompt === "string" ? stage.prompt : "Continue the same stage and satisfy all requirements."
  ].join("\n");
}

function updateReport(
  report: RuntimeProbeReport,
  input: {
    finishedAtMs: number;
    startedAtMs: number;
    eventCount: number;
    messageCount: number;
    firstEventMs: RuntimeProbeFirstEventTimings;
    maxEventGapMs: number;
    eventsByType: Record<string, number>;
    toolCallsByName: Record<string, number>;
    errors: string[];
    abortReason?: string | undefined;
    providerCallCount: number;
  }
): void {
  report.finishedAt = new Date(input.finishedAtMs).toISOString();
  report.durationMs = input.finishedAtMs - input.startedAtMs;
  report.firstEventMs = input.firstEventMs;
  report.eventCount = input.eventCount;
  report.messageCount = input.messageCount;
  report.toolCallCount = input.eventsByType["tool-start"] ?? 0;
  report.toolBatchCount = input.eventsByType["tool-batch-start"] ?? 0;
  report.approvalCount = input.eventsByType["approval-requested"] ?? 0;
  report.providerCallCount = input.providerCallCount;
  report.maxEventGapMs = input.maxEventGapMs;
  report.eventsByType = input.eventsByType;
  report.toolCallsByName = input.toolCallsByName;
  report.errors = input.errors;
  if (input.abortReason !== undefined) {
    report.abortReason = input.abortReason;
  }
}

function captureFirstEventMs(event: AgentEvent, elapsedMs: number, timings: RuntimeProbeFirstEventTimings): void {
  if (event.type === "message-delta") {
    timings.assistantDelta ??= elapsedMs;
    if (event.block.type === "text") timings.textDelta ??= elapsedMs;
    if (event.block.type === "thought") timings.thoughtDelta ??= elapsedMs;
    if (event.block.type === "tool-call") timings.toolCallDelta ??= elapsedMs;
    return;
  }

  if (event.type === "tool-start") {
    timings.toolStart ??= elapsedMs;
    // Tool calls are delivered as discrete tool-call / tool-start events (not always
    // message-delta tool-call blocks). Probe telemetry treats first tool-start as
    // the toolCallDelta timing when no streamed tool-call delta was observed.
    timings.toolCallDelta ??= elapsedMs;
    return;
  }

  if (event.type === "provider-diagnostic") {
    if (event.diagnostic.phase === "request-start") timings.providerRequest ??= elapsedMs;
    if (event.diagnostic.phase === "response-start") timings.providerResponse ??= elapsedMs;
    if (event.diagnostic.phase === "sse-first-byte") timings.providerFirstByte ??= elapsedMs;
    return;
  }

  if (event.type === "tool-end") {
    timings.toolEnd ??= elapsedMs;
  }
}

function collectAssistantText(messages: AgentMessage[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

function limitContextMessages(messages: AgentMessage[], maxMessages: number): AgentMessage[] {
  if (maxMessages <= 0) return [];
  return messages.slice(-maxMessages);
}

function emptyProbeReport(startedAt: string): RuntimeProbeReport {
  return {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    firstEventMs: {},
    eventCount: 0,
    messageCount: 0,
    toolCallCount: 0,
    toolBatchCount: 0,
    approvalCount: 0,
    providerCallCount: 0,
    maxEventGapMs: 0,
    eventsByType: {},
    toolCallsByName: {},
    errors: []
  };
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function updateSuiteTiming(suite: RuntimeStageSuiteResult, startedAtMs: number): void {
  const now = Date.now();
  suite.finishedAt = new Date(now).toISOString();
  suite.durationMs = now - startedAtMs;
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, inputPath);
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return candidate;
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Re-export testing subdirectory utilities via the barrel
export { FauxAgentProvider } from "./testing/faux-provider";
export {
  FauxProviderCallGateway,
  ProviderGatewayPlanNotFoundError,
  ProviderGatewayProviderNotFoundError,
} from "./testing/faux-call-gateway";
export type { RoutingDecision, FauxCallGatewayOptions } from "./testing/faux-call-gateway";
export { createMockTool } from "./testing/mock-tool";
export type { MockToolOptions } from "./testing/mock-tool";
export { loadFixture, clearFixtureCache } from "./testing/fixture-loader";
