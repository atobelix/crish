/**
 * 审批风险元数据（BE-04）：只展示后端事实，不按工具名猜风险。
 * 来源：daemon approval-requested 的 risk / riskReason / requiresDoubleConfirm /
 * recommendSnapshot / metadata.trustZone / metadata.riskLevel。
 *
 * 本模块为纯函数：标签、中文文案、空元数据守卫、事件解析、白名单前缀记忆。
 *
 * 实现按职责拆分到子模块，本文件作为 re-export hub 以保持消费方 import 路径不变：
 * - 类型与常量：./approvalMetaTypes
 * - 规范化 / 空守卫 / coerce：./approvalMetaNormalize
 * - 中文标签 / 文案 / badge / tone / 摘要：./approvalMetaLabels
 * - 事件解析 / 白名单前缀：./approvalMetaParse
 */

export {
  type ApprovalRiskLevel,
  type ApprovalRiskSource,
  type ApprovalRiskMeta,
  type ApprovalRiskTone,
  type ApprovalTrustZone,
  APPROVAL_TRUST_ZONES,
  APPROVAL_RISK_LEVELS,
  EMPTY_APPROVAL_RISK_META,
  APPROVAL_TRUST_ZONE_LABELS,
  APPROVAL_TRUST_ZONE_HINTS,
  APPROVAL_RISK_LEVEL_LABELS,
  APPROVAL_RISK_LEVEL_HINTS,
  RISK_KIND_LABELS,
} from './approvalMetaTypes';

export {
  coerceMetaText,
  normalizeTrustZone,
  isKnownTrustZone,
  normalizeRiskLevel,
  isEmptyApprovalRiskMeta,
  hasApprovalRiskFacts,
  coerceApprovalRiskMeta,
} from './approvalMetaNormalize';

export {
  approvalTrustZoneLabel,
  approvalTrustZoneHint,
  approvalRiskLevelLabel,
  approvalRiskLevelHint,
  approvalRiskKindLabel,
  approvalRiskBadgeLabel,
  approvalZoneHint,
  approvalRiskTone,
  approvalRiskSummary,
} from './approvalMetaLabels';

export { parseApprovalRiskMeta } from './approvalMetaParse';
