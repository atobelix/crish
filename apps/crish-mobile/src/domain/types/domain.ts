// 领域组合类型（M5 §1.3 组合纪律：契约类型 & 本地附加字段，禁止复制契约字段定义）
// 契约类型变化时组合类型自动继承，编译期暴露不匹配
// PermissionRequest 以引擎生成契约为准（generated/engine）：事件消费面（parseEngineEvent 产物）同源
import type { PermissionRequest } from '../../../../../packages/shared-types/src/generated/engine/types';
import type { ApprovalChannel } from '../../../../../packages/shared-types/src/generated/device/types';

// 审批条目本地附加的 riskMeta（对齐桌面 parseApprovalPayload 的 S9 宽容解析，F2 §2.2）
export interface ApprovalRiskMeta {
  /** C3 大面积回退影响面（permission.rs:135-151 revertGate 面积） */
  revertArea?: {
    fileCount?: number;
    lineCount?: number;
    crossDirectory?: boolean;
    refAgeSeconds?: number;
  };
  /** 删除影响面（payload 删除类工具） */
  deleteImpact?: { pathCount?: number; sizeBytes?: number };
  /** 抽取后的命令行（extractApprovalCommandArgs 对齐，F2 §2.2） */
  command?: string;
}

// 审批条目：shared-types 的 PermissionRequest 之上叠加移动端本地附加字段（F2 §3.3 信息模型）
export interface ApprovalItem {
  request: PermissionRequest;
  /** 信封 runId（实时预览帧可能缺失 → null） */
  runId: string | null;
  /** 子代理归属 run id（F2 §2.4 requesterRunId） */
  requesterRunId?: string;
  /** 子代理申请理由（F2 §2.4 reason） */
  reason?: string;
  /** 裁决者（metadata.arbiter；main-agent = 主 agent 裁决，移动端只读展示，F2 §2.6-5） */
  arbiter: 'user' | 'main-agent';
  /** 本地推导危险级别（F2 §2.2 表：L1 常规 / L2 高风险） */
  dangerLevel: 1 | 2;
  /** 风险元数据（对齐桌面 parseApprovalPayload，approvalHandlers.ts:50-54） */
  riskMeta?: ApprovalRiskMeta;
  /** 移动端收达时间 ms（F2 §3.3 requestedAt 对齐；对账时为引擎时间戳） */
  receivedAtMs: number;
  /** 过期时刻 ms = receivedAtMs + 120_000（F2 §2.6-3 本地倒计时兜底） */
  expiresAt: number;
  /** 业务状态（M5 §3.1 七态 + F2 §3.3 状态机） */
  status:
    | 'pending'
    | 'deciding'
    | 'queued'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'conflict';
  /** 终态决策值（approved | denied；expired 不进此字段） */
  decision?: 'approved' | 'denied';
  /** 决策发送通道状态机（idle→sending→sent/failed，任务书 R2-04；与 status 分离：发送通道 vs 业务态） */
  decisionStatus: 'idle' | 'sending' | 'sent' | 'failed';
  /** 决策发送时刻 ms（防双点 300ms 判定 + 历史渠道 'mobile' 判定） */
  decisionSentAtMs?: number;
  /** 防双点状态位（F2 §9.3-3 / R2UX-04-03；顶层 decisionBusy Record 的条目级镜像） */
  decisionBusy: boolean;
}

// 决策后审计回执记录（F2 §7 历史 / §7.1-3 决策渠道）
export interface ApprovalRecord {
  toolCallId: string;
  toolName: string;
  sessionId: string;
  runId: string | null;
  /** 决策（approved | denied | expired；expired 由本地倒计时/引擎补发产生） */
  decision: 'approved' | 'denied' | 'expired';
  /** 决策渠道：mobile（本机）/ desktop（其他设备）/ auto（自动过期） */
  channel: ApprovalChannel;
  /** 拒绝理由（deny 时可能有） */
  reason?: string;
  /** 决策落定时刻 ms */
  resolvedAtMs: number;
}
