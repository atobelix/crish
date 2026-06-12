import { calculateCompletion, type WorkbenchContinuationDecision, type WorkbenchRunEvent, type WorkbenchTaskSnapshot } from "../shared/workbench-contract";
import { runWorkbenchTask, type WorkbenchRunnerBudgetOptions, type WorkbenchRunnerOptions, type WorkbenchRunnerYield } from "./workbench-runner";
import type { WorkbenchRuntimeFactoryResult } from "./runtime-factory";
import {
  SnapshotAwareGoalStrategy,
  type SnapshotAwareRoundContext
} from "./snapshot-aware-goal-strategy";
import type { GoalContinuationDecision } from "@crish/agent-orchestrator";

export type WorkbenchGoalRunTask = (options: WorkbenchRunnerOptions) => AsyncIterable<WorkbenchRunnerYield>;
const DEFAULT_GOAL_BACKGROUND_DRAIN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_GOAL_ROUNDS_PER_TARGET_MINUTE = 2;
const DEFAULT_GOAL_MIN_ROUNDS = 12;
const DEFAULT_GOAL_MAX_ROUNDS = 80;
const DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS = 90_000;

export interface WorkbenchGoalRunnerOptions {
  runtime: WorkbenchRuntimeFactoryResult;
  cwd: string;
  prompt: string;
  visibleGoal?: string;
  initialSnapshot?: WorkbenchTaskSnapshot;
  maxRounds?: number;
  maxStalledRounds?: number;
  maxTransientProviderErrors?: number;
  backgroundDrainTimeoutMs?: number;
  providerRateLimitBackoffMs?: number;
  runBudget?: WorkbenchRunnerBudgetOptions;
  runTask?: WorkbenchGoalRunTask;
  onRoundStart?(round: Pick<WorkbenchGoalRound, "index" | "prompt">): void | Promise<void>;
  onYield?(input: { roundIndex: number; item: WorkbenchRunnerYield }): void | Promise<void>;
  onRoundEnd?(round: WorkbenchGoalRound): void | Promise<void>;
}

export interface WorkbenchGoalRound {
  index: number;
  prompt: string;
  events: WorkbenchRunEvent[];
  snapshot?: WorkbenchTaskSnapshot;
  decision?: WorkbenchContinuationDecision;
}

export interface WorkbenchGoalResult {
  rounds: WorkbenchGoalRound[];
  snapshot?: WorkbenchTaskSnapshot;
  decision?: WorkbenchContinuationDecision;
  stoppedReason: "complete" | "pause" | "max-rounds" | "stalled" | "error";
}

