import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { AgentRuntime } from "@chat-sync/agent-runtime";
import {
  createBackgroundTaskContinuationDecision,
  finishBackgroundTask,
  recordBackgroundTaskHeartbeat,
  startBackgroundTask
} from "../shared/background-tasks";
import {
  applyUserGoal,
  buildInitialTaskSnapshot,
  createRuntimeCapabilities,
  type WorkbenchContinuationDecision,
  type WorkbenchMode,
  type WorkbenchRunEvent,
  type WorkbenchRuntimeStatus,
  type WorkbenchTaskSnapshot
} from "../shared/workbench-contract";
import { decideContinuation } from "../shared/runtime-bridge";
import { runWorkbenchTask, type WorkbenchRunnerYield } from "./workbench-runner";
import { createWorkbenchRuntime } from "./runtime-factory";
import { runWorkbenchGoal } from "./goal-runner";
import type { WorkbenchRunBudgetDifficulty } from "../shared/workbench-config";
import {
  defaultRunRegistryPath,
  findLatestRun,
  finishRunRecord,
  recordRunEvent,
  readRunRegistry,
  startRunRecord,
  type WorkbenchRunRecord,
  type WorkbenchRunRecordStatus
} from "./run-registry";

export interface CliRunJsonOutput {
  events: WorkbenchRunEvent[];
  snapshot?: WorkbenchTaskSnapshot;
  decision?: WorkbenchContinuationDecision;
}

interface CliEventLogWriter {
  write(value: unknown): Promise<void>;
}

export function createCliStatus(cwd = process.cwd()): WorkbenchRuntimeStatus {
  return {
    ok: true,
    shell: "cli",
    cwd,
    message: "命令行入口已连接",
    capabilities: createRuntimeCapabilities()
  };
}

export function createCliSnapshot(cwd = process.cwd(), prompt?: string): WorkbenchTaskSnapshot {
  const snapshot = buildInitialTaskSnapshot(cwd);
  return prompt?.trim() ? applyUserGoal(snapshot, prompt.trim()) : snapshot;
}

export function printCliStatus(cwd = process.cwd()): void {
  const status = createCliStatus(cwd);
  const snapshot = createCliSnapshot(cwd);
  console.log(JSON.stringify({ status, snapshot }, null, 2));
}

export function printContinuationPrompt(cwd = process.cwd(), prompt?: string): void {
  const snapshot = createCliSnapshot(cwd, prompt);
  const decision = decideContinuation(snapshot);
  console.log(JSON.stringify({ snapshot, decision }, null, 2));
}

export function printBackgroundTaskDemo(cwd = process.cwd(), prompt?: string): void {
  const base = createCliSnapshot(cwd, prompt ?? "检查项目并继续完成剩余任务");
  const started = startBackgroundTask(base, {
    id: "demo-command",
    kind: "command",
    title: "运行长时间检查",
    cwd,
    command: "npm test",
    detail: "命令已经交给后台处理，模型不需要同步等待。"
  });
  const heartbeat = recordBackgroundTaskHeartbeat(started, {
    taskId: "demo-command",
    detail: "命令仍在运行，已经收到一次进度信号。",
    outputPreview: "正在检查中文界面、类型契约和运行时桥接。"
  });
  const finished = finishBackgroundTask(heartbeat, {
    taskId: "demo-command",
    exitCode: 0,
    summary: "检查命令已经完成，可以根据结果继续未完成验收项。",
    outputPreview: "所有关键检查通过。"
  });
  const decision = createBackgroundTaskContinuationDecision(finished, "demo-command");
  console.log(JSON.stringify({ started, heartbeat, finished, decision }, null, 2));
}

export function getRuntimeConstructor(): typeof AgentRuntime {
  return AgentRuntime;
}

