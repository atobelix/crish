/**
 * TokenTracker — Token 使用量追踪
 *
 * 从每次 API response 中提取 usage 信息并累积。
 * 为上下文压缩决策提供数据基础。
 *
 * 核心概念（参考 Codex CLI 的 BodyAfterPrefix）：
 * - sessionTotal: 当前会话所有 API 调用的总 token
 * - systemPromptTokens: 系统提示词 token（首次调用时记录）
 * - getEffectiveTokens(): sessionTotal - systemPromptTokens（不含系统提示词的"有效"token）
 * - getContextPressure(): 当前用量占模型上下文窗口的比例 (0-1)
 */

import type { ProviderUsage } from "../types";

// ─── 模型上下文配置 ────────────────────────────────────────

/**
 * 每个模型的上下文窗口配置。
 *
 * 这些 sweet spot 值来自工程实践的观察：
 * - 超过 sweetSpot 后模型性能开始下降
 * - 到达 criticalThreshold 时压缩变为必须
 * - reserveForResponse 预留给模型输出
 * - systemPromptOverhead 是系统提示词的估算开销
 */
export interface ModelContextProfile {
  model: string;
  /** 模型声明的最大上下文窗口 */
  contextWindow: number;
  /** 超过此值开始考虑压缩（性能最佳区间上界） */
  sweetSpot: number;
  /** 超过此值必须压缩（硬限制） */
  criticalThreshold: number;
  /** 预留给模型输出的 token 数 */
  reserveForResponse: number;
  /** 系统提示词估算开销（在首次调用后会被实际值覆盖） */
  systemPromptOverhead: number;
}

// ─── TokenTracker ───────────────────────────────────────────

export class TokenTracker {
  /** 当前会话 API 调用总 token */
  private sessionTotal = 0;

  /** 上轮输入 token */
  private _lastTurnInput = 0;

  /** 上轮输出 token */
  private _lastTurnOutput = 0;

  /** 系统提示词 token（首次调用时记录） */
  private _systemPromptTokens: number | null = null;

  /** 总 API 调用次数 */
  private callCount = 0;

  /** 会话开始时间 */
  private readonly sessionStartTime: number;

  /** 当前使用的模型标识 */
  private currentModel: string | null = null;

  /** 模型上下文配置 */
  private profile: ModelContextProfile | null = null;

  /** 系统提示词是否已在首次调用中记录 */
  private systemPromptRecorded = false;

  constructor() {
    this.sessionStartTime = Date.now();
  }

  // ── 属性访问器 ──────────────────────────────────────────

  get totalTokens(): number {
    return this.sessionTotal;
  }

  get lastTurnInput(): number {
    return this._lastTurnInput;
  }

  get lastTurnOutput(): number {
    return this._lastTurnOutput;
  }

  get systemPromptTokens(): number | null {
    return this._systemPromptTokens;
  }

  get totalCalls(): number {
    return this.callCount;
  }

  get sessionDurationMs(): number {
    return Date.now() - this.sessionStartTime;
  }

  get model(): string | null {
    return this.currentModel;
  }

  // ── 模型上下文配置 ──────────────────────────────────────

  /**
   * 设置当前模型及其上下文配置。
   *
   * 当模型切换时，系统提示词 token 需要重新记录（不同模型的 tokenizer 不同）。
   */
  setModel(model: string, profile: ModelContextProfile): void {
    if (this.currentModel !== model) {
      // 模型切换 → 重置系统提示词记录
      this.systemPromptRecorded = false;
      this._systemPromptTokens = null;
    }
    this.currentModel = model;
    this.profile = profile;
  }

  /**
   * 获取当前模型的上下文配置。
   */
  getProfile(): ModelContextProfile | null {
    return this.profile;
  }

  // ── Usage 记录 ───────────────────────────────────────────