export async function runWorkbenchGoal(options: WorkbenchGoalRunnerOptions): Promise<WorkbenchGoalResult> {
  const maxRounds = positiveInteger(options.maxRounds, defaultGoalMaxRounds(options.runtime.settings.longRun.targetMinutes));
  const maxStalledRounds = positiveInteger(options.maxStalledRounds, 2);
  const maxTransientProviderErrors = positiveInteger(options.maxTransientProviderErrors, Math.max(6, Math.ceil(maxRounds * 0.75)));
  const maxAttempts = maxRounds + maxTransientProviderErrors;
  const backgroundDrainTimeoutMs = options.backgroundDrainTimeoutMs ?? DEFAULT_GOAL_BACKGROUND_DRAIN_TIMEOUT_MS;
  const providerRateLimitBackoffMs = Math.max(0, Math.floor(options.providerRateLimitBackoffMs ?? DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS));
  let snapshot = options.initialSnapshot ? sanitizeInitialGoalSnapshot(options.initialSnapshot) : undefined;
  const visibleGoal = options.visibleGoal?.trim() || snapshot?.userGoal.trim() || options.prompt.trim();

  // 创建策略实例（整个 goal 循环共享），用于决策、签名和 prompt 构建
  const strategy = new SnapshotAwareGoalStrategy({
    visibleGoal,
    snapshotResolver: ({ roundContext }) => {
      const ctx = roundContext as SnapshotAwareRoundContext | undefined;
      return ctx?.latestSnapshot;
    }
  });

  // 初始 prompt：从快照恢复时使用策略的审计 prompt 构建能力
  const initialPrompt = snapshot
    ? (strategy.buildNextRoundPrompt({
        decision: {
          action: "continue",
          reason: "从保存的任务快照恢复；旧完成标记只能作为参考，必须重新读取实际文件、事件日志和验收证据后再判断是否完成",
          prompt: options.prompt.trim() || "continue"
        },
        roundIndex: -1,
        goalState: {
          status: "running", maxRounds, maxStalledRounds: 2,
          currentRound: -1, completedRounds: 0, stalledRounds: 0
        },
        events: [],
        roundContext: { latestSnapshot: normalizeVisibleGoal(snapshot, visibleGoal) } as SnapshotAwareRoundContext
      }) ?? (options.prompt.trim() || visibleGoal))
    : options.prompt.trim() || visibleGoal;
  const rounds: WorkbenchGoalRound[] = [];
  let currentPrompt = initialPrompt;
  let previousSignature = snapshot
    ? strategy.computeProgressSignature({
        decision: { action: "continue", reason: "" },
        events: [],
        roundContext: { latestSnapshot: snapshot } as SnapshotAwareRoundContext
      })
    : "";
  let stalledRounds = 0;
  let productiveRounds = 0;
  let consecutiveTransientProviderErrors = 0;
  let totalTransientProviderErrors = 0;
  const runTask = options.runTask ?? runWorkbenchTask;

  for (let index = 0; index < maxAttempts && productiveRounds < maxRounds; index += 1) {
    const events: WorkbenchRunEvent[] = [];
    let roundSnapshot: WorkbenchTaskSnapshot | undefined;
    await options.onRoundStart?.({ index, prompt: currentPrompt });

    try {
      for await (const item of runTask({
        runtime: options.runtime,
        cwd: options.cwd,
        prompt: currentPrompt,
        mode: "execute",
        initialSnapshot: snapshot,
        backgroundDrainTimeoutMs,
        runBudget: options.runBudget
      })) {
        events.push(item.event);
        roundSnapshot = normalizeVisibleGoal(item.snapshot, visibleGoal);
        await options.onYield?.({ roundIndex: index, item: { ...item, snapshot: roundSnapshot } });
      }
    } catch (cause) {
      const decision = pauseDecision(cause instanceof Error ? cause.message : String(cause));
      const round = { index, prompt: currentPrompt, events, snapshot: roundSnapshot, decision };
      rounds.push(round);
      await options.onRoundEnd?.(round);
      return {
        rounds,
        snapshot: roundSnapshot,
        decision,
        stoppedReason: "error"
      };
    }

    snapshot = roundSnapshot ? normalizeVisibleGoal(roundSnapshot, visibleGoal) : snapshot;
    const providerRateLimitReason = providerRateLimitReasonFromEvents(events);
    if (providerRateLimitReason) {
      consecutiveTransientProviderErrors = 0;
      const decision: WorkbenchContinuationDecision = {
        action: "continue",
        reason: `Provider rate limited; backing off before retry: ${providerRateLimitReason}`,
        prompt: currentPrompt
      };
      const round = { index, prompt: currentPrompt, events, snapshot, decision };
      rounds.push(round);
      await options.onRoundEnd?.(round);
      if (providerRateLimitBackoffMs > 0) {
        await delay(providerRateLimitBackoffMs);
      }
      continue;
    }
    const providerTransientNetworkReason = providerTransientNetworkReasonFromEvents(events);
    if (providerTransientNetworkReason) {
      consecutiveTransientProviderErrors += 1;
      totalTransientProviderErrors += 1;
      if (totalTransientProviderErrors > maxTransientProviderErrors) {
        const decision = pauseDecision(
          `Provider network remained unstable after ${totalTransientProviderErrors} transient failures: ${providerTransientNetworkReason}`
        );
        const round = { index, prompt: currentPrompt, events, snapshot, decision };
        rounds.push(round);
        await options.onRoundEnd?.(round);
        return {
          rounds,
          snapshot,
          decision,
          stoppedReason: "error"
        };
      }
      const decision: WorkbenchContinuationDecision = {
        action: "continue",
        reason: `Provider network issue; backing off before retry (${consecutiveTransientProviderErrors} consecutive, ${totalTransientProviderErrors}/${maxTransientProviderErrors} total): ${providerTransientNetworkReason}`,
        prompt: currentPrompt
      };
      const round = { index, prompt: currentPrompt, events, snapshot, decision };
      rounds.push(round);
      await options.onRoundEnd?.(round);
      if (providerRateLimitBackoffMs > 0) {
        await delay(Math.min(providerRateLimitBackoffMs, 30_000));
      }
      continue;
    }
    consecutiveTransientProviderErrors = 0;
    const fatalRunErrorReason = fatalRunErrorReasonFromEvents(events);
    if (fatalRunErrorReason) {
      const decision = pauseDecision(fatalRunErrorReason);
      const round = { index, prompt: currentPrompt, events, snapshot, decision };
      rounds.push(round);
      await options.onRoundEnd?.(round);
      return {
        rounds,
        snapshot,
        decision,
        stoppedReason: "error"
      };
    }

    // -- Strategy-based assessment (replaces inline continuation logic) --
    const resumeDecision = continuationFromResumeEvent(events);
    const strategy = new SnapshotAwareGoalStrategy({
      visibleGoal,
      snapshotResolver: ({ roundContext }) => {
        const ctx = roundContext as SnapshotAwareRoundContext | undefined;
        return ctx?.latestSnapshot;
      }
    });

    const goalDecision = strategy.assessRound({
      run: { status: "running" } as any,
      session: { id: "", cwd: options.cwd, createdAt: "", updatedAt: "", status: "open" },
      roundIndex: index,
      prompt: currentPrompt,
      events: [],
      roundContext: {
        latestSnapshot: snapshot,
        workbenchResumeDecision: resumeDecision
          ? mapToGoalDecision(resumeDecision)
          : undefined
      } as SnapshotAwareRoundContext
    });

    // Map orchestrator decision back to workbench format
    const decision = mapToWorkbenchDecision(goalDecision);

    // Enrich the continuation prompt with audit context
    if (decision.action === "continue" && decision.prompt && snapshot) {
      // 当 resume 事件覆盖了 continue 决策时，使用 resume prompt 作为"原始续跑指令"
      const promptForAudit = resumeDecision?.prompt ?? decision.prompt;
      const enrichedPrompt = strategy.buildNextRoundPrompt({
        decision: {
          ...goalDecision,
          prompt: promptForAudit
        },
        roundIndex: index,
        goalState: {
          status: "running",
          maxRounds,
          maxStalledRounds,
          currentRound: index,
          completedRounds: productiveRounds,
          stalledRounds
        },
        events: [],
        roundContext: {
          latestSnapshot: snapshot,
          workbenchEvents: events
        } as SnapshotAwareRoundContext
      });
      decision.prompt = enrichedPrompt ?? decision.prompt;
    }

    const round = { index, prompt: currentPrompt, events, snapshot, decision };
    rounds.push(round);
    await options.onRoundEnd?.(round);
    productiveRounds += 1;

    if (decision.action === "complete") {
      return { rounds, snapshot, decision, stoppedReason: "complete" };
    }
    if (decision.action === "pause" || !decision.prompt) {
      return { rounds, snapshot, decision, stoppedReason: "pause" };
    }

    // -- Stall detection using strategy's progress signature --
    const signature = strategy.computeProgressSignature({
      decision: goalDecision,
      events: [],
      roundContext: { latestSnapshot: snapshot } as SnapshotAwareRoundContext
    });
    stalledRounds = signature === previousSignature ? stalledRounds + 1 : 0;
    previousSignature = signature;
    if (stalledRounds >= maxStalledRounds) {
      const stalledDecision = pauseDecision(`连续 ${stalledRounds + 1} 轮没有新的进度或证据，已暂停自动续跑`);
      return { rounds, snapshot, decision: stalledDecision, stoppedReason: "stalled" };
    }

    currentPrompt = decision.prompt;
  }

  const decision = pauseDecision(`达到本次自动续跑最大轮数：${maxRounds}`);
  return {
    rounds,
    snapshot,
    decision,
    stoppedReason: "max-rounds"
  };
}

