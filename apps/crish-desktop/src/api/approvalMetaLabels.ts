/**
 * 审批风险中文标签 / 文案 / badge / tone / 摘要纯函数（从 approvalMeta 拆分）。
 */

import {
  type ApprovalRiskMeta,
  type ApprovalRiskTone,
  type ApprovalTrustZone,
  APPROVAL_TRUST_ZONE_LABELS,
} from './approvalMetaTypes';
import {
  firstString,
  normalizeTrustZone,
  isKnownTrustZone,
  normalizeRiskLevel,
  isEmptyApprovalRiskMeta,
  APPROVAL_TRUST_ZONE_HINTS,
  APPROVAL_RISK_LEVEL_LABELS,
  APPROVAL_RISK_LEVEL_HINTS,
  RISK_KIND_LABELS,
} from './approvalMetaNormalize';

/** 信任域短标签；未知代码返回大写原文；空 → '' */
export function approvalTrustZoneLabel(zone: unknown): string {
  const z = normalizeTrustZone(zone);
  if (!z) return '';
  if (isKnownTrustZone(z)) return APPROVAL_TRUST_ZONE_LABELS[z as ApprovalTrustZone];
  return z;
}

/** 信任域说明；未知/空 → '' */
export function approvalTrustZoneHint(zone: unknown): string {
  const z = normalizeTrustZone(zone);
  if (!z || !isKnownTrustZone(z)) return '';
  return APPROVAL_TRUST_ZONE_HINTS[z as ApprovalTrustZone];
}

/** 风险等级短标签；非法 → 需确认 */
export function approvalRiskLevelLabel(level: unknown): string {
  const n = normalizeRiskLevel(level) ?? 'unknown';
  return APPROVAL_RISK_LEVEL_LABELS[n];
}

/** 风险等级说明；非法 → unknown 说明 */
export function approvalRiskLevelHint(level: unknown): string {
  const n = normalizeRiskLevel(level) ?? 'unknown';
  return APPROVAL_RISK_LEVEL_HINTS[n];
}

/**
 * risk 种类中文标签（hardline/destructive/…）；
 * 未知种类原样 trim 返回；空 → ''。
 */
export function approvalRiskKindLabel(risk: unknown): string {
  const raw = firstString(risk);
  if (!raw) return '';
  const key = raw.toLowerCase();
  return RISK_KIND_LABELS[key] ?? raw;
}

/**
 * 卡片顶部短风险徽章（中文）。
 * 优先信任域标签，其次 riskLevel；空 meta → 「需确认」。
 * medium 徽章保持历史文案「需确认」（与等级表「中风险」区分）。
 * 永不抛；null/undefined 安全。
 */
export function approvalRiskBadgeLabel(
  meta: ApprovalRiskMeta | null | undefined,
): string {
  if (meta == null) return APPROVAL_RISK_LEVEL_LABELS.unknown;
  if (meta.trustZone) {
    const z = normalizeTrustZone(meta.trustZone);
    // 已知域用中文短标签；未知域（如 CUSTOM）不误用为 badge，改走 level
    if (z && isKnownTrustZone(z)) {
      return APPROVAL_TRUST_ZONE_LABELS[z as ApprovalTrustZone];
    }
  }
  const level = normalizeRiskLevel(meta.riskLevel) ?? 'unknown';
  if (level === 'medium') return '需确认';
  return APPROVAL_RISK_LEVEL_LABELS[level];
}

/**
 * 状态行 zone 提示：`T3 · destructive` / `T3` / `destructive` / ''。
 * 空 meta → ''。
 */
export function approvalZoneHint(
  meta: ApprovalRiskMeta | null | undefined,
): string {
  if (meta == null) return '';
  const zone = normalizeTrustZone(meta.trustZone);
  const risk = firstString(meta.risk);
  if (zone && risk) return `${zone} · ${risk}`;
  if (zone) return zone;
  if (risk) return risk;
  return '';
}

/**
 * 风险 tone：供 badge / chip 着色。空 → neutral。
 * T4/critical/hardline → danger；T3/high → danger；T1/T2/medium → warn；T0/low → info。
 */
export function approvalRiskTone(
  meta: ApprovalRiskMeta | null | undefined,
): ApprovalRiskTone {
  if (meta == null || isEmptyApprovalRiskMeta(meta)) return 'neutral';
  const zone = normalizeTrustZone(meta.trustZone);
  const level = normalizeRiskLevel(meta.riskLevel) ?? 'unknown';
  const risk = (meta.risk || '').toLowerCase();
  if (
    zone === 'T4' ||
    level === 'critical' ||
    risk === 'hardline' ||
    meta.requiresDoubleConfirm
  ) {
    return 'danger';
  }
  if (zone === 'T3' || level === 'high') return 'danger';
  if (zone === 'T1' || zone === 'T2' || level === 'medium') return 'warn';
  if (zone === 'T0' || level === 'low') return 'info';
  return 'neutral';
}

/**
 * 一句话中文风险摘要（卡片副文案 / aria）。
 * 优先 riskReason；否则按 double-confirm / zone / level 生成稳定中文。
 */
export function approvalRiskSummary(
  meta: ApprovalRiskMeta | null | undefined,
): string {
  if (meta == null || isEmptyApprovalRiskMeta(meta)) {
    return '缺少后端风险元数据，请人工确认';
  }
  const reason = firstString(meta.riskReason);
  if (reason) return reason;

  if (meta.requiresDoubleConfirm) {
    // T4 / critical：二次确认与极危语义并存，摘要保留「极危」供卡片与测试契约识别
    if (meta.trustZone === 'T4' || meta.riskLevel === 'critical') {
      return meta.recommendSnapshot
        ? '极危操作，需二次确认；建议执行前创建快照'
        : '极危操作，需二次确认后才会执行';
    }
    return '高风险操作，需二次确认后才会执行';
  }

  const zoneHint = approvalTrustZoneHint(meta.trustZone);
  if (zoneHint) {
    if (meta.recommendSnapshot) {
      return `${zoneHint}；建议执行前创建快照`;
    }
    return zoneHint;
  }

  if (meta.recommendSnapshot) {
    return '建议执行前创建快照以便回滚';
  }

  const kind = approvalRiskKindLabel(meta.risk);
  if (kind && kind !== firstString(meta.risk)) {
    return `风险类型：${kind}`;
  }
  if (kind) {
    return `风险标记：${kind}`;
  }

  return approvalRiskLevelHint(meta.riskLevel);
}