  /**
   * 记录一次 API 调用的 usage 数据。
   *
   * 首次调用自动记录为系统提示词（包含完整系统提示词的 token 开销）。
   */
  record(usage: ProviderUsage): void {
    const inputTokens = (usage.promptTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const outputTokens = (usage.completionTokens ?? 0) + (usage.reasoningTokens ?? 0);
    const total = usage.totalTokens ?? (inputTokens + outputTokens);

    this._lastTurnInput = inputTokens;
    this._lastTurnOutput = outputTokens;
    this.sessionTotal += total;
    this.callCount++;

    // 首次调用记录系统提示词 token
    if (!this.systemPromptRecorded) {
      this._systemPromptTokens = inputTokens;
      this.systemPromptRecorded = true;

      // 同时更新 profile 中的 systemPromptOverhead（实际值比估算更准确）
      if (this.profile && inputTokens > 0) {
        this.profile.systemPromptOverhead = inputTokens;
      }
    }
  }

  // ── 上下文预算计算 ──────────────────────────────────────

  /**
   * 获取有效 token 数（不含系统提示词）。
   *
   * 参考 Codex CLI 的 BodyAfterPrefix 思路：
   * 系统提示词在整个会话中保持不变，计算上下文压力时应排除。
   */
  getEffectiveTokens(): number {
    const overhead = this._systemPromptTokens ?? 0;
    return Math.max(0, this.sessionTotal - overhead);
  }

  /**
   * 获取上下文压力指标 (0-1)。
   *
   * 0 = 空上下文，1 = 已满（或超出）。
   *
   * 计算方式：
   *   effectiveTokens / (contextWindow - reserveForResponse - systemPromptOverhead)
   *
   * 如果没有设置 model profile，返回 null。
   */
  getContextPressure(): number | null {
    if (!this.profile) return null;

    const available =
      this.profile.contextWindow -
      this.profile.reserveForResponse -
      this.profile.systemPromptOverhead;

    if (available <= 0) return 1;

    return Math.min(1, this.getEffectiveTokens() / available);
  }

  /**
   * 获取上下文预算状态。
   */
  getBudgetStatus(): BudgetStatus {
    const pressure = this.getContextPressure();
    if (pressure === null) return "unknown";
    if (pressure < 0.5) return "ample";
    if (pressure < 0.75) return "moderate";
    if (pressure < 0.9) return "tight";
    return "critical";
  }

  /**
   * 判断是否应该触发压缩。
   *
   * 触发条件：
   * - 上下文压力超过 sweetSpot 阈值
   */
  shouldCompact(): boolean {
    if (!this.profile) return false;
    const threshold =
      this.profile.contextWindow -
      this.profile.reserveForResponse -
      this.profile.systemPromptOverhead;
    return this.getEffectiveTokens() >= this.profile.sweetSpot ||
           this.sessionTotal >= threshold;
  }

  /**
   * 获取压缩阈值（token 数）。
   */
  getCompactionThreshold(): number | null {
    if (!this.profile) return null;

    return Math.min(
      this.profile.sweetSpot,
      this.profile.contextWindow -
        this.profile.reserveForResponse -
        this.profile.systemPromptOverhead
    );
  }

  // ── 快照 ─────────────────────────────────────────────────

  /**
   * 导出追踪器状态快照（用于持久化或诊断）。
   */
  dumpState(): TokenTrackerState {
    return {
      sessionTotal: this.sessionTotal,
      lastTurnInput: this._lastTurnInput,
      lastTurnOutput: this._lastTurnOutput,
      systemPromptTokens: this._systemPromptTokens,
      callCount: this.callCount,
      sessionStartTime: this.sessionStartTime,
      currentModel: this.currentModel,
      systemPromptRecorded: this.systemPromptRecorded,
    };
  }

  /**
   * 重置追踪器（新会话时调用）。
   */
  reset(): void {
    this.sessionTotal = 0;
    this._lastTurnInput = 0;
    this._lastTurnOutput = 0;
    this._systemPromptTokens = null;
    this.callCount = 0;
    this.systemPromptRecorded = false;
    // 保留 profile（模型配置在会话间不变）
  }
}

// ─── 类型 ──────────────────────────────────────────────────

export type BudgetStatus = "unknown" | "ample" | "moderate" | "tight" | "critical";

export interface TokenTrackerState {
  sessionTotal: number;
  lastTurnInput: number;
  lastTurnOutput: number;
  systemPromptTokens: number | null;
  callCount: number;
  sessionStartTime: number;
  currentModel: string | null;
  systemPromptRecorded: boolean;
}
