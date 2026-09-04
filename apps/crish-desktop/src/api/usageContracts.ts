/**
 * 用量监控系统前端数据契约（Usage Contracts）
 * 严格对齐 Rust `conex-db::usage_analytics` 与 `usage_commands.rs` 的 camelCase 序列化。
 */

/** 6 项纯文字习惯与偏好指标 */
export interface UsageHeroStats {
  dailyAverageTokens: number;
  dailyAverageCost: number;
  totalMessages: number;
  topModel: string;
  peakActiveHourRange: string;
  topProject: string;
}

/** 连续时钟时序采样点 */
export interface UsageTimeseriesPoint {
  label: string;
  timestamp: number;
  input: number;
  output: number;
  cache: number;
  total: number;
  cost: number;
  modelTokens: Record<string, number>;
  modelCosts: Record<string, number>;
}

/** 4 维模型使用明细项 */
export interface UsageModelBreakdownItem {
  model: string;
  provider: string;
  tokens: number;
  percentage: number;
  cost: number;
  cacheRatio: number;
  callCount: number;
}

/** 用量仪表盘全景快照 DTO */
export interface UsageDashboardDto {
  range: string;
  hero: UsageHeroStats;
  points: UsageTimeseriesPoint[];
  maxTokens: number;
  maxCost: number;
  models: UsageModelBreakdownItem[];
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCost: number;
  updatedAt: number;
}

/** 活跃度矩阵热力图单元格 */
export interface ActivityMatrixCell {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  tokens: number;
  cost: number;
  calls: number;
  level: number; // 0 ~ 4
}

/** 活跃度矩阵热力图 DTO */
export interface ActivityMatrixDto {
  range: string;
  rows: string[];
  cols: string[];
  cells: ActivityMatrixCell[];
  maxTokens: number;
}

/** 增量单条用量上报入参 */
export interface UsageRecordDeltaInput {
  sessionId?: string;
  runId?: string;
  projectName?: string;
  model?: string;
  provider?: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costCny?: number;
  costUsd?: number;
  timestamp?: number;
}