function readArg(name: string, argv = process.argv): string | undefined {
  const prefix = `${name}=`;
  const value = argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

async function readPromptArg(argv = process.argv, cwd = process.cwd()): Promise<string | undefined> {
  const prompt = readArg("--prompt", argv);
  if (prompt !== undefined) return prompt;
  const promptFile = readPathArg("--prompt-file", argv, cwd);
  return promptFile ? (await readFile(promptFile, "utf8")) : undefined;
}

function readPathArg(name: string, argv = process.argv, cwd = process.cwd()): string | undefined {
  const value = readArg(name, argv);
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function runCliTask(cwd: string, prompt: string, argv = process.argv): Promise<void> {
  const resume = await createCliResumeContext(argv, cwd);
  const runtime = await createCliRuntime(cwd, argv, resume);
  const runRecord = await createCliRunRecord("run", cwd, prompt, argv, runtime, resume);
  const task = runWorkbenchTask({
    runtime,
    cwd,
    prompt,
    mode: modeArg("--mode", argv) ?? "execute",
    runBudget: runBudgetArg(argv),
    initialSnapshot: resume?.snapshot
  });
  const eventLog = await createCliEventLogWriter(argv, cwd);
  let finalSnapshot: WorkbenchTaskSnapshot | undefined;
  for await (const item of task) {
    finalSnapshot = item.snapshot;
    const event = withRunId(item.event, runRecord.record.id);
    await recordRunEvent(runRecord.path, runRecord.record.id, event, finalSnapshot);
    await printJsonLine(event, eventLog);
  }
  if (finalSnapshot) {
    await printJsonLine({ type: "snapshot", snapshot: finalSnapshot }, eventLog);
    await printJsonLine({ type: "continuation", decision: decideContinuation(finalSnapshot) }, eventLog);
  }
  await finishCliRunRecord(runRecord, statusFromSnapshot(finalSnapshot));
}

async function runCliTaskJson(cwd: string, prompt: string, argv = process.argv): Promise<void> {
  const resume = await createCliResumeContext(argv, cwd);
  const runtime = await createCliRuntime(cwd, argv, resume);
  const runRecord = await createCliRunRecord("run-json", cwd, prompt, argv, runtime, resume);
  const task = runWorkbenchTask({
    runtime,
    cwd,
    prompt,
    mode: modeArg("--mode", argv) ?? "execute",
    runBudget: runBudgetArg(argv),
    initialSnapshot: resume?.snapshot
  });
  const output = await collectCliRunJsonOutput(wrapRunEvents(task, runRecord));
  await finishCliRunRecord(runRecord, statusFromSnapshot(output.snapshot), output.snapshot);
  console.log(JSON.stringify(output, null, 2));
}

async function runCliGoal(cwd: string, prompt: string, argv = process.argv): Promise<void> {
  const resume = await createCliResumeContext(argv, cwd);
  const runtime = await createCliRuntime(cwd, argv, resume);
  const runRecord = await createCliRunRecord("goal-run", cwd, prompt, argv, runtime, resume);
  const initialSnapshot = await readInitialSnapshotArg(argv, cwd, resume);
  const eventLog = await createCliEventLogWriter(argv, cwd);
  const result = await runWorkbenchGoal({
    runtime,
    cwd,
    prompt,
    initialSnapshot,
    visibleGoal: readArg("--visible-goal", argv),
    maxRounds: numberArg("--max-rounds", argv),
    maxStalledRounds: numberArg("--max-stalled-rounds", argv),
    backgroundDrainTimeoutMs: numberArg("--background-drain-timeout-ms", argv),
    providerRateLimitBackoffMs: numberArg("--provider-rate-limit-backoff-ms", argv),
    runBudget: runBudgetArg(argv),
    async onRoundStart(round) {
      await printJsonLine({ type: "goal-round-start", index: round.index }, eventLog);
    },
    async onYield({ item }) {
      const event = withRunId(item.event, runRecord.record.id);
      await recordRunEvent(runRecord.path, runRecord.record.id, event, item.snapshot);
      await printJsonLine(event, eventLog);
    },
    async onRoundEnd(round) {
      if (round.snapshot) {
        await printJsonLine({ type: "snapshot", snapshot: round.snapshot }, eventLog);
      }
      if (round.decision) {
        await printJsonLine({ type: "continuation", decision: round.decision }, eventLog);
      }
      await printJsonLine({ type: "goal-round-end", index: round.index }, eventLog);
    }
  });
  await finishCliRunRecord(runRecord, statusFromGoalStoppedReason(result.stoppedReason), result.snapshot, result.stoppedReason);
  await printJsonLine({ type: "goal-end", stoppedReason: result.stoppedReason, decision: result.decision, snapshot: result.snapshot }, eventLog);
}

async function runCliGoalJson(cwd: string, prompt: string, argv = process.argv): Promise<void> {
  console.log(JSON.stringify(await createCliGoalResult(cwd, prompt, argv), null, 2));
}

async function createCliRuntime(cwd: string, argv = process.argv, resume?: CliResumeContext) {
  return createWorkbenchRuntime({
    cwd,
    configPath: readPathArg("--config", argv, cwd) ?? resume?.record.configPath,
    sessionPath: readPathArg("--session", argv, cwd) ?? resume?.record.sessionPath,
    apiKey: readArg("--api-key", argv),
    resumeSession: argv.includes("--resume") || !!resume?.record.sessionPath,
    maxTurns: numberArg("--max-turns", argv)
  });
}

async function createCliTaskIterable(cwd: string, prompt: string, argv = process.argv): Promise<AsyncIterable<WorkbenchRunnerYield>> {
  const runtime = await createCliRuntime(cwd, argv);
  return runWorkbenchTask({
    runtime,
    cwd,
    prompt,
    mode: modeArg("--mode", argv) ?? "execute",
    runBudget: runBudgetArg(argv)
  });
}

async function createCliGoalResult(cwd: string, prompt: string, argv = process.argv) {
  const resume = await createCliResumeContext(argv, cwd);
  const runtime = await createCliRuntime(cwd, argv, resume);
  const runRecord = await createCliRunRecord("goal-json", cwd, prompt, argv, runtime, resume);
  const initialSnapshot = await readInitialSnapshotArg(argv, cwd, resume);
  const result = await runWorkbenchGoal({
    runtime,
    cwd,
    prompt,
    initialSnapshot,
    visibleGoal: readArg("--visible-goal", argv),
    maxRounds: numberArg("--max-rounds", argv),
    maxStalledRounds: numberArg("--max-stalled-rounds", argv),
    backgroundDrainTimeoutMs: numberArg("--background-drain-timeout-ms", argv),
    providerRateLimitBackoffMs: numberArg("--provider-rate-limit-backoff-ms", argv),
    runBudget: runBudgetArg(argv),
    async onYield({ item }) {
      const event = withRunId(item.event, runRecord.record.id);
      await recordRunEvent(runRecord.path, runRecord.record.id, event, item.snapshot);
      item.event = event;
    }
  });
  await finishCliRunRecord(runRecord, statusFromGoalStoppedReason(result.stoppedReason), result.snapshot, result.stoppedReason);
  return result;
}

function runBudgetArg(argv = process.argv) {
  return {
    difficulty: difficultyArg("--budget-difficulty", argv),
    maxTotalTokens: numberArg("--run-token-budget", argv)
  };
}

async function createCliEventLogWriter(argv = process.argv, cwd = process.cwd()): Promise<CliEventLogWriter | undefined> {
  const eventLogPath = readPathArg("--event-log", argv, cwd);
  if (!eventLogPath) return undefined;
  await mkdir(dirname(eventLogPath), { recursive: true });
  await writeFile(eventLogPath, "", "utf8");
  return {
    async write(value) {
      await appendFile(eventLogPath, `${JSON.stringify(value)}\n`, "utf8");
    }
  };
}

async function* wrapRunEvents(items: AsyncIterable<WorkbenchRunnerYield>, runRecord: CliRunRecord): AsyncGenerator<WorkbenchRunnerYield> {
  for await (const item of items) {
    const event = withRunId(item.event, runRecord.record.id);
    await recordRunEvent(runRecord.path, runRecord.record.id, event, item.snapshot);
    yield {
      ...item,
      event
    };
  }
}

interface CliRunRecord {
  path: string;
  record: WorkbenchRunRecord;
}

interface CliResumeContext {
  registryPath: string;
  record: WorkbenchRunRecord;
  snapshot?: WorkbenchTaskSnapshot;
}

async function createCliRunRecord(
  command: string,
  cwd: string,
  prompt: string,
  argv: string[],
  runtime: Awaited<ReturnType<typeof createCliRuntime>>,
  resume?: CliResumeContext
): Promise<CliRunRecord> {
  const path = resume?.registryPath ?? readPathArg("--run-registry", argv, cwd) ?? defaultRunRegistryPath(cwd);
  const record = await startRunRecord(path, {
    id: readArg("--run-id", argv),
    branchId: readArg("--branch-id", argv),
    parentRunId: readArg("--parent-run-id", argv) ?? resume?.record.id,
    parentBranchId: readArg("--parent-branch-id", argv) ?? resume?.record.branchId,
    command,
    cwd,
    providerId: runtime.settings.provider.id,
    modelId: runtime.settings.provider.model.id,
    sessionPath: runtime.sessionPath,
    eventLogPath: readPathArg("--event-log", argv, cwd),
    promptFile: readPathArg("--prompt-file", argv, cwd),
    configPath: readPathArg("--config", argv, cwd) ?? resume?.record.configPath,
    outputRoot: readPathArg("--output-root", argv, cwd) ?? resume?.record.outputRoot,
    userGoal: prompt
  });
  return { path, record };
}

async function finishCliRunRecord(
  runRecord: CliRunRecord,
  status: WorkbenchRunRecordStatus,
  snapshot?: WorkbenchTaskSnapshot,
  stoppedReason?: string
): Promise<void> {
  await finishRunRecord(runRecord.path, runRecord.record.id, status, snapshot, stoppedReason);
}

function withRunId(event: WorkbenchRunEvent, runId: string): WorkbenchRunEvent {
  return event.runId ? event : { ...event, runId };
}

function statusFromSnapshot(snapshot?: WorkbenchTaskSnapshot): WorkbenchRunRecordStatus {
  if (!snapshot) return "paused";
  if (snapshot.state === "done") return "complete";
  if (snapshot.state === "blocked") return "blocked";
  if (snapshot.state === "waiting") return "paused";
  return "paused";
}

function statusFromGoalStoppedReason(reason: string): WorkbenchRunRecordStatus {
  if (reason === "complete") return "complete";
  if (reason === "error") return "error";
  if (reason === "stalled") return "stalled";
  if (reason === "max-rounds") return "max-rounds";
  return "paused";
}

async function printJsonLine(value: unknown, eventLog?: CliEventLogWriter): Promise<void> {
  const line = JSON.stringify(value);
  console.log(line);
  await eventLog?.write(value);
}

export async function collectCliRunJsonOutput(items: AsyncIterable<WorkbenchRunnerYield>): Promise<CliRunJsonOutput> {
  const events: WorkbenchRunEvent[] = [];
  let snapshot: WorkbenchTaskSnapshot | undefined;
  for await (const item of items) {
    events.push(item.event);
    snapshot = item.snapshot;
  }
  return {
    events,
    snapshot,
    decision: snapshot ? decideContinuation(snapshot) : undefined
  };
}

async function createCliResumeContext(argv = process.argv, cwd = process.cwd()): Promise<CliResumeContext | undefined> {
  if (!argv.includes("--resume-latest")) return undefined;
  const registryPath = readPathArg("--run-registry", argv, cwd) ?? defaultRunRegistryPath(cwd);
  const registry = await readRunRegistry(registryPath);
  const latest = findLatestRun(registry, { cwd });
  const record = latest ? selectResumeRecord(registry.records, latest) : undefined;
  if (!record) {
    throw new Error(`No previous run found in ${registryPath}`);
  }
  const snapshot = record.eventLogPath ? parseWorkbenchSnapshotPayload(await readFile(record.eventLogPath, "utf8")) : undefined;
  return { registryPath, record, snapshot };
}

function selectResumeRecord(records: WorkbenchRunRecord[], latest: WorkbenchRunRecord): WorkbenchRunRecord {
  let current = latest;
  const visited = new Set<string>();
  while (isTransientResumeError(current) && current.parentRunId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = records.find((record) => record.id === current.parentRunId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function isTransientResumeError(record: WorkbenchRunRecord): boolean {
  if (record.status !== "error") return false;
  const text = `${record.lastMessage ?? ""}\n${record.stoppedReason ?? ""}`.toLowerCase();
  return /gateway-challenge|cloudflare|just a moment|cf_chl|challenge-platform|transport exited|network|timeout|timed out/.test(text);
}

async function readInitialSnapshotArg(argv = process.argv, cwd = process.cwd(), resume?: CliResumeContext): Promise<WorkbenchTaskSnapshot | undefined> {
  const snapshotPath = readPathArg("--initial-snapshot-file", argv, cwd) ?? readPathArg("--snapshot-file", argv, cwd);
  if (snapshotPath) {
    return requireSnapshotFromText(await readFile(snapshotPath, "utf8"), snapshotPath);
  }

  const goalLogPath = readPathArg("--resume-goal-log", argv, cwd);
  if (goalLogPath) return requireSnapshotFromText(await readFile(goalLogPath, "utf8"), goalLogPath);
  return resume?.snapshot;
}

export function parseWorkbenchSnapshotPayload(text: string): WorkbenchTaskSnapshot | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    return snapshotFromUnknown(parsed);
  }

  let latest: WorkbenchTaskSnapshot | undefined;
  for (const line of trimmed.split(/\r\n|\n|\r/)) {
    const lineSnapshot = snapshotFromUnknown(parseJson(line.trim()));
    if (lineSnapshot) latest = lineSnapshot;
  }
  if (latest) return latest;

  const embedded = parseFirstJsonObject(trimmed);
  if (embedded !== undefined) {
    return snapshotFromUnknown(embedded);
  }
  return undefined;
}

function parseFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return parseJson(text.slice(start, index + 1));
    }
  }
  return undefined;
}