function normalizeVisibleGoal(snapshot: WorkbenchTaskSnapshot, visibleGoal: string): WorkbenchTaskSnapshot {
  return {
    ...snapshot,
    userGoal: visibleGoal
  };
}

function sanitizeInitialGoalSnapshot(snapshot: WorkbenchTaskSnapshot): WorkbenchTaskSnapshot {
  const restored = {
    ...snapshot,
    state: snapshot.state === "waiting" || snapshot.state === "blocked" || snapshot.state === "done" ? "planning" : snapshot.state,
    confirmations: []
  };
  if (!looksFinalOrOvertrusted(restored)) return restored;

  const plan = restored.plan.map((item, index) => ({
    ...item,
    state: index === 0 ? ("doing" as const) : ("todo" as const),
    note: item.note ? `恢复后重新审计：${trimText(item.note, 180)}` : "恢复后需要重新审计"
  }));
  const acceptance = restored.acceptance.map((item) =>
    item.required
      ? {
          ...item,
          passed: false,
          evidenceIds: []
        }
      : item
  );
  return {
    ...restored,
    plan,
    acceptance,
    completionPercent: calculateCompletion({ plan, acceptance }),
    progressLabel: "从历史快照恢复，正在重新审计完成状态",
    nextActions: ["重新读取关键文件", "重新运行必要检查", "补齐验收证据"],
    health: {
      ...restored.health,
      state: "busy",
      summary: "恢复后重新审计"
    }
  };
}

