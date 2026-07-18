import type { AgentEvent, AgentMessage } from "@crish/shared-types";
import type {
  GoalContinuationDecision,
  GoalLoopStrategy,
  GoalRoundAssessment,
  OrchestratorGoalRunState,
  OrchestratorRunRecord,
  OrchestratorSessionRecord,
  ProviderErrorResult
} from "./types";

export { assessGoalRound, goalContinuationDecisionFromAssessment } from "./task-assessment";
import { assessGoalRound, goalContinuationDecisionFromAssessment } from "./task-assessment";

/**
 * 内置的 Goal 循环策略：基于 AgentEvent 流扫描。
 *
 * 评估轮次结果时使用 `assessGoalRound`（检查事件流中的结构化标记、
 * 终止状态、工具错误等），进度签名来自事件事实的 FNV-1a 哈希。
 *
 * 这是 orchestrator 的默认策略，适用于不需要领域感知（计划/验收/证据）
 * 的通用场景。workbench 可提供 SnapshotAwareGoalStrategy 获得更丰富的
 * 延续决策能力。
 */
export class EventScanGoalStrategy implements GoalLoopStrategy {
  readonly name = "event-scan";

  // 显式声明接口中的可选方法，确保联合类型 GoalLoopStrategy | EventScanGoalStrategy
  // 下仍可安全访问这些属性（TypeScript 类型缩窄需要）。
  buildNextRoundPrompt?: GoalLoopStrategy["buildNextRoundPrompt"];
  handleProviderError?: GoalLoopStrategy["handleProviderError"];
  onRoundEvent?: GoalLoopStrategy["onRoundEvent"];

  assessRound(input: {
    run: OrchestratorRunRecord;
    session: OrchestratorSessionRecord;
    roundIndex: number;
    prompt: string | AgentMessage;
    events: AgentEvent[];
  }): GoalContinuationDecision {
    const assessment = assessGoalRound({
      run: input.run,
      roundIndex: input.roundIndex,
      events: input.events
    });
    return goalContinuationDecisionFromAssessment(assessment);
  }

  computeProgressSignature(input: {
    decision: GoalContinuationDecision;
    events: AgentEvent[];
  }): string {
    // 优先使用 decision 中已经携带的签名（来自 assessGoalRound）
    if (input.decision.progressSignature) {
      return input.decision.progressSignature;
    }
    // 否则重新评估事件流以提取签名
    const assessment = assessGoalRound({
      run: { status: "running" } as OrchestratorRunRecord,
      roundIndex: 0,
      events: input.events
    });
    return assessment.progress.signature;
  }
}

// ── Provider 容错辅助函数 ────────────────────────────────────────

const RATE_LIMIT_PATTERN = /\b429\b|too many requests|rate[_ -]?limit/i;
const TRANSIENT_NETWORK_PATTERNS = [
  /gateway-challenge|cloudflare|just a moment|cf_chl|challenge-platform/i,
  /tls handshake eof|fetch failed|connection reset|econnreset|etimedout|socket hang up|network\s+error/i,
];
const TRANSIENT_RUST_REQWEST_PATTERN = /rust reqwest fallback failed|rust reqwest transport exited/i;
const TRANSIENT_RUST_REQWEST_CONTEXT = /http request failed|connect|connection|tls/i;

/**
 * 从 AgentEvent 流中检测 Provider 限频（429）事件。
 * 返回限频原因字符串，未检测到则返回 undefined。
 */
export function detectProviderRateLimit(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const text = extractEventText(events[i]);
    if (RATE_LIMIT_PATTERN.test(text)) {
      return trimReason(text || "429 Too Many Requests", 300);
    }
  }
  return undefined;
}

/**
 * 从 AgentEvent 流中检测瞬态网络错误（Cloudflare challenge、TLS 中断、连接重置等）。
 * 返回错误原因字符串，未检测到则返回 undefined。
 */
export function detectTransientNetworkError(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "runtime-error" && event.type !== "provider-diagnostic") continue;
    const text = extractEventText(event);
    if (TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(text))) {
      return trimReason(text || "transient provider network error", 500);
    }
    if (TRANSIENT_RUST_REQWEST_PATTERN.test(text) && TRANSIENT_RUST_REQWEST_CONTEXT.test(text)) {
      return trimReason(text, 500);
    }
  }
  return undefined;
}

/**
 * 从 AgentEvent 流中检测致命运行错误（排除限频和瞬态网络错误）。
 * 返回错误原因字符串，未检测到则返回 undefined。
 */
export function detectFatalRuntimeError(events: AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "runtime-error") continue;
    const text = extractEventText(event);
    if (RATE_LIMIT_PATTERN.test(text)) continue;
    if (TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(text))) continue;
    if (TRANSIENT_RUST_REQWEST_PATTERN.test(text) && TRANSIENT_RUST_REQWEST_CONTEXT.test(text)) continue;
    return trimReason(text || "run failed", 500);
  }
  return undefined;
}

/**
 * 构建默认的 Provider 容错处理逻辑。
 * 供 driveGoalRun 在策略未提供 handleProviderError 时使用。
 */
export function createDefaultProviderErrorHandler(options: {
  maxTransientErrors: number;
  backoffMs: number;
}): (input: {
  events: AgentEvent[];
  roundIndex: number;
  consecutiveTransientErrors: number;
}) => ProviderErrorResult | undefined {
  return (input) => {
    const rateLimit = detectProviderRateLimit(input.events);
    if (rateLimit) {
      return {
        action: "backoff",
        reason: `Provider rate limited; backing off before retry: ${rateLimit}`,
        backoffMs: options.backoffMs,
        countAsProductive: false
      };
    }

    const transientError = detectTransientNetworkError(input.events);
    if (transientError) {
      if (input.consecutiveTransientErrors >= options.maxTransientErrors) {
        return {
          action: "fatal",
          reason: `Provider network remained unstable after ${input.consecutiveTransientErrors} transient failures: ${transientError}`
        };
      }
      return {
        action: "backoff",
        reason: `Provider network issue; backing off before retry (${input.consecutiveTransientErrors + 1}/${options.maxTransientErrors}): ${transientError}`,
        backoffMs: Math.min(options.backoffMs, 30_000),
        countAsProductive: false
      };
    }

    const fatal = detectFatalRuntimeError(input.events);
    if (fatal) {
      return { action: "fatal", reason: fatal };
    }

    return undefined;
  };
}

// ── 内部辅助 ─────────────────────────────────────────────────

function extractEventText(event: AgentEvent): string {
  const parts: string[] = [event.type];
  if ("error" in event && event.error) parts.push(String(event.error));
  if ("message" in event && event.message) parts.push(String(event.message));
  if ("reason" in event && event.reason) parts.push(String(event.reason));
  if ("diagnostic" in event) {
    const diag = (event as { diagnostic?: { message?: string } }).diagnostic;
    if (diag?.message) parts.push(diag.message);
  }
  return parts.join("\n");
}

function trimReason(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}
