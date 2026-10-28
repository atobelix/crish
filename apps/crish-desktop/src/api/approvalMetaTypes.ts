/**
 * 审批风险元数据类型与常量（从 approvalMeta 拆分）。
 * 仅类型 + 冻结常量，无业务函数依赖。
 */

export type ApprovalRiskLevel =
  'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type ApprovalRiskSource = 'backend' | 'derived' | 'unknown';

export type ApprovalRiskMeta = {
  trustZone?: string;
  risk?: string;
  riskReason?: string;
  riskLevel: ApprovalRiskLevel;
  requiresDoubleConfirm: boolean;
  recommendSnapshot: boolean;
  source: ApprovalRiskSource;
  /** 原始审批 metadata（倒计时 / 策略 / 判点原因等，展示层透传） */
  metadata?: Record<string, unknown>;
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
export const EMPTY_APPROVAL_RISK_META: Readonly<ApprovalRiskMeta> =
  Object.freeze({
    riskLevel: 'unknown',
    requiresDoubleConfirm: false,
    recommendSnapshot: false,
    source: 'unknown',
  });

/** 信任域短标签（中文；与卡片 badge 一致） */
export const APPROVAL_TRUST_ZONE_LABELS: Readonly<
  Record<ApprovalTrustZone, string>
> = Object.freeze({
  T0: '只读',
  T1: '写操作',
  T2: '网络/进程',
  T3: '高风险',
  T4: '极危',
});

/** 信任域说明（中文副文案） */
export const APPROVAL_TRUST_ZONE_HINTS: Readonly<
  Record<ApprovalTrustZone, string>
> = Object.freeze({
  T0: '只读类操作，风险较低',
  T1: '可能修改工作区文件',
  T2: '可能访问网络或管理进程',
  T3: '高风险操作，通常需要确认',
  T4: '极危操作，禁止静默放行',
});

/** 风险等级短标签（中文） */
export const APPROVAL_RISK_LEVEL_LABELS: Readonly<
  Record<ApprovalRiskLevel, string>
> = Object.freeze({
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '极危',
  unknown: '需确认',
});

/** 风险等级说明（中文） */
export const APPROVAL_RISK_LEVEL_HINTS: Readonly<
  Record<ApprovalRiskLevel, string>
> = Object.freeze({
  low: '风险较低，仍建议确认后再执行',
  medium: '中等风险，请确认意图后继续',
  high: '高风险操作，请仔细核对命令与影响范围',
  critical: '极危操作，需二次确认，禁止自动放行',
  unknown: '后端未给出明确风险等级，请人工确认',
});

/** 常见 risk 种类 → 中文短标签（未知种类原样返回） */
export const RISK_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze(
  {
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
  }
);
