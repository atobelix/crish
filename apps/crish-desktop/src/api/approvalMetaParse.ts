/**
 * 审批风险元数据解析（从 approvalMeta 拆分）。
 * 含 approval-requested 事件解析与白名单前缀记忆。
 */

import { type ApprovalRiskLevel, type ApprovalRiskMeta, type ApprovalRiskSource } from './approvalMetaTypes';
import {
  asRecord,
  firstString,
  firstBoolean,
  coerceMetaText,
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
    asRecord(root.metadata) ??
    asRecord(nestedReq.metadata) ??
    {};

  const trustZone = normalizeTrustZone(
    firstString(nestedMeta.trustZone, root.trustZone, nestedReq.trustZone),
  );
  const risk = firstString(root.risk, nestedMeta.risk, nestedReq.risk);
  const riskReason = firstString(
    root.riskReason,
    root.reason,
    nestedMeta.reason,
    nestedMeta.riskReason,
    nestedReq.riskReason,
    nestedReq.summary,
  );

  const explicitDouble = firstBoolean(
    root.requiresDoubleConfirm,
    nestedMeta.requiresDoubleConfirm,
    nestedReq.requiresDoubleConfirm,
  );
  const explicitSnap = firstBoolean(
    root.recommendSnapshot,
    nestedMeta.recommendSnapshot,
    nestedReq.recommendSnapshot,
  );
  const hardlineFlag =
    nestedMeta.hardline === true ||
    root.hardline === true ||
    nestedReq.hardline === true;
  const hardline = isHardlineRisk(risk, trustZone, hardlineFlag);

  const explicitLevel = normalizeRiskLevel(
    root.riskLevel ?? nestedMeta.riskLevel ?? nestedReq.riskLevel,
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
            riskLevel === 'critical',
        );

  const recommendSnapshot =
    explicitSnap !== undefined
      ? explicitSnap
      : Boolean(
          trustZone === 'T1' ||
            trustZone === 'T3' ||
            trustZone === 'T4' ||
            hardline,
        );

  return {
    ...(trustZone ? { trustZone } : {}),
    ...(risk ? { risk } : {}),
    ...(riskReason ? { riskReason } : {}),
    riskLevel,
    requiresDoubleConfirm: Boolean(requiresDoubleConfirm),
    recommendSnapshot: Boolean(recommendSnapshot),
    source,
  };
}

// ─── 白名单前缀 ─────────────────────────────────────────────────────────────

/** 从工具参数提取可记忆的命令前缀（最多 3 token；与白名单 token 边界一致） */
export function rememberPrefixFromToolArgs(
  toolName: string,
  args: string,
  extractCommand: (toolName: string, args: string) => string,
): string {
  const name = coerceMetaText(toolName);
  const rawArgs = coerceMetaText(args);
  let raw = '';
  try {
    raw = extractCommand(name, rawArgs || '');
  } catch {
    return '';
  }
  raw = coerceMetaText(raw);
  // 与 commandPermissions.normalizeCommandLine 对齐：折叠空白、去 $
  const line = raw
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\$\s*/, '');
  if (!line) return '';
  // 拒绝整段 JSON / 数组字面量进白名单（无 token 边界语义）
  if (line.startsWith('{') || line.startsWith('[')) return '';
  // 拒绝明显的 shell 链式命令整段记忆（用户应只记首段安全前缀）
  const head = line.split(/\s+(?:&&|\|\||;|\|)\s+/)[0]?.trim() || line;
  const parts = head.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts.slice(0, Math.min(3, parts.length)).join(' ');
}
