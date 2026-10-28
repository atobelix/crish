/**
 * 审批风险元数据解析（从 approvalMeta 拆分）。
 */

import {
  type ApprovalRiskLevel,
  type ApprovalRiskMeta,
  type ApprovalRiskSource,
} from './approvalMetaTypes';
import {
  asRecord,
  firstString,
  firstBoolean,
  normalizeTrustZone,
  normalizeRiskLevel,
  levelFromZone,
  isHardlineRisk,
} from './approvalMetaNormalize';

// ─── 解析 ───────────────────────────────────────────────────────────────────

/**
 * 从 approval-requested 事件（扁平或 nested request/metadata）解析风险展示。
 * null/非对象/空对象 → 空 meta（source unknown）；永不抛。
 */
export function parseApprovalRiskMeta(event: unknown): ApprovalRiskMeta {
  const root = asRecord(event) ?? {};
  const nestedReq = asRecord(root.request) ?? {};
  const nestedMeta =
    asRecord(root.metadata) ?? asRecord(nestedReq.metadata) ?? {};

  const trustZone = normalizeTrustZone(
    firstString(nestedMeta.trustZone, root.trustZone, nestedReq.trustZone)
  );
  const risk = firstString(root.risk, nestedMeta.risk, nestedReq.risk);
  const riskReason = firstString(
    root.riskReason,
    root.reason,
    nestedMeta.reason,
    nestedMeta.riskReason,
    nestedReq.riskReason,
    nestedReq.summary
  );

  const explicitDouble = firstBoolean(
    root.requiresDoubleConfirm,
    nestedMeta.requiresDoubleConfirm,
    nestedReq.requiresDoubleConfirm
  );
  const explicitSnap = firstBoolean(
    root.recommendSnapshot,
    nestedMeta.recommendSnapshot,
    nestedReq.recommendSnapshot
  );
  const hardlineFlag =
    nestedMeta.hardline === true ||
    root.hardline === true ||
    nestedReq.hardline === true;
  const hardline = isHardlineRisk(risk, trustZone, hardlineFlag);

  const explicitLevel = normalizeRiskLevel(
    root.riskLevel ?? nestedMeta.riskLevel ?? nestedReq.riskLevel
  );
  const derivedLevel = levelFromZone(trustZone);
  const riskLevel: ApprovalRiskLevel =
    explicitLevel ?? derivedLevel ?? (hardline ? 'critical' : 'unknown');

  const hasBackend =
    Boolean(trustZone) ||
    Boolean(risk) ||
    Boolean(riskReason) ||
    explicitDouble !== undefined ||
    explicitSnap !== undefined ||
    explicitLevel !== undefined ||
    nestedMeta.hardline === true ||
    root.hardline === true;

  // 仅由 zone/hardline 推导等级、无显式 level 时标 derived；有 backend 字段仍为 backend
  const source: ApprovalRiskSource = hasBackend
    ? 'backend'
    : hardline || derivedLevel
      ? 'derived'
      : 'unknown';

  const requiresDoubleConfirm =
    explicitDouble !== undefined
      ? explicitDouble
      : Boolean(
          hardline ||
          trustZone === 'T3' ||
          trustZone === 'T4' ||
          riskLevel === 'high' ||
          riskLevel === 'critical'
        );

  const recommendSnapshot =
    explicitSnap !== undefined
      ? explicitSnap
      : Boolean(
          trustZone === 'T1' ||
          trustZone === 'T3' ||
          trustZone === 'T4' ||
          hardline
        );

  return {
    ...(trustZone ? { trustZone } : {}),
    ...(risk ? { risk } : {}),
    ...(riskReason ? { riskReason } : {}),
    riskLevel,
    requiresDoubleConfirm: Boolean(requiresDoubleConfirm),
    recommendSnapshot: Boolean(recommendSnapshot),
    source,
    ...(Object.keys(nestedMeta).length > 0 ? { metadata: nestedMeta } : {}),
  };
}
