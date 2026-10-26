/**
 * 输入坞内嵌通知顶槽类型契约与 7 类通知源归属矩阵（P6 T6-2）
 *
 * 设计约束：
 * - 输入坞相关的全部 7 类通知源统一收敛至 `.composerCard` 内部的 `embeddedTopSlot`；
 * - 严禁在 `.composerCard` 外部渲染独立的 360px 胶囊或第二层闭合卡片框；
 * - 保留 legacy `type` / `message` 字段以兼容既有通知调用方与测试断言。
 */

export type ComposerNoticeSeverity =
  'info' | 'warning' | 'error' | 'rate-limit';

export type ComposerNoticeLegacyType =
  'info' | 'warn' | 'warning' | 'error' | 'stop' | 'success';

export type ComposerNoticeSourceKind =
  | 'upload-warn'
  | 'provider-error'
  | 'stream-error'
  | 'rate-limit'
  | 'budget-exhausted'
  | 'context-limit'
  | 'permission-denied';

export type ComposerNoticeSourceId = ComposerNoticeSourceKind;

export type ComposerNoticePlacement = 'embedded-top-slot';

export interface ComposerNoticeAction {
  label: string;
  onClick: () => void;
}

export interface ComposerNotice {
  /** 可选通知唯一标识 */
  id?: string;
  /** 语义严重度（P6 标准契约） */
  severity?: ComposerNoticeSeverity;
  /** 兼容旧版 type 字段 */
  type?: ComposerNoticeLegacyType;
  /** 通知来源分类（7 类通知源矩阵） */
  source?: ComposerNoticeSourceKind;
  /** 主文案（支持 text 或旧版 message） */
  text?: string;
  /** 兼容旧版 message 主文案字段 */
  message?: string;
  /** 详情说明（供复制或悬浮查看） */
  detail?: string;
  /** 恢复动作按钮（如「重试」「切换模型」「清理上下文」） */
  action?: ComposerNoticeAction;
}

export interface ComposerNoticeSourceSpec {
  readonly source: ComposerNoticeSourceKind;
  readonly defaultSeverity: ComposerNoticeSeverity;
  readonly placement: ComposerNoticePlacement;
  readonly dismissible: boolean;
}

/**
 * 7 类通知源归属矩阵（SSOT）：
 * 全部归入 `.composerCard` 内部顶槽（`embedded-top-slot`），禁止外部独立胶囊。
 */
export const COMPOSER_NOTICE_SOURCE_MATRIX: Readonly<
  Record<ComposerNoticeSourceKind, ComposerNoticeSourceSpec>
> = {
  'upload-warn': {
    source: 'upload-warn',
    defaultSeverity: 'warning',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'provider-error': {
    source: 'provider-error',
    defaultSeverity: 'error',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'stream-error': {
    source: 'stream-error',
    defaultSeverity: 'error',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'rate-limit': {
    source: 'rate-limit',
    defaultSeverity: 'rate-limit',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'budget-exhausted': {
    source: 'budget-exhausted',
    defaultSeverity: 'warning',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'context-limit': {
    source: 'context-limit',
    defaultSeverity: 'info',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
  'permission-denied': {
    source: 'permission-denied',
    defaultSeverity: 'warning',
    placement: 'embedded-top-slot',
    dismissible: true,
  },
};

/**
 * 归一化解析通知的语义严重度（纯函数）
 */
export function resolveNoticeSeverity(
  notice: Pick<ComposerNotice, 'severity' | 'type' | 'source'>
): ComposerNoticeSeverity {
  if (notice.severity) {
    return notice.severity;
  }
  if (notice.source && COMPOSER_NOTICE_SOURCE_MATRIX[notice.source]) {
    return COMPOSER_NOTICE_SOURCE_MATRIX[notice.source].defaultSeverity;
  }
  if (notice.type === 'error' || notice.type === 'stop') {
    return 'error';
  }
  if (notice.type === 'warn' || notice.type === 'warning') {
    return 'warning';
  }
  return 'info';
}

/**
 * 将 `ComposerNoticeSeverity` 映射回兼容旧版的 `type`（纯函数）
 */
export function resolveLegacyNoticeType(
  severity: ComposerNoticeSeverity
): 'info' | 'warn' | 'error' {
  if (severity === 'error') return 'error';
  if (severity === 'warning' || severity === 'rate-limit') return 'warn';
  return 'info';
}

/**
 * 判定通知应当挂载的物理槽位（纯函数，7 类通知源恒定返回 `embedded-top-slot`）
 */
export function resolveComposerNoticePlacement(
  source?: ComposerNoticeSourceKind
): ComposerNoticePlacement {
  if (source && COMPOSER_NOTICE_SOURCE_MATRIX[source]) {
    return COMPOSER_NOTICE_SOURCE_MATRIX[source].placement;
  }
  return 'embedded-top-slot';
}

/**
 * 判断给定通知源是否归属 `.composerCard` 内嵌顶槽
 */
export function shouldRenderInEmbeddedTopSlot(
  source?: ComposerNoticeSourceKind
): boolean {
  return resolveComposerNoticePlacement(source) === 'embedded-top-slot';
}
