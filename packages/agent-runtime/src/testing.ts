import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentEvent, AgentMessage, AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "./types";
import type { AgentRuntime } from "./runtime";

export type ScriptedProviderStep =
  | ProviderStreamEvent[]
  | ((request: AgentProviderRequest, callIndex: number) => ProviderStreamEvent[] | Promise<ProviderStreamEvent[]>);

export function createScriptedProvider(steps: ScriptedProviderStep[], id = "scripted"): AgentProvider {
  let callIndex = 0;
  return {
    id,
    async *stream(request) {
      const step = steps[Math.min(callIndex, steps.length - 1)];
      const currentIndex = callIndex;
      callIndex += 1;
      const events = typeof step === "function" ? await step(request, currentIndex) : step;
      for (const event of events ?? []) {
        yield event;
      }
    }
  };
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
  maxEventGapMs: number;
  eventsByType: Record<string, number>;
  toolCallsByName: Record<string, number>;
  errors: string[];
}

export interface RuntimeProbeFirstEventTimings {
  assistantDelta?: number;
  textDelta?: number;
  thoughtDelta?: number;
  toolCallDelta?: number;
  providerRequest?: number;
  providerResponse?: number;
  providerFirstByte?: number;
  toolStart?: number;
  toolEnd?: number;
}

export interface RuntimeProbeResult {
  messages: AgentMessage[];
  events: AgentEvent[];
  report: RuntimeProbeReport;
}

export interface RuntimeProbeOptions {
  maxStoredEvents?: number;
  onEvent?(event: AgentEvent, report: RuntimeProbeReport): void | Promise<void>;
}

export interface RuntimeStage {
  name: string;
  prompt: string | AgentMessage;
  maxAttempts?: number;
  retryPrompt?: string | AgentMessage;
  resetContextOnRetry?: boolean;
  fallback?: RuntimeStageFallback;
  requiredFiles?: string[];
  requiredToolCalls?: string[];
  requiredToolCallCounts?: Record<string, number>;
  forbiddenToolCalls?: string[];
  requiredFileIncludes?: RuntimeStageFileIncludeRequirement[];
  stopWhenRequirementsMet?: boolean;
}

export interface RuntimeStageFallbackInput {
  stage: RuntimeStage;
  index: number;
  attemptErrors: string[];
  workspaceRoot?: string;
}

export type RuntimeStageFallback = (input: RuntimeStageFallbackInput) => void | Promise<void>;

export interface RuntimeStageFileIncludeRequirement {
  file: string;
  text: string;
}

export interface RuntimeStageRequirementResult {
  kind: "file" | "file-content" | "tool";
  target: string;
  passed: boolean;
  reason?: string;
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
  createRuntime(input: { stage: RuntimeStage; index: number; attempt: number; initialMessages: AgentMessage[] }): AgentRuntime | Promise<AgentRuntime>;
  onStageStart?(stage: RuntimeStage, index: number): void | Promise<void>;
  onStageComplete?(result: RuntimeStageResult, suite: RuntimeStageSuiteResult): void | Promise<void>;
}

export async function runRuntimeWithProbe(
  runtime: AgentRuntime,
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
    maxEventGapMs: 0,
    eventsByType,
    toolCallsByName,
    errors
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
    if (event.type === "agent-end" && event.error) errors.push(event.error);
    if (event.type === "runtime-error") errors.push(event.error);
    if (event.type === "tool-end" && event.result.isError) errors.push(event.result.output.text ?? event.result.toolName);
    updateReport(report, {
      finishedAtMs: now,
      startedAtMs,
      eventCount: (report.eventCount += 1),
      messageCount: messages.length,
      firstEventMs,
      maxEventGapMs,
      eventsByType,
      toolCallsByName,
      errors
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
    errors
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
            const liveRequirements = await evaluateStageRequirements(stage, report, options.workspaceRoot);
            if (liveRequirements.length > 0 && liveRequirements.every((requirement) => requirement.passed)) {
              runtime.abort("stage requirements met");
            }
          }
        });
        const requirements = await evaluateStageRequirements(stage, probe.report, options.workspaceRoot);
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
        result.requirements = await evaluateStageRequirements(stage, result.report, options.workspaceRoot);
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
  report.maxEventGapMs = input.maxEventGapMs;
  report.eventsByType = input.eventsByType;
  report.toolCallsByName = input.toolCallsByName;
  report.errors = input.errors;
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

async function evaluateStageRequirements(
  stage: RuntimeStage,
  report: RuntimeProbeReport,
  workspaceRoot: string | undefined
): Promise<RuntimeStageRequirementResult[]> {
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
    const filePath = resolveWorkspacePath(workspaceRoot, file);
    const fileStat = await stat(filePath).catch(() => null);
    requirements.push({
      kind: "file",
      target: file,
      passed: !!fileStat?.isFile(),
      reason: fileStat?.isFile() ? undefined : "file does not exist"
    });
  }

  for (const requirement of stage.requiredFileIncludes ?? []) {
    if (!workspaceRoot) {
      requirements.push({ kind: "file-content", target: requirement.file, passed: false, reason: "workspaceRoot is required for file checks" });
      continue;
    }
    const filePath = resolveWorkspacePath(workspaceRoot, requirement.file);
    const content = await readFile(filePath, "utf8").catch(() => null);
    requirements.push({
      kind: "file-content",
      target: `${requirement.file} includes ${JSON.stringify(requirement.text)}`,
      passed: typeof content === "string" && content.includes(requirement.text),
      reason: typeof content === "string" ? "required text was not found" : "file could not be read"
    });
  }
  return requirements;
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
