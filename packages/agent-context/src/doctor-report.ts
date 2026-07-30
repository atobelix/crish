import type {
  StreamRecoveryGlobalStats,
  TokenLedgerStats,
} from '@crish/shared-types';

/** 无 agent-end 事件超过此毫秒数则视为 orphaned */
const ORPHANED_THRESHOLD_MS = 5 * 60 * 1000;

export interface DoctorReport {
  timestamp: number;
  providers: Array<{ id: string; status: string; latencyMs: number }>;
  cachePerformance: { hitRate: number; toolsSchemaHash: string };
  streamRecovery: StreamRecoveryGlobalStats;
  subagents: { total: number; orphaned: number; active: number };
  tokenBudget: { totalCost: number; cacheHitRatio: number };
}

export interface DoctorReportDeps {
  tokenLedger: TokenLedgerStats;
  toolsSchemaHash: string;
  providerId: string;
  activeSubagentCount: number;
  totalSubagentCount: number;
  lastSubagentEndTimestamp: number;
  streamRecoveryStats: StreamRecoveryGlobalStats;
}

export class DoctorReportBuilder {
  static build(deps: DoctorReportDeps): DoctorReport {
    const now = Date.now();

    const providers = [
      { id: deps.providerId, status: 'healthy', latencyMs: 0 },
    ];

    const cacheHitRatio = deps.tokenLedger.getCacheHitRatio();
    const totalCost = deps.tokenLedger.getTotalCost();
    const streamRecovery = deps.streamRecoveryStats;

    // orphaned 判定：有活跃 subagent 但长时间无 agent-end 事件
    const orphanedCount =
      deps.activeSubagentCount > 0 && deps.lastSubagentEndTimestamp > 0
        ? now - deps.lastSubagentEndTimestamp > ORPHANED_THRESHOLD_MS
          ? deps.activeSubagentCount
          : 0
        : 0;

    return {
      timestamp: now,
      providers,
      cachePerformance: {
        hitRate: cacheHitRatio,
        toolsSchemaHash: deps.toolsSchemaHash,
      },
      streamRecovery,
      subagents: {
        total: deps.totalSubagentCount,
        orphaned: orphanedCount,
        active: deps.activeSubagentCount,
      },
      tokenBudget: {
        totalCost,
        cacheHitRatio,
      },
    };
  }
}
