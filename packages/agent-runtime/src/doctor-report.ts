import type { TokenLedger } from "./token-ledger";
import { StreamRecoveryGlobalRegistry } from "./provider-transport/stream-recovery";
import type { StreamRecoveryGlobalStats } from "./provider-transport/stream-recovery";

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
  tokenLedger: TokenLedger;
  toolsSchemaHash: string;
  providerId: string;
  activeSubagentCount: number;
  totalSubagentCount: number;
  lastSubagentEndTimestamp: number;
}

export class DoctorReportBuilder {
  static build(deps: DoctorReportDeps): DoctorReport {
    const now = Date.now();

    const providers = [{ id: deps.providerId, status: "healthy", latencyMs: 0 }];

    const cacheHitRatio = deps.tokenLedger.getCacheHitRatio();
    const totalCost = deps.tokenLedger.getTotalCost();
    const streamRecovery = StreamRecoveryGlobalRegistry.getInstance().getGlobalStatsSync();

    // orphaned 判定：有活跃 subagent 但长时间无 agent-end 事件
    const orphanedCount =
      deps.activeSubagentCount > 0 && deps.lastSubagentEndTimestamp > 0
        ? (now - deps.lastSubagentEndTimestamp > ORPHANED_THRESHOLD_MS
            ? deps.activeSubagentCount
            : 0)
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
