import type { AgentEvent, AgentMessage } from "@crish/shared-types";
import type {
  GoalContinuationDecision,
  GoalLoopStrategy,
  OrchestratorGoalRunState,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  ProviderErrorResult
} from "@crish/agent-orchestrator";
import {
  detectFatalRuntimeError,
  detectProviderRateLimit,
  detectTransientNetworkError
} from "@crish/agent-orchestrator";
import {
  assessTask,
  createContinuationDecision
} from "../shared/task-controller";
import type {
  WorkbenchContinuationDecision,
  WorkbenchTaskSnapshot
} from "../shared/workbench-contract";

// ── Snapshot 解析 ────────────────────────────────────────────────

/**
 * Snapshot 解析函数：从本轮事件流中获取当前 WorkbenchTaskSnapshot。
 *
 * 典型实现方式：
 * 1. 引擎包装器在 onRoundEvent 中将最新 snapshot 存入 roundContext，
 *    解析器从 roundContext 中提取。
 * 2. 外部闭包持有 snapshot 引用，解析器直接返回。
 */
export type SnapshotResolver = (input: {
  events: AgentEvent[];
  roundContext: unknown | undefined;
}) => WorkbenchTaskSnapshot | undefined;

/**
 * 从 roundContext 中提取 SnapshotAwareRoundContext。
 * 引擎包装器应在 onRoundEvent 中将最新 snapshot 存入此结构。
 */
export interface SnapshotAwareRoundContext {
  latestSnapshot: WorkbenchTaskSnapshot | undefined;
  /** Workbench 层面的 resume 决策（由 resume-requested 事件产生），优先于策略内部的 resume 检测 */
  workbenchResumeDecision: GoalContinuationDecision | undefined;
  /** Workbench 层面的事件列表，用于审计 prompt 中的"本轮事件摘要" */
  workbenchEvents: Array<{ type: string; message: string; timestamp: string | undefined }> | undefined;
}

/**
 * SnapshotAwareGoalStrategy 的配置选项。
 */
export interface SnapshotAwareGoalStrategyOptions {
  /** 目标描述，用于审计 prompt 的标题区域 */
  visibleGoal: string | undefined;

  /**
   * Snapshot 解析器。当 roundContext 中不包含 snapshot 时，
   * 使用此函数从事件流或外部状态获取 snapshot。
   */
  snapshotResolver: SnapshotResolver | undefined;

  /** Provider 限频退避时间（毫秒），默认 90000 */
  providerRateLimitBackoffMs: number | undefined;

  /** 最大连续瞬态 Provider 错误次数，默认 6 */
  maxTransientProviderErrors: number | undefined;
}

// ── 策略实现 ─────────────────────────────────────────────────────

/**
 * 基于 WorkbenchTaskSnapshot 的领域感知 Goal 循环策略。
 *
 * 与 EventScanGoalStrategy（基于事件流标记扫描）不同，此策略使用
 * workbench 的任务快照来做延续决策：
 *
 * - assessRound：使用 assessTask + createContinuationDecision 进行
 *   计划/验收/证据三维度的领域评估，能准确识别「验收未通过」「证据缺失」
 *   「计划阻塞」等结构化状态。
 * - computeProgressSignature：基于 snapshot 的 JSON 序列化签名，
 *   比事件哈希更精确地反映任务进度。
 * - buildNextRoundPrompt：构建审计增强 prompt，注入计划状态、
 *   验收缺口、证据列表、回退建议等上下文，引导 agent 聚焦于
 *   未完成的验收项而非扩大范围。
 * - onRoundEvent：累积轮次上下文，跟踪最新 snapshot。
 *
 * 使用方式：
 * ```typescript
 * const strategy = new SnapshotAwareGoalStrategy({
 *   visibleGoal: "实现用户登录功能",
 *   snapshotResolver: ({ roundContext }) =>
 *     (roundContext as SnapshotAwareRoundContext)?.latestSnapshot
 * });
 *
 * await orchestrator.startGoalRun({
 *   goalLoopStrategy: strategy,
 *   // ...
 * });
 * ```
 */
export class SnapshotAwareGoalStrategy implements GoalLoopStrategy {
  readonly name = "snapshot-aware";

