import type { AgentEvent, AgentMessage } from "@crish/shared-types";
import type { ProviderUsage } from "@crish/agent-runtime";
import type { WorkbenchRunEvent, WorkbenchTokenBudgetSnapshot } from "../../shared/workbench-contract";
import type { WorkbenchRunBudgetDifficulty, WorkbenchRunBudgetSettings } from "../../shared/workbench-config";
import { resolveRunBudgetProfile } from "../../shared/workbench-config";
import { createRunEvent } from "../../shared/runtime-bridge";

export interface WorkbenchRunnerBudgetOptions {
  enabled: boolean | undefined;
  difficulty: WorkbenchRunBudgetDifficulty | undefined;
  maxTotalTokens: number | undefined;
  warnAtRatio: number | undefined;
}

export interface TokenBudgetUpdate {
  snapshot: WorkbenchTokenBudgetSnapshot | undefined;
  events: WorkbenchRunEvent[];
  reached: boolean;
}

export function createTokenBudgetTracker(
  settings: WorkbenchRunBudgetSettings,
  overrides: WorkbenchRunnerBudgetOptions = { enabled: undefined, difficulty: undefined, maxTotalTokens: undefined, warnAtRatio: undefined }
): TokenBudgetTracker {
  return new TokenBudgetTracker(settings, overrides);
}

export class TokenBudgetTracker {
  private readonly enabled: boolean;
  private readonly difficulty: WorkbenchRunBudgetDifficulty;
  private readonly maxTotalTokens: number;
  private readonly warnAtRatio: number;
  private usedTotalTokens = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private reasoningTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private requestCount = 0;
  private missingUsageMessages = 0;
  private warned = false;
  private reachedBudget = false;

  constructor(settings: WorkbenchRunBudgetSettings, overrides: WorkbenchRunnerBudgetOptions) {
    const profile = resolveRunBudgetProfile(settings, overrides.difficulty);
    this.enabled = overrides.enabled ?? settings.enabled;
    this.difficulty = overrides.difficulty ?? profile.difficulty;
    this.maxTotalTokens = positiveInteger(overrides.maxTotalTokens ?? profile.maxTotalTokens, profile.maxTotalTokens);
    this.warnAtRatio = clampRatio(overrides.warnAtRatio ?? settings.warnAtRatio);
  }

  get reached(): boolean {
    return this.reachedBudget;
  }

  snapshot(): WorkbenchTokenBudgetSnapshot {
    return {
      enabled: this.enabled,
      difficulty: this.difficulty,
      maxTotalTokens: this.maxTotalTokens,
      usedTotalTokens: this.usedTotalTokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      reasoningTokens: this.reasoningTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      requestCount: this.requestCount,
      missingUsageMessages: this.missingUsageMessages,
      warned: this.warned,
      reached: this.reachedBudget,
      updatedAt: new Date().toISOString()
    };
  }

  recordAgentEvent(agentEvent: AgentEvent): TokenBudgetUpdate {
    if (!this.enabled || agentEvent.type !== "message-end" || agentEvent.message.role !== "assistant") {
      return { snapshot: undefined, events: [], reached: this.reachedBudget };
    }

    this.requestCount += 1;
    const usage = usageFromMessage(agentEvent.message);
    if (!usage) {
      this.missingUsageMessages += 1;
      return { snapshot: this.snapshot(), events: [], reached: this.reachedBudget };
    }

    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.usedTotalTokens += usageTotalTokens(usage);

    const events: WorkbenchRunEvent[] = [];
    if (!this.warned && this.usedTotalTokens >= this.maxTotalTokens * this.warnAtRatio) {
      this.warned = true;
      events.push(
        createRunEvent("health-update", "\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97\u63a5\u8fd1\u4e0a\u9650", {
          tokenBudget: this.snapshot()
        })
      );
    }

    if (!this.reachedBudget && this.usedTotalTokens >= this.maxTotalTokens) {
      this.reachedBudget = true;
      events.push(
        createRunEvent("progress-update", "\u5355\u6b21\u4efb\u52a1 token \u9884\u7b97\u5df2\u7528\u5b8c\uff0c\u672c\u8f6e\u5c06\u5b89\u5168\u505c\u6b62", {
          tokenBudget: this.snapshot()
        })
      );
    }

    return {
      snapshot: this.snapshot(),
      events,
      reached: this.reachedBudget
    };
  }
}

export function usageFromMessage(message: AgentMessage): ProviderUsage | undefined {
  const usage = message.metadata?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const parsed: ProviderUsage = {
    ...(numberField(record.promptTokens) !== undefined ? { promptTokens: numberField(record.promptTokens)! } : {}),
    ...(numberField(record.completionTokens) !== undefined ? { completionTokens: numberField(record.completionTokens)! } : {}),
    ...(numberField(record.totalTokens) !== undefined ? { totalTokens: numberField(record.totalTokens)! } : {}),
    ...(numberField(record.cacheReadTokens) !== undefined ? { cacheReadTokens: numberField(record.cacheReadTokens)! } : {}),
    ...(numberField(record.cacheWriteTokens) !== undefined ? { cacheWriteTokens: numberField(record.cacheWriteTokens)! } : {}),
    ...(numberField(record.reasoningTokens) !== undefined ? { reasoningTokens: numberField(record.reasoningTokens)! } : {})
  };
  return Object.values(parsed).some((value) => value !== undefined) ? parsed : undefined;
}

export function usageTotalTokens(usage: ProviderUsage): number {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  return prompt + completion + (completion > 0 ? 0 : reasoning);
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(1, Math.max(0.1, value));
}
