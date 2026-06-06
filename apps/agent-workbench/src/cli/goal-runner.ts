import { assessTask, createContinuationDecision } from "../shared/task-controller";
import { calculateCompletion, type WorkbenchContinuationDecision, type WorkbenchRunEvent, type WorkbenchTaskSnapshot } from "../shared/workbench-contract";
import { runWorkbenchTask, type WorkbenchRunnerBudgetOptions, type WorkbenchRunnerOptions, type WorkbenchRunnerYield } from "./workbench-runner";
import type { WorkbenchRuntimeFactoryResult } from "./runtime-factory";

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
  const initialPrompt = snapshot
    ? buildGoalAuditPrompt({
        snapshot: normalizeVisibleGoal(snapshot, visibleGoal),
        visibleGoal,
        decision: {
          action: "continue",
          reason: "从保存的任务快照恢复；旧完成标记只能作为参考，必须重新读取实际文件、事件日志和验收证据后再判断是否完成",
          prompt: options.prompt.trim() || "continue"
        },
        roundIndex: -1,
        events: []
    })
    : options.prompt.trim() || visibleGoal;
  const rounds: WorkbenchGoalRound[] = [];
  let currentPrompt = initialPrompt;
  let previousSignature = snapshot ? progressSignature(snapshot) : "";
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
    const resumeDecision = continuationFromResumeEvent(events);
    const auditedDecision = snapshot ? createContinuationDecision(snapshot) : pauseDecision("本轮没有生成任务快照");
    let decision =
      resumeDecision && auditedDecision.action === "continue"
        ? { ...resumeDecision, prompt: resumeDecision.prompt }
        : auditedDecision;
    if (snapshot?.tokenBudget?.reached) {
      decision = pauseDecision("单次任务 token 预算已用完，需要用户确认是否继续");
    }
    decision = decorateGoalContinuationDecision({
      decision,
      snapshot,
      visibleGoal,
      roundIndex: index,
      events
    });
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

    const signature = snapshot ? progressSignature(snapshot) : "";
    stalledRounds = signature === previousSignature ? stalledRounds + 1 : 0;
    previousSignature = signature;
    if (stalledRounds >= maxStalledRounds) {
      decision = pauseDecision(`连续 ${stalledRounds + 1} 轮没有新的进度或证据，已暂停自动续跑`);
      return { rounds, snapshot, decision, stoppedReason: "stalled" };
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
    note: item.note ? `恢复后重新审计：${trimForPrompt(item.note, 180)}` : "恢复后需要重新审计"
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

function progressSignature(snapshot: WorkbenchTaskSnapshot): string {
  return JSON.stringify({
    state: snapshot.state,
    completionPercent: snapshot.completionPercent,
    plan: snapshot.plan.map((item) => [item.id, item.state, item.note ?? ""]),
    acceptance: snapshot.acceptance.map((item) => [item.id, item.passed, item.evidenceIds.join(",")]),
    evidenceCount: snapshot.evidence.length,
    changeCount: snapshot.changes.length,
    confirmationCount: snapshot.confirmations.length,
    backgroundTasks: snapshot.backgroundTasks.map((item) => [item.id, item.state, item.heartbeatCount, item.exitCode ?? ""])
  });
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

function decorateGoalContinuationDecision(input: {
  decision: WorkbenchContinuationDecision;
  snapshot?: WorkbenchTaskSnapshot;
  visibleGoal: string;
  roundIndex: number;
  events: WorkbenchRunEvent[];
}): WorkbenchContinuationDecision {
  if (input.decision.action !== "continue" || !input.decision.prompt || !input.snapshot) return input.decision;
  return {
    ...input.decision,
    prompt: buildGoalAuditPrompt({
      snapshot: input.snapshot,
      visibleGoal: input.visibleGoal,
      decision: input.decision,
      roundIndex: input.roundIndex,
      events: input.events
    })
  };
}

function buildGoalAuditPrompt(input: {
  snapshot: WorkbenchTaskSnapshot;
  visibleGoal: string;
  decision: WorkbenchContinuationDecision;
  roundIndex: number;
  events: WorkbenchRunEvent[];
}): string {
  const assessment = assessTask(input.snapshot);
  return [
    "自动续跑审计：",
    `轮次：${input.roundIndex + 1}`,
    `当前目标：${trimForPrompt(input.visibleGoal, 3_000)}`,
    `续跑原因：${input.decision.reason}`,
    `当前完成度：${assessment.completionPercent}%`,
    "",
    "已完成计划：",
    ...listOrFallback(
      input.snapshot.plan.filter((item) => item.state === "done").map((item) => `- ${trimForPrompt(item.title, 240)}`),
      "- 暂无已完成计划"
    ),
    "",
    "未完成计划：",
    ...listOrFallback(
      assessment.activePlanItems.map((item) => `- ${trimForPrompt(item.title, 240)}${item.note ? `：${trimForPrompt(item.note, 240)}` : ""}`),
      "- 暂无未完成计划"
    ),
    "",
    "未完成验收：",
    ...listOrFallback(assessment.missingAcceptance.map((item) => `- ${trimForPrompt(item.title, 240)}`), "- 暂无未完成验收"),
    "",
    "缺少证据的验收：",
    ...listOrFallback(assessment.acceptedWithoutEvidence.map((item) => `- ${trimForPrompt(item.title, 240)}`), "- 暂无缺证验收"),
    "",
    "最近证据：",
    ...listOrFallback(
      input.snapshot.evidence.slice(-6).map((item) => `- ${trimForPrompt(item.title, 240)}${item.detail ? `：${trimForPrompt(item.detail, 600)}` : ""}`),
      "- 暂无证据"
    ),
    "",
    "最近变更：",
    ...listOrFallback(
      input.snapshot.changes.slice(-6).map((item) => `- ${item.path} +${item.additions} -${item.deletions} ${item.state}`),
      "- 暂无变更"
    ),
    "",
    "回退建议：",
    ...rollbackAdviceLines(input.snapshot),
    "",
    "后台任务：",
    ...listOrFallback(
      input.snapshot.backgroundTasks
        .slice(-6)
        .map((item) => `- ${trimForPrompt(item.title, 240)}：${item.state}${item.exitCode === undefined ? "" : `，exit=${item.exitCode ?? "null"}`}`),
      "- 暂无后台任务"
    ),
    "",
    "披露问题：",
    ...listOrFallback(
      input.snapshot.disclosureIssues.slice(-6).map((item) => `- ${trimForPrompt(item.title, 240)}：${trimForPrompt(item.suggestion, 360)}`),
      "- 暂无披露问题"
    ),
    "",
    "本轮事件摘要：",
    ...listOrFallback(input.events.slice(-6).map((item) => `- ${item.type}：${trimForPrompt(item.message, 500)}`), "- 暂无事件"),
    "",
    "下一轮执行要求：",
    "- 先检查未完成验收和缺少证据的验收，再决定下一步。",
    "- 不要扩大任务范围，不要重复已经有证据支持的工作。",
    "- 如果需要证明质量，优先运行检查命令、读取关键文件或补充证据。",
    "- 如果目标已经完成，必须把计划、验收和证据更新到可审计状态后再结束。",
    "- 如果遇到阻塞或需要用户判断，暂停并说明原因。",
    "",
    "原始续跑指令：",
    trimForPrompt(input.decision.prompt, 4_000)
  ].join("\n");
}

function rollbackAdviceLines(snapshot: WorkbenchTaskSnapshot): string[] {
  if (snapshot.changes.length === 0) return ["- 暂无需要回退的变更"];
  return snapshot.changes.slice(-8).map((item) => {
    const checkpoint = item.checkpointId ? `可通过 checkpoint ${item.checkpointId} 回退` : "缺少 checkpoint，继续修改前应先补充检查点或重新读取确认";
    const review = item.state === "checked" ? "已检查" : item.state === "needs-review" ? "需要复查" : "仍是草稿";
    return `- ${item.path}：${checkpoint}，${review}`;
  });
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

function trimForPrompt(text: string | undefined, maxChars: number): string {
  const normalized = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  if (looksLikeGatewayChallenge(normalized)) {
    return `[gateway-challenge] Cloudflare managed challenge HTML omitted (${normalized.length} chars).`;
  }
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.max(1, Math.floor(maxChars * 0.62));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${normalized.slice(0, headChars)}\n[中间省略 ${normalized.length - maxChars} 字符]\n${normalized.slice(-tailChars)}`;
}

function looksLikeGatewayChallenge(text: string): boolean {
  return /cloudflare|just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(text);
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

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
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