function looksFinalOrOvertrusted(snapshot: WorkbenchTaskSnapshot): boolean {
  const requiredAcceptance = snapshot.acceptance.filter((item) => item.required);
  return (
    snapshot.state === "done" ||
    snapshot.completionPercent >= 100 ||
    (snapshot.plan.length > 0 &&
      snapshot.plan.every((item) => item.state === "done") &&
      requiredAcceptance.length > 0 &&
      requiredAcceptance.every((item) => item.passed))
  );
}

function continuationFromResumeEvent(events: WorkbenchRunEvent[]): WorkbenchContinuationDecision | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "resume-requested") continue;
    const continuation = continuationFromPayload(event.payload);
    if (continuation?.action === "continue" && continuation.prompt) return continuation;
  }
  return undefined;
}

function continuationFromPayload(payload: unknown): WorkbenchContinuationDecision | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const continuation = (payload as { continuation?: unknown }).continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) return undefined;
  const record = continuation as Record<string, unknown>;
  const action = record.action;
  const reason = record.reason;
  const prompt = record.prompt;
  if ((action !== "continue" && action !== "pause" && action !== "complete") || typeof reason !== "string") return undefined;
  return {
    action,
    reason,
    ...(typeof prompt === "string" ? { prompt } : {})
  };
}

/** 将 WorkbenchContinuationDecision 映射为 GoalContinuationDecision（供策略使用） */
function mapToGoalDecision(decision: WorkbenchContinuationDecision): GoalContinuationDecision {
  return {
    action: decision.action === "pause" ? "block" : decision.action,
    reason: decision.reason,
    ...(decision.prompt ? { prompt: decision.prompt } : {})
  };
}

/** 将 GoalContinuationDecision 映射回 WorkbenchContinuationDecision（供 workbench 消费） */
function mapToWorkbenchDecision(decision: GoalContinuationDecision): WorkbenchContinuationDecision {
  return {
    action: decision.action === "block" ? "pause" : decision.action,
    reason: decision.reason,
    ...(decision.prompt ? { prompt: decision.prompt } : {})
  };
}

function providerRateLimitReasonFromEvents(events: WorkbenchRunEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (!isProviderRateLimitEvent(event)) continue;
    return trimRateLimitReason(event.message || payloadText(event.payload) || "429 Too Many Requests");
  }
  return undefined;
}

function fatalRunErrorReasonFromEvents(events: WorkbenchRunEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "run-error") continue;
    if (isProviderRateLimitEvent(event)) continue;
    if (isProviderTransientNetworkEvent(event)) continue;
    return trimRunErrorReason(event.message || payloadText(event.payload) || "run failed");
  }
  return undefined;
}

function isProviderRateLimitEvent(event: WorkbenchRunEvent): boolean {
  const text = `${event.type}\n${event.message ?? ""}\n${payloadText(event.payload)}`;
  return /\b429\b|too many requests|rate[_ -]?limit/i.test(text);
}

function providerTransientNetworkReasonFromEvents(events: WorkbenchRunEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (!isProviderTransientNetworkEvent(event)) continue;
    return trimRunErrorReason(event.message || payloadText(event.payload) || "transient provider network error");
  }
  return undefined;
}

function isProviderTransientNetworkEvent(event: WorkbenchRunEvent): boolean {
  if (event.type !== "run-error") return false;
  const text = `${event.message ?? ""}\n${payloadText(event.payload)}`;
  if (/gateway-challenge|cloudflare|just a moment|cf_chl|challenge-platform/i.test(text)) return true;
  if (/tls handshake eof|fetch failed|connection reset|econnreset|etimedout|socket hang up|network\s+error/i.test(text)) return true;
  if (/rust reqwest fallback failed|rust reqwest transport exited/i.test(text) && /http request failed|connect|connection|tls/i.test(text)) return true;
  return false;
}

function payloadText(payload: unknown): string {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function trimRateLimitReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 300)}...`;
}

function trimRunErrorReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}...`;
}

function trimText(text: string | undefined, maxChars: number): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function pauseDecision(reason: string): WorkbenchContinuationDecision {
  return {
    action: "pause",
    reason
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function defaultGoalMaxRounds(targetMinutes: number | undefined): number {
  const minutes = Number.isFinite(targetMinutes) && targetMinutes !== undefined && targetMinutes > 0 ? targetMinutes : 15;
  return Math.min(
    DEFAULT_GOAL_MAX_ROUNDS,
    Math.max(DEFAULT_GOAL_MIN_ROUNDS, Math.ceil(minutes * DEFAULT_GOAL_ROUNDS_PER_TARGET_MINUTE))
  );
}
