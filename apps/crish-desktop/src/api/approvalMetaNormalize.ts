/**
 * 审批风险元数据规范化纯函数（从 approvalMeta 拆分）。
 * 含内部工具、文本/信任域/等级规范化、空元数据守卫、coerce。
 */

import {
  type ApprovalRiskLevel,
  type ApprovalRiskMeta,
  type ApprovalRiskSource,
  type ApprovalTrustZone,
  APPROVAL_TRUST_ZONES,
  APPROVAL_TRUST_ZONE_HINTS,
  APPROVAL_RISK_LEVEL_LABELS,
  APPROVAL_RISK_LEVEL_HINTS,
  RISK_KIND_LABELS,
} from './approvalMetaTypes';

// ─── 内部工具 ───────────────────────────────────────────────────────────────

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function firstBoolean(...vals: unknown[]): boolean | undefined {
  for (const v of vals) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/** 将任意输入收成字符串；null/undefined/非字符串 → '' */
export function coerceMetaText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }
  return '';
}

/**
 * 规范化信任域：trim + 大写；空白/非字符串 → undefined。
 * 保留未知代码（如 CUSTOM）以便透传展示，仅规范大小写。
 */
export function normalizeTrustZone(v: unknown): string | undefined {
  const s = coerceMetaText(v).trim().toUpperCase();
  return s || undefined;
}

/** 是否为已知 T0–T4 信任域 */
export function isKnownTrustZone(v: unknown): v is ApprovalTrustZone {
  const z = normalizeTrustZone(v);
  return (APPROVAL_TRUST_ZONES as readonly string[]).includes(z ?? '');
}

export function levelFromZone(zone: string | undefined): ApprovalRiskLevel | undefined {
  if (!zone) return undefined;
  switch (zone.toUpperCase()) {
    case 'T0':
      return 'low';
    case 'T1':
    case 'T2':
      return 'medium';
    case 'T3':
      return 'high';
    case 'T4':
      return 'critical';
    default:
      return undefined;
  }
}

/** 规范化风险等级（大小写/空白不敏感） */
export function normalizeRiskLevel(v: unknown): ApprovalRiskLevel | undefined {
  if (typeof v !== 'string') {
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'critical' || v === 'unknown') {
      return v;
    }
    return undefined;
  }
  const s = v.trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical' || s === 'unknown') {
    return s;
  }
  return undefined;
}

export function isHardlineRisk(risk: string | undefined, trustZone: string | undefined, hardlineFlag: unknown): boolean {
  if (hardlineFlag === true) return true;
  if (trustZone === 'T4') return true;
  if (risk && risk.trim().toLowerCase() === 'hardline') return true;
  return false;
}

// ─── 空元数据守卫 ───────────────────────────────────────────────────────────

/**
 * 是否缺少可展示的后端风险事实。
 * null/undefined → true；仅 unknown 默认字段且无 zone/risk/reason/标志 → true。
 */
export function isEmptyApprovalRiskMeta(
  meta: ApprovalRiskMeta | null | undefined,
): boolean {
  if (meta == null) return true;
  if (firstString(meta.trustZone)) return false;
  if (firstString(meta.risk)) return false;
  if (firstString(meta.riskReason)) return false;
  if (meta.requiresDoubleConfirm === true) return false;
  if (meta.recommendSnapshot === true) return false;
  const level = normalizeRiskLevel(meta.riskLevel) ?? 'unknown';
  if (level !== 'unknown') return false;
  // source 单独为 backend/derived 但无任何字段时仍视为空（防脏数据）
  return true;
}

/** isEmptyApprovalRiskMeta 的反义：有可展示事实 */
export function hasApprovalRiskFacts(
  meta: ApprovalRiskMeta | null | undefined,
): boolean {
  return !isEmptyApprovalRiskMeta(meta);
}

/**
 * 将 partial / store MessageToolApprovalMeta / null 收成完整 ApprovalRiskMeta。
 * 永不抛；null → EMPTY 克隆。
 */
export function coerceApprovalRiskMeta(
  input: Partial<ApprovalRiskMeta> | null | undefined,
): ApprovalRiskMeta {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      riskLevel: 'unknown',
      requiresDoubleConfirm: false,
      recommendSnapshot: false,
      source: 'unknown',
    };
  }
  const trustZone = normalizeTrustZone(input.trustZone);
  const risk = firstString(input.risk);
  const riskReason = firstString(input.riskReason);
  const riskLevel = normalizeRiskLevel(input.riskLevel) ?? 'unknown';
  const source: ApprovalRiskSource =
    input.source === 'backend' || input.source === 'derived' || input.source === 'unknown'
      ? input.source
      : 'unknown';
  return {
    ...(trustZone ? { trustZone } : {}),
    ...(risk ? { risk } : {}),
    ...(riskReason ? { riskReason } : {}),
    riskLevel,
    requiresDoubleConfirm: Boolean(input.requiresDoubleConfirm),
    recommendSnapshot: Boolean(input.recommendSnapshot),
    source,
  };
}

// 导出 types 子模块的标签/说明常量，供 labels 子模块与 hub 复用（避免 labels 重复依赖 types）
export {
  APPROVAL_TRUST_ZONE_HINTS,
  APPROVAL_RISK_LEVEL_LABELS,
  APPROVAL_RISK_LEVEL_HINTS,
  RISK_KIND_LABELS,
};