  private readonly visibleGoal: string;
  private readonly snapshotResolver: SnapshotResolver | undefined;
  private readonly providerBackoffMs: number;
  private readonly maxTransientErrors: number;

  constructor(options: SnapshotAwareGoalStrategyOptions = { visibleGoal: undefined, snapshotResolver: undefined, providerRateLimitBackoffMs: undefined, maxTransientProviderErrors: undefined }) {
    this.visibleGoal = options.visibleGoal ?? "";
    this.snapshotResolver = options.snapshotResolver;
    this.providerBackoffMs = options.providerRateLimitBackoffMs ?? 90_000;
    this.maxTransientErrors = options.maxTransientProviderErrors ?? 6;
  }

  // ── GoalLoopStrategy: 评估轮次结果 ─────────────────────────────

  assessRound(input: {
    run: OrchestratorRunRecord;
    session: OrchestratorSessionRecord;
    roundIndex: number;
    prompt: string | AgentMessage;
    events: AgentEvent[];
    roundContext: unknown | undefined;
  }): GoalContinuationDecision {
    const snapshot = this.resolveSnapshot(input.events, input.roundContext);

    // 无 snapshot 时退化为基于事件的简单决策
    if (!snapshot) {
      return this.fallbackDecisionFromEvents(input.events);
    }

    // Token 预算检查
    if (snapshot.tokenBudget?.reached) {
      return {
        action: "block",
        reason: "单次任务 token 预算已用完，需要用户确认是否继续"
      };
    }

    // 领域感知延续决策
    const workbenchDecision = createContinuationDecision(snapshot);

    // 检查 resume 事件（agent 显式请求继续时可覆盖 pause）
    // 优先从 roundContext 获取 workbench 层面已解析的 resume decision
    const resumeDecision = this.extractResumeDecisionFromContext(input.roundContext)
      ?? this.extractResumeDecision(input.events);

    return this.mapWorkbenchDecision(
      workbenchDecision,
      snapshot,
      input.events,
      input.roundIndex,
      resumeDecision
    );
  }

  // ── GoalLoopStrategy: 进度签名 ─────────────────────────────────

  computeProgressSignature(input: {
    decision: GoalContinuationDecision;
    events: AgentEvent[];
    roundContext: unknown | undefined;
  }): string {
    const snapshot = this.resolveSnapshot(input.events, input.roundContext);
    if (snapshot) {
      return snapshotProgressSignature(snapshot);
    }
    return input.decision.progressSignature ?? "";
  }

  // ── GoalLoopStrategy: 构建下一轮 prompt ────────────────────────

  buildNextRoundPrompt(input: {
    decision: GoalContinuationDecision;
    roundIndex: number;
    goalState: OrchestratorGoalRunState;
    events: AgentEvent[];
    roundContext: unknown | undefined;
  }): string | undefined {
    if (input.decision.action !== "continue" || !input.decision.prompt) return undefined;

    const snapshot = this.resolveSnapshot(input.events, input.roundContext);
    if (!snapshot) return undefined;

    return buildAuditPrompt({
      snapshot,
      visibleGoal: this.visibleGoal || snapshot.userGoal,
      decision: input.decision,
      roundIndex: input.roundIndex,
      events: input.events,
      workbenchEvents: isRoundContext(input.roundContext) ? input.roundContext.workbenchEvents : undefined
    });
  }

  // ── GoalLoopStrategy: Provider 容错 ────────────────────────────

  handleProviderError(input: {
    events: AgentEvent[];
    roundIndex: number;
    consecutiveTransientErrors: number;
  }): ProviderErrorResult | undefined {
    const rateLimit = detectProviderRateLimit(input.events);
    if (rateLimit) {
      return {
        action: "backoff",
        reason: `Provider rate limited; backing off before retry: ${rateLimit}`,
        backoffMs: this.providerBackoffMs,
        countAsProductive: false
      };
    }

    const transientError = detectTransientNetworkError(input.events);
    if (transientError) {
      if (input.consecutiveTransientErrors >= this.maxTransientErrors) {
        return {
          action: "fatal",
          reason: `Provider network remained unstable after ${input.consecutiveTransientErrors} transient failures: ${transientError}`
        };
      }
      return {
        action: "backoff",
        reason: `Provider network issue; backing off before retry (${input.consecutiveTransientErrors + 1}/${this.maxTransientErrors}): ${transientError}`,
        backoffMs: Math.min(this.providerBackoffMs, 30_000),
        countAsProductive: false
      };
    }

    const fatal = detectFatalRuntimeError(input.events);
    if (fatal) {
      return { action: "fatal", reason: fatal };
    }

    return undefined;
  }

