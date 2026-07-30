/**
 * provider-transport — Provider 传输层
 *
 * 为 agent-runtime 提供可靠的 provider 通信基础。
 *
 * 模块：
 * - ConnectionManager: 传输选择 + 历史学习
 * - StreamRecovery:     流中断恢复 + 孤儿 tool_use 合成
 * - TokenTracker:       从 API response 提取 usage 并累积
 *
 * 设计原则（来自 Claude Code / Codex CLI / pi-agent-core 三框架对比）：
 * - 不重试同一种连接（每次换通道）
 * - 传输切换对上层透明
 * - 历史学习基于滑动窗口
 * - 错误走带内结果（优雅降级，不抛异常）
 */

export {
  ConnectionManager,
  ConnectionError,
  StreamInterruptedError,
  type ProviderTransport,
  type TransportKind,
  type TransportStatsSnapshot,
  type ConnectionManagerSnapshot,
} from './connection-manager';

export {
  StreamRecovery,
  StreamRecoveryError,
  synthesizeOrphanedToolResults,
  synthesizeOrphansFromPending,
  type StreamAccumulator,
  type PendingToolCall,
  type StreamDiagnostic,
  type RecoveryAction,
  type RecoveryDecision,
} from './stream-recovery';

export {
  TokenTracker,
  type ModelContextProfile,
  type BudgetStatus,
  type TokenTrackerState,
} from './token-tracker';
