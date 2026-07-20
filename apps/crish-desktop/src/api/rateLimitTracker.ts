/**
 * Provider Rate Limits & Token Usage Cost Tracker
 * 
 * 职责：
 * - 借鉴 Orca (`rate-limits`) 与 Hermes (`claude-usage`) 计量架构
 * - 基于 1 分钟滑动窗口 (Sliding Window) 实时统计 RPM (Requests/min) 与 TPM (Tokens/min)
 * - 实时计算 KV Cache 命中率与估算消费金额 ($)
 * - 达到配额上限 80% 时自动触发健康告警
 */

export interface TokenUsageRecord {
  timestamp: number;
  profileId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  estimatedCostUsd: number;
}

export interface ProviderRateLimitMetrics {
  profileId: string;
  rpm: number; // 1 分钟内请求次数
  tpm: number; // 1 分钟内 Token 消耗量
  cacheHitTokens: number;
  totalTokens: number;
  cacheHitRate: number; // 缓存命中率 (0~100%)
  sessionCostUsd: number; // 当前会话累计消费金额 ($)
  isNearLimit: boolean; // 是否接近限流阈值 (>80%)
}

const usageRecords: TokenUsageRecord[] = [];
const SLIDING_WINDOW_MS = 60 * 1000; // 1 分钟滑动窗口

/** 估算常用模型每 1K Token 价格（美元） */
function estimateTokenCost(modelId: string, promptTokens: number, completionTokens: number, cacheHitTokens: number): number {
  const m = modelId.toLowerCase();
  let inputPricePer1k = 0.0015;
  let outputPricePer1k = 0.006;
  let cacheHitPricePer1k = 0.0003;

  if (m.includes('deepseek')) {
    inputPricePer1k = 0.00014;
    outputPricePer1k = 0.00028;
    cacheHitPricePer1k = 0.000014;
  } else if (m.includes('claude-3-7') || m.includes('sonnet')) {
    inputPricePer1k = 0.003;
    outputPricePer1k = 0.015;
    cacheHitPricePer1k = 0.0003;
  } else if (m.includes('gpt-4o')) {
    inputPricePer1k = 0.0025;
    outputPricePer1k = 0.010;
    cacheHitPricePer1k = 0.00125;
  }

  const promptMissTokens = Math.max(0, promptTokens - cacheHitTokens);
  const cost =
    (promptMissTokens / 1000) * inputPricePer1k +
    (cacheHitTokens / 1000) * cacheHitPricePer1k +
    (completionTokens / 1000) * outputPricePer1k;

  return Math.max(0, cost);
}

/** 记录一次模型调用的 Token 用量 */
export function recordRequestUsage(
  profileId: string,
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cacheHitTokens: number = 0,
): TokenUsageRecord {
  const now = Date.now();
  const cost = estimateTokenCost(modelId, promptTokens, completionTokens, cacheHitTokens);

  const record: TokenUsageRecord = {
    timestamp: now,
    profileId,
    modelId,
    promptTokens,
    completionTokens,
    cacheHitTokens,
    estimatedCostUsd: cost,
  };

  usageRecords.push(record);
  pruneExpiredRecords(now);
  return record;
}

/** 清理滑动窗口之外的历史记录 */
function pruneExpiredRecords(now: number): void {
  const cutoff = now - (SLIDING_WINDOW_MS * 30); // 保留最近 30 分钟历史用于统计
  while (usageRecords.length > 0 && usageRecords[0].timestamp < cutoff) {
    usageRecords.shift();
  }
}

/** 获取特定服务商的 RPM / TPM / 缓存命中率 / 消费统计 */
export function getProviderRateLimitMetrics(profileId: string, maxRpmLimit = 60, maxTpmLimit = 100_000): ProviderRateLimitMetrics {
  const now = Date.now();
  pruneExpiredRecords(now);

  const windowStart = now - SLIDING_WINDOW_MS;
  const recent = usageRecords.filter((r) => r.profileId === profileId && r.timestamp >= windowStart);

  let rpm = recent.length;
  let tpm = 0;
  let cacheHitTokens = 0;
  let totalTokens = 0;
  let sessionCostUsd = 0;

  for (const r of usageRecords.filter((rec) => rec.profileId === profileId)) {
    sessionCostUsd += r.estimatedCostUsd;
    if (r.timestamp >= windowStart) {
      const sum = r.promptTokens + r.completionTokens;
      tpm += sum;
      totalTokens += sum;
      cacheHitTokens += r.cacheHitTokens;
    }
  }

  const cacheHitRate = totalTokens > 0 ? Math.min(100, Math.round((cacheHitTokens / totalTokens) * 100)) : 0;
  const isNearLimit = rpm >= maxRpmLimit * 0.8 || tpm >= maxTpmLimit * 0.8;

  return {
    profileId,
    rpm,
    tpm,
    cacheHitTokens,
    totalTokens,
    cacheHitRate,
    sessionCostUsd,
    isNearLimit,
  };
}