  // ── GoalLoopStrategy: 轮次事件累积 ─────────────────────────────

  onRoundEvent(event: AgentEvent, previousContext?: unknown): SnapshotAwareRoundContext {
    const ctx: SnapshotAwareRoundContext = isRoundContext(previousContext)
      ? previousContext
      : { latestSnapshot: undefined, workbenchResumeDecision: undefined, workbenchEvents: undefined };

    // 引擎包装器可通过 AgentEvent 的扩展字段传递 snapshot
    // 这里检测 runtime-event 中携带的 snapshot 数据
    const snapshotFromEvent = extractSnapshotFromEvent(event);
    if (snapshotFromEvent) {
      return { ...ctx, latestSnapshot: snapshotFromEvent };
    }

    return ctx;
  }

  // ── 内部方法 ───────────────────────────────────────────────────

  private resolveSnapshot(events: AgentEvent[], roundContext: unknown | undefined): WorkbenchTaskSnapshot | undefined {
    // 优先从 roundContext 获取
    if (isRoundContext(roundContext) && roundContext.latestSnapshot) {
      return roundContext.latestSnapshot;
    }
    // 尝试 resolver
    if (this.snapshotResolver) {
      return this.snapshotResolver({ events, roundContext });
    }
    return undefined;
  }

  private extractResumeDecision(events: AgentEvent[]): GoalContinuationDecision | undefined {
    for (const event of [...events].reverse()) {
      const resumeData = extractResumePayload(event);
      if (!resumeData) continue;
      const decision = parseContinuationFromPayload(resumeData);
      if (decision?.action === "continue" && decision.prompt) {
        return decision;
      }
    }
    return undefined;
  }

  private extractResumeDecisionFromContext(roundContext: unknown | undefined): GoalContinuationDecision | undefined {
    if (isRoundContext(roundContext) && roundContext.workbenchResumeDecision) {
      const d = roundContext.workbenchResumeDecision;
      if (d.action === "continue" && d.prompt) return d;
    }
    return undefined;
  }

  private mapWorkbenchDecision(
    decision: WorkbenchContinuationDecision,
    snapshot: WorkbenchTaskSnapshot,
    events: AgentEvent[],
    roundIndex: number,
    resumeDecision: GoalContinuationDecision | undefined
  ): GoalContinuationDecision {
    // complete → complete（映射一致）
    if (decision.action === "complete") {
      return {
        action: "complete",
        reason: decision.reason,
        detail: { completionPercent: snapshot.completionPercent } as unknown as Record<string, unknown>
      };
    }

    // pause → block（orchestrator 没有 pause 概念，统一为 block）
    if (decision.action === "pause") {
      // resume 事件可以覆盖 pause（仅当审计决策是 continue 时）
      if (resumeDecision && resumeDecision.action === "continue" && resumeDecision.prompt) {
        return resumeDecision;
      }
      return {
        action: "block",
        reason: decision.reason
      };
    }

    // continue → continue
    // 当 resume decision 覆盖了 continue 的 prompt 时，使用 resume 的 prompt
    const finalPrompt = resumeDecision?.prompt ?? decision.prompt;
    return {
      action: "continue",
      reason: resumeDecision?.reason ?? decision.reason,
      ...(finalPrompt !== undefined ? { prompt: finalPrompt } : {})
    };
  }