function requireSnapshotFromText(text: string, source: string): WorkbenchTaskSnapshot {
  const snapshot = parseWorkbenchSnapshotPayload(text);
  if (!snapshot) {
    throw new Error(`No workbench task snapshot found in ${source}`);
  }
  return snapshot;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function snapshotFromUnknown(value: unknown): WorkbenchTaskSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct = isWorkbenchTaskSnapshot(record) ? record : undefined;
  if (direct) return direct as unknown as WorkbenchTaskSnapshot;
  const nested = record.snapshot;
  if (nested && typeof nested === "object" && !Array.isArray(nested) && isWorkbenchTaskSnapshot(nested as Record<string, unknown>)) {
    return nested as WorkbenchTaskSnapshot;
  }
  const rounds = record.rounds;
  if (Array.isArray(rounds)) {
    for (const round of [...rounds].reverse()) {
      const roundSnapshot = snapshotFromUnknown(round);
      if (roundSnapshot) return roundSnapshot;
    }
  }
  return undefined;
}

function isWorkbenchTaskSnapshot(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.userGoal === "string" &&
    typeof value.state === "string" &&
    Array.isArray(value.plan) &&
    Array.isArray(value.acceptance) &&
    Array.isArray(value.evidence)
  );
}

function numberArg(name: string, argv = process.argv): number | undefined {
  const raw = readArg(name, argv);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function difficultyArg(name: string, argv = process.argv): WorkbenchRunBudgetDifficulty | undefined {
  const raw = readArg(name, argv);
  if (!raw) return undefined;
  if (raw === "simple" || raw === "normal" || raw === "complex" || raw === "longrun" || raw === "custom") {
    return raw;
  }
  throw new Error(`${name} must be one of simple, normal, complex, longrun, custom`);
}

function modeArg(name: string, argv = process.argv): WorkbenchMode | undefined {
  const raw = readArg(name, argv);
  if (!raw) return undefined;
  if (raw === "plan" || raw === "execute" || raw === "review" || raw === "discuss") {
    return raw;
  }
  throw new Error(`${name} must be one of plan, execute, review, discuss`);
}

export async function runCliMain(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "status";
  const cwd = readArg("--cwd", argv) ?? process.cwd();
  const prompt = await readPromptArg(argv, cwd);
  if (command === "run") {
    await runCliTask(cwd, prompt ?? "", argv);
    return;
  }
  if (command === "run-json") {
    await runCliTaskJson(cwd, prompt ?? "", argv);
    return;
  }
  if (command === "goal-run") {
    await runCliGoal(cwd, prompt ?? "", argv);
    return;
  }
  if (command === "goal-json") {
    await runCliGoalJson(cwd, prompt ?? "", argv);
    return;
  }

  if (command === "continue") {
    printContinuationPrompt(cwd, prompt);
  } else if (command === "background-demo") {
    printBackgroundTaskDemo(cwd, prompt);
  } else {
    printCliStatus(cwd);
  }
}

if (shouldRunCliMain()) {
  void runCliMain().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

function shouldRunCliMain(): boolean {
  const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
  if (entry.endsWith("/src/cli/main.ts") || entry.endsWith("/src/cli/main.js")) return true;
  if (!entry.endsWith("/vite-node.mjs") && !entry.endsWith("/vite-node.js")) return false;
  const command = process.argv[2];
  return (
    command === undefined ||
    command === "status" ||
    command === "continue" ||
    command === "background-demo" ||
    command === "run" ||
    command === "run-json" ||
    command === "goal-run" ||
    command === "goal-json"
  );
}
