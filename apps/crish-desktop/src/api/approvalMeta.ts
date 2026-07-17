/**
 * 审批风险元数据（BE-04）：只展示后端事实，不按工具名猜风险。
 * 来源：daemon approval-requested 的 risk / riskReason / requiresDoubleConfirm /
 * recommendSnapshot / metadata.trustZone / metadata.riskLevel。
 *
 * 本模块为纯函数：标签、中文文案、空元数据守卫、事件解析、白名单前缀记忆。
 */

export type ApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type ApprovalRiskSource = 'backend' | 'derived' | 'unknown';

export type ApprovalRiskMeta = {
  trustZone?: string;
  risk?: string;
  riskReason?: string;
  riskLevel: ApprovalRiskLevel;
  requiresDoubleConfirm: boolean;
  recommendSnapshot: boolean;
  source: ApprovalRiskSource;
};

/** UI tone（卡片 badge / chip 着色契约） */
export type ApprovalRiskTone = 'neutral' | 'info' | 'warn' | 'danger';

/** 已知信任域代码（大写） */
export const APPROVAL_TRUST_ZONES = ['T0', 'T1', 'T2', 'T3', 'T4'] as const;
export type ApprovalTrustZone = (typeof APPROVAL_TRUST_ZONES)[number];

/** 风险等级枚举（展示顺序：低 → 高） */
export const APPROVAL_RISK_LEVELS: readonly ApprovalRiskLevel[] = [
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
] as const;

/**
 * 空/未知元数据常量。parse 无事实、coerce null 时回落至此。
 * 注意：对象可复用只读语义，调用方勿原地 mutate。
 */
export const EMPTY_APPROVAL_RISK_META: Readonly<ApprovalRiskMeta> = Object.freeze({
  riskLevel: 'unknown',
  requiresDoubleConfirm: false,
  recommendSnapshot: false,
  source: 'unknown',
});

/** 信任域短标签（中文；与卡片 badge 一致） */
export const APPROVAL_TRUST_ZONE_LABELS: Readonly<Record<ApprovalTrustZone, string>> =
  Object.freeze({
    T0: '只读',
    T1: '写操作',
    T2: '网络/进程',
    T3: '高风险',
    T4: '极危',
  });

/** 信任域说明（中文副文案） */
export const APPROVAL_TRUST_ZONE_HINTS: Readonly<Record<ApprovalTrustZone, string>> =
  Object.freeze({
    T0: '只读类操作，风险较低',
    T1: '可能修改工作区文件',
    T2: '可能访问网络或管理进程',
    T3: '高风险操作，通常需要确认',
    T4: '极危操作，禁止静默放行',
  });

/** 风险等级短标签（中文） */
export const APPROVAL_RISK_LEVEL_LABELS: Readonly<Record<ApprovalRiskLevel, string>> =
  Object.freeze({
    low: '低风险',
    medium: '中风险',
    high: '高风险',
    critical: '极危',
    unknown: '需确认',
  });

/** 风险等级说明（中文） */
export const APPROVAL_RISK_LEVEL_HINTS: Readonly<Record<ApprovalRiskLevel, string>> =
  Object.freeze({
    low: '风险较低，仍建议确认后再执行',
    medium: '中等风险，请确认意图后继续',
    high: '高风险操作，请仔细核对命令与影响范围',
    critical: '极危操作，需二次确认，禁止自动放行',
    unknown: '后端未给出明确风险等级，请人工确认',
  });

/** 常见 risk 种类 → 中文短标签（未知种类原样返回） */
const RISK_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  hardline: '极危硬线',
  destructive: '破坏性',
  secret: '敏感信息',
  external: '外发副作用',
  'external-side-effect': '外发副作用',
  network: '网络',
  write: '写操作',
  process: '进程',
  read: '只读',
  'read-only': '只读',
});

// ─── 内部工具 ───────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function firstBoolean(...vals: unknown[]): boolean | undefined {
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
  return z === 'T0' || z === 'T1' || z === 'T2' || z === 'T3' || z === 'T4';
}

function levelFromZone(zone: string | undefined): ApprovalRiskLevel | undefined {
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

function isHardlineRisk(risk: string | undefined, trustZone: string | undefined, hardlineFlag: unknown): boolean {
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

// ─── 中文标签 / 文案 ────────────────────────────────────────────────────────

/** 信任域短标签；未知代码返回大写原文；空 → '' */
export function approvalTrustZoneLabel(zone: unknown): string {
  const z = normalizeTrustZone(zone);
  if (!z) return '';
  if (isKnownTrustZone(z)) return APPROVAL_TRUST_ZONE_LABELS[z];
  return z;
}

/** 信任域说明；未知/空 → '' */
export function approvalTrustZoneHint(zone: unknown): string {
  const z = normalizeTrustZone(zone);
  if (!z || !isKnownTrustZone(z)) return '';
  return APPROVAL_TRUST_ZONE_HINTS[z];
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
      return APPROVAL_TRUST_ZONE_LABELS[z];
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