  private fallbackDecisionFromEvents(events: AgentEvent[]): GoalContinuationDecision {
    // 检测致命错误
    const fatal = detectFatalRuntimeError(events);
    if (fatal) {
      return { action: "block", reason: fatal };
    }

    // 检测 agent-end 事件
    for (const event of [...events].reverse()) {
      if (event.type === "agent-end") {
        if (event.reason === "stop") {
          return { action: "complete", reason: "Agent 正常结束" };
        }
        return {
          action: "block",
          reason: `Agent 异常结束: ${event.reason}${event.error ? ` - ${event.error}` : ""}`
        };
      }
    }

    return {
      action: "continue",
      reason: "无快照可用，继续执行",
      prompt: "继续执行任务"
    };
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────

function isRoundContext(value: unknown): value is SnapshotAwareRoundContext {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 尝试从 AgentEvent 中提取 WorkbenchTaskSnapshot。
 * 引擎包装器可通过在事件上附加 __snapshot 字段来传递 snapshot。
 */
function extractSnapshotFromEvent(event: AgentEvent): WorkbenchTaskSnapshot | undefined {
  const ext = event as AgentEvent & { __snapshot?: WorkbenchTaskSnapshot };
  return ext.__snapshot;
}

/**
 * 尝试从 AgentEvent 中提取 resume 请求的 payload。
 */
function extractResumePayload(event: AgentEvent): unknown {
  const record = event as Record<string, unknown>;
  if (record.type === "resume-requested") return record.payload;
  // 兼容 workbench 风格的 resume 事件（通过 tool-result 传递）
  if (record.type === "tool-end") {
    const result = record.result as Record<string, unknown> | undefined;
    if (result?.kind === "resume-requested") return result.payload;
  }
  return undefined;
}

function parseContinuationFromPayload(payload: unknown): GoalContinuationDecision | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const continuation = (payload as { continuation?: unknown }).continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) return undefined;
  const record = continuation as Record<string, unknown>;
  const action = record.action;
  const reason = record.reason;
  const prompt = record.prompt;
  if ((action !== "continue" && action !== "pause" && action !== "complete") || typeof reason !== "string") return undefined;

  const mapped: GoalContinuationDecision = {
    action: action === "pause" ? "block" : action,
    reason,
    ...(typeof prompt === "string" ? { prompt } : {})
  };
  return mapped;
}

/**
 * 基于 WorkbenchTaskSnapshot 的进度签名。
 * 与 goal-runner.ts 中的 progressSignature 逻辑一致：
 * 签名相同的连续轮次视为「没有新进度」。
 */
function snapshotProgressSignature(snapshot: WorkbenchTaskSnapshot): string {
  return JSON.stringify({
    state: snapshot.state,
    completionPercent: snapshot.completionPercent,
    plan: snapshot.plan.map((item) => [item.id, item.state, item.note ?? ""]),
    acceptance: snapshot.acceptance.map((item) => [item.id, item.passed, item.evidenceIds.join(",")]),
    evidenceCount: snapshot.evidence.length,
    changeCount: snapshot.changes.length,
    confirmationCount: snapshot.confirmations.length,
    backgroundTasks: snapshot.backgroundTasks.map(
      (item) => [item.id, item.state, item.heartbeatCount, item.exitCode ?? ""]
    )
  });
}

// ── 审计 Prompt 构建 ──────────────────────────────────────────────

function buildAuditPrompt(input: {
  snapshot: WorkbenchTaskSnapshot;
  visibleGoal: string;
  decision: GoalContinuationDecision;
  roundIndex: number;
  events: AgentEvent[];
  workbenchEvents: Array<{ type: string; message: string }> | undefined;
}): string {
  const assessment = assessTask(input.snapshot);
  const lines: string[] = [
    "自动续跑审计：",
    `轮次：${input.roundIndex + 1}`,
    `当前目标：${trimText(input.visibleGoal, 3_000)}`,
    `续跑原因：${input.decision.reason}`,
    `当前完成度：${assessment.completionPercent}%`,
    "",
    "已完成计划：",
    ...listOrFallback(
      input.snapshot.plan
        .filter((item) => item.state === "done")
        .map((item) => `- ${trimText(item.title, 240)}`),
      "- 暂无已完成计划"
    ),
    "",
    "未完成计划：",
    ...listOrFallback(
      assessment.activePlanItems.map(
        (item) => `- ${trimText(item.title, 240)}${item.note ? `：${trimText(item.note, 240)}` : ""}`
      ),
      "- 暂无未完成计划"
    ),
    "",
    "未完成验收：",
    ...listOrFallback(
      assessment.missingAcceptance.map((item) => `- ${trimText(item.title, 240)}`),
      "- 暂无未完成验收"
    ),
    "",
    "缺少证据的验收：",
    ...listOrFallback(
      assessment.acceptedWithoutEvidence.map((item) => `- ${trimText(item.title, 240)}`),
      "- 暂无缺证验收"
    ),
    "",
    "最近证据：",
    ...listOrFallback(
      input.snapshot.evidence
        .slice(-6)
        .map(
          (item) =>
            `- ${trimText(item.title, 240)}${item.detail ? `：${trimText(item.detail, 600)}` : ""}`
        ),
      "- 暂无证据"
    ),
    "",
    "最近变更：",
    ...listOrFallback(
      input.snapshot.changes
        .slice(-6)
        .map((item) => `- ${item.path} +${item.additions} -${item.deletions} ${item.state}`),
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
        .map(
          (item) =>
            `- ${trimText(item.title, 240)}：${item.state}${
              item.exitCode === undefined ? "" : `，exit=${item.exitCode ?? "null"}`
            }`
        ),
      "- 暂无后台任务"
    ),
    "",
    "披露问题：",
    ...listOrFallback(
      input.snapshot.disclosureIssues
        .slice(-6)
        .map((item) => `- ${trimText(item.title, 240)}：${trimText(item.suggestion, 360)}`),
      "- 暂无披露问题"
    ),
    "",
    "本轮事件摘要：",
    ...summarizeWorkbenchOrAgentEvents(input.events, input.workbenchEvents),
    "",
    "下一轮执行要求：",
    "- 先检查未完成验收和缺少证据的验收，再决定下一步。",
    "- 不要扩大任务范围，不要重复已经有证据支持的工作。",
    "- 如果需要证明质量，优先运行检查命令、读取关键文件或补充证据。",
    "- 如果目标已经完成，必须把计划、验收和证据更新到可审计状态后再结束。",
    "- 如果遇到阻塞或需要用户判断，暂停并说明原因。",
    "",
    "原始续跑指令：",
    trimText(input.decision.prompt ?? "", 4_000)
  ];
  return lines.join("\n");
}

function rollbackAdviceLines(snapshot: WorkbenchTaskSnapshot): string[] {
  if (snapshot.changes.length === 0) return ["- 暂无需要回退的变更"];
  return snapshot.changes.slice(-8).map((item) => {
    const checkpoint = item.checkpointId
      ? `可通过 checkpoint ${item.checkpointId} 回退`
      : "缺少 checkpoint，继续修改前应先补充检查点或重新读取确认";
    const review =
      item.state === "checked" ? "已检查" : item.state === "needs-review" ? "需要复查" : "仍是草稿";
    return `- ${item.path}：${checkpoint}，${review}`;
  });
}

function summarizeWorkbenchOrAgentEvents(
  agentEvents: AgentEvent[],
  workbenchEvents?: Array<{ type: string; message: string }>
): string[] {
  // 优先使用 workbench 事件（包含更丰富的领域信息）
  if (workbenchEvents && workbenchEvents.length > 0) {
    const recent = workbenchEvents.slice(-6);
    return recent.map((event) => `- ${event.type}：${trimText(event.message, 500)}`);
  }
  return summarizeAgentEvents(agentEvents);
}

function summarizeAgentEvents(events: AgentEvent[]): string[] {
  const recent = events.slice(-6);
  if (recent.length === 0) return ["- 暂无事件"];
  return recent.map((event) => {
    const text = extractEventSummaryText(event);
    return `- ${event.type}：${trimText(text, 500)}`;
  });
}

function extractEventSummaryText(event: AgentEvent): string {
  if ("error" in event && event.error) return String(event.error);
  if ("message" in event && typeof event.message === "string") return event.message;
  if ("reason" in event && event.reason) return String(event.reason);
  if ("summary" in event && typeof (event as { summary?: unknown }).summary === "string") return (event as { summary: string }).summary;
  return "";
}

function listOrFallback(items: string[], fallback: string): string[] {
  return items.length > 0 ? items : [fallback];
}

function trimText(text: string | undefined, maxChars: number): string {
  const normalized = (text ?? "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
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
