/**
 * 运行时辅助类型（从 agent-runtime 下沉的纯类型）
 *
 * 这些类型被 agent-context 用于依赖注入或诊断报告，通过下沉到 shared-types
 * 避免跨层引用 agent-runtime。仅下沉类型闭包，运行时实现仍保留在 agent-runtime。
 */

// 从 agent-runtime/provider-transport/stream-recovery.ts 下沉
export interface StreamRecoveryGlobalStats {
  activeRecoveries: number;
  totalRecoveries: number;
  totalRetries: number;
  totalSynthesizedOrphans: number;
}

// 从 agent-runtime/token-ledger.ts 下沉：TokenLedger 的结构性统计接口。
// agent-runtime 未导出独立的 TokenLedgerStats 命名类型，而 agent-context
// 的 doctor-report.ts 通过依赖注入接收 TokenLedger 实例并调用其方法，
// 故按实际使用的方法签名定义此结构性接口（TokenLedger 类结构上满足此类型）。
// 这与 session-store 中 SessionBranchMachineLike 的结构性注入模式一致。
export interface TokenLedgerStats {
  getTotalCost(): number;
  getCacheHitRatio(): number;
}

// 从 agent-runtime/state-machine/session-branch.ts 下沉
export type SessionBranchState =
  'active' | 'suspended' | 'abandoned' | 'restored';
