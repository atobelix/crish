/**
 * 安全审计事件数据源（I3-S9 任务 4；I2-S8 事件面已交付）。
 *
 * `security-audit` 事件（EngineSecurityAuditEvent）经 dispatch 注册的
 * handler 写入本 store，SecurityAuditSection / RuntimePanel 订阅消费——
 * 事件 → store → 组件 链路，components 域外保持单一数据源
 * （与 cacheEventsStore 同模式）。
 *
 * 语义：
 * - entries 为最近 [MAX_AUDIT_ENTRIES] 条（20），超限丢弃最旧；
 * - 无事件 → entries 空数组 → 区段空态（隐藏而非展示噪音）；
 * - 事件 payload（operation/decision/targets/impact）宽容透传。
 */
import { create } from 'zustand';
import type { ImpactAssessment } from '../../../../../../packages/shared-types/src/generated/engine';

/** 审计条目（security-audit 事件归一形态） */
export interface SecurityAuditEntry {
  sessionId: string;
  /** 事件时间戳（ISO8601 字符串，原样保留） */
  timestamp: string;
  /** 操作类别：delete / trash-restore / trash-purge / git-revert / command-exec */
  operation: string;
  /** 处置决策：blocked / approved / denied / redirected / restored / purged */
  decision: string;
  /** 目标路径清单 */
  targets: string[];
  /** 影响面（文件数/大小/跨目录/谨慎标记） */
  impact: ImpactAssessment;
  permissionMode?: string;
  toolCallId?: string;
  /** 事件到达本 store 的本地时间（epoch ms，展示排序） */
  receivedAt: number;
}

export const MAX_AUDIT_ENTRIES = 20;

interface SecurityAuditState {
  entries: SecurityAuditEntry[];
  /** security-audit 事件入列（超限丢弃最旧） */
  push: (entry: Omit<SecurityAuditEntry, 'receivedAt'>) => void;
  /** 清空（测试 / 手动重置用） */
  reset: () => void;
}

export const useSecurityAuditStore = create<SecurityAuditState>((set) => ({
  entries: [],

  push: (entry) =>
    set((state) => ({
      entries: [...state.entries, { ...entry, receivedAt: Date.now() }].slice(
        -MAX_AUDIT_ENTRIES
      ),
    })),

  reset: () => set({ entries: [] }),
}));

/** 操作类别 → 中文短标签（未知原样返回） */
const OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  delete: '删除',
  'trash-restore': '恢复',
  'trash-purge': '清除',
  'git-revert': '回退',
  'command-exec': '命令执行',
});

/** 处置决策 → 中文短标签（未知原样返回） */
const DECISION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  blocked: '已拦截',
  approved: '已批准',
  denied: '已拒绝',
  redirected: '已重定向',
  restored: '已恢复',
  purged: '已清除',
});

/** 操作中文标签 */
export function auditOperationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

/** 决策中文标签 */
export function auditDecisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? decision;
}

/** 审计条目展示摘要（操作 · 决策 · 目标数 · 影响文件数） */
export function auditEntrySummary(entry: SecurityAuditEntry): string {
  const parts = [
    auditOperationLabel(entry.operation),
    auditDecisionLabel(entry.decision),
  ];
  if (entry.targets.length > 0) {
    parts.push(
      entry.targets.length === 1
        ? entry.targets[0]!
        : `${entry.targets.length} 个目标`
    );
  }
  if (entry.impact?.fileCount != null && entry.impact.fileCount > 0) {
    parts.push(`${entry.impact.fileCount} 个文件`);
  }
  return parts.join(' · ');
}
