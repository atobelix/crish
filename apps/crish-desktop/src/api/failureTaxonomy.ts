/**
 * 失败分类表（批 C 第 2 件，2026-11-03）——桌面失败呈现的**单一映射模块**。
 *
 * 封闭家族枚举 → 唯一 zh/en 标题 + 一句话说明 + 至多一个动作。
 * 反馈路由宪法（docs/guides/feedback-routing.md §3）：内联呈现只许
 * 「标题 + 一句话 + 至多一个动作」，后端原始错误串永不内联，只进用户
 * 主动打开的详情。本表是标题的唯一真源：i18n `error.*.title` 中属于
 * 本表的条目必须与本表标题逐字一致（failureTaxonomy.test.ts 钉死，
 * 即登记在案的 20 条标题异文归一结果）。
 *
 * 家族命名与移动端 `LocalChatErrorKind` 13 类对齐（移动 camelCase →
 * 本表 kebab-case）：network / auth / quota / model-not-found /
 * endpoint-unavailable / rate-limit / context-length / invalid-request /
 * payload-too-large / server / stream / not-configured / unknown；
 * 桌面专有扩展：timeout / no-project / blocked / local-core-not-ready /
 * restoring / session-busy / storage-busy / internal / engine-crash。
 *
 * 分类入口仍在 userFacingErrors.ts（kebab 码 → 本表家族；既有 S1-S8
 * 域与软分类是家族的投影，投影表同在本模块，保证三套口径同源不漂移）。
 */
import type { ErrorDomain, SoftFailureKind } from './userFacingErrors';

export type FailureFamily =
  | 'network'
  | 'timeout'
  | 'endpoint-unavailable'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'model-not-found'
  | 'context-length'
  | 'invalid-request'
  | 'payload-too-large'
  | 'server'
  | 'stream'
  | 'not-configured'
  | 'no-project'
  | 'blocked'
  | 'local-core-not-ready'
  | 'restoring'
  | 'session-busy'
  | 'storage-busy'
  | 'internal'
  | 'engine-crash'
  | 'unknown';

export type FailureActionKind =
  | 'retry'
  | 'open-model-settings'
  | 'select-workspace'
  | 'new-session'
  | 'restart-app'
  | 'view-crash-log';

export interface FailureAction {
  kind: FailureActionKind;
  labelZh: string;
  labelEn: string;
}

export interface FailureFamilyCopy {
  titleZh: string;
  titleEn: string;
  guidanceZh: string;
  guidanceEn: string;
  /** 至多一个动作；null = 无动作（等待自愈/策略拦截/重试无意义） */
  action: FailureAction | null;
}

const RETRY: FailureAction = {
  kind: 'retry',
  labelZh: '重试',
  labelEn: 'Retry',
};
const RETRY_LATER: FailureAction = {
  kind: 'retry',
  labelZh: '稍后重试',
  labelEn: 'Retry later',
};
const OPEN_MODEL_SETTINGS: FailureAction = {
  kind: 'open-model-settings',
  labelZh: '打开模型设置',
  labelEn: 'Open model settings',
};

export const FAILURE_FAMILIES: Readonly<
  Record<FailureFamily, FailureFamilyCopy>
> = {
  network: {
    titleZh: '网络连接失败',
    titleEn: 'Network connection failed',
    guidanceZh: '模型服务商暂时无法连接（网络问题），请检查网络后重发。',
    guidanceEn:
      'Cannot reach the model provider (network problem). Check your connection and resend.',
    action: RETRY,
  },
  timeout: {
    titleZh: '请求超时',
    titleEn: 'Request timed out',
    guidanceZh: '请求超时，可能是网络缓慢或服务商响应过久，请稍后重试。',
    guidanceEn:
      'The request timed out, possibly due to a slow network or provider. Try again later.',
    action: RETRY_LATER,
  },
  'endpoint-unavailable': {
    titleZh: '服务端点不可用',
    titleEn: 'Service endpoint unavailable',
    guidanceZh: '模型服务端点不可用，请检查服务商地址或切换模型。',
    guidanceEn:
      'The model endpoint is unavailable. Check the provider address or switch models.',
    action: OPEN_MODEL_SETTINGS,
  },
  auth: {
    titleZh: '认证失败',
    titleEn: 'Authentication failed',
    guidanceZh: '模型密钥无效或已过期，请打开设置 → 模型检查密钥与服务商地址。',
    guidanceEn:
      'The model key is invalid or expired. Open Settings → Models to check the key and provider address.',
    action: OPEN_MODEL_SETTINGS,
  },
  quota: {
    titleZh: '额度已用尽',
    titleEn: 'Quota exhausted',
    guidanceZh: '模型服务额度已用尽，请充值或切换服务商后再试。',
    guidanceEn:
      'The model service quota is exhausted. Top up or switch providers, then try again.',
    action: OPEN_MODEL_SETTINGS,
  },
  'rate-limit': {
    titleZh: '请求过于频繁',
    titleEn: 'Too many requests',
    guidanceZh: '请求过于频繁，已被服务商限流，请稍后重试。',
    guidanceEn:
      'Too many requests; the provider is rate-limiting. Try again later.',
    action: RETRY_LATER,
  },
  'model-not-found': {
    titleZh: '模型不可用',
    titleEn: 'Model unavailable',
    guidanceZh: '所选模型不可用，请切换模型或检查服务商配置。',
    guidanceEn:
      'The selected model is unavailable. Switch models or check the provider configuration.',
    action: OPEN_MODEL_SETTINGS,
  },
  'context-length': {
    titleZh: '上下文长度超限',
    titleEn: 'Context length exceeded',
    guidanceZh: '上下文已超限：本轮对话过长，系统已自动压缩或需新建会话。',
    guidanceEn:
      'Context limit exceeded: this conversation is too long. It has been compacted automatically, or start a new session.',
    action: {
      kind: 'new-session',
      labelZh: '新建会话',
      labelEn: 'New session',
    },
  },
  'invalid-request': {
    titleZh: '请求无效',
    titleEn: 'Invalid request',
    guidanceZh: '请求被服务商拒绝（参数无效），请调整后重试。',
    guidanceEn:
      'The provider rejected the request (invalid parameters). Adjust and retry.',
    action: null,
  },
  'payload-too-large': {
    titleZh: '内容过大',
    titleEn: 'Payload too large',
    guidanceZh: '发送内容过大，请删减附件或拆分后重试。',
    guidanceEn:
      'The payload is too large. Remove attachments or split it, then retry.',
    action: null,
  },
  server: {
    titleZh: '服务商故障',
    titleEn: 'Provider service error',
    guidanceZh: '模型服务商侧出现故障，请稍后重试或切换模型。',
    guidanceEn:
      'The model provider is having a fault. Retry later or switch models.',
    action: RETRY_LATER,
  },
  stream: {
    titleZh: '传输中断',
    titleEn: 'Stream interrupted',
    guidanceZh: '传输中断，本轮回复未完成，请重试。',
    guidanceEn:
      'The stream was interrupted and this reply did not finish. Retry.',
    action: RETRY,
  },
  'not-configured': {
    titleZh: '模型服务未配置',
    titleEn: 'Model service not configured',
    guidanceZh: '模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。',
    guidanceEn:
      'The model service is not configured yet. Open Settings → Models to finish setup, then send.',
    action: OPEN_MODEL_SETTINGS,
  },
  'no-project': {
    titleZh: '未选择工作区',
    titleEn: 'No workspace selected',
    guidanceZh: '请先选择项目工作区，再继续对话。',
    guidanceEn:
      'Select a project workspace first, then continue the conversation.',
    action: {
      kind: 'select-workspace',
      labelZh: '选择工作区',
      labelEn: 'Select workspace',
    },
  },
  blocked: {
    titleZh: '操作被拦截',
    titleEn: 'Blocked by policy',
    guidanceZh: '该操作未获允许（可能被安全策略或计划模式拦截）。',
    guidanceEn:
      'This operation was not allowed (possibly blocked by a safety policy or plan mode).',
    action: null,
  },
  'local-core-not-ready': {
    titleZh: '本地服务未就绪',
    titleEn: 'Local service not ready',
    guidanceZh: '软件服务正在启动，请稍候片刻。',
    guidanceEn: 'The local service is starting. Please wait a moment.',
    action: null,
  },
  restoring: {
    titleZh: '正在恢复会话',
    titleEn: 'Restoring session',
    guidanceZh: '正在恢复上次的会话数据，稍后即可发送。',
    guidanceEn: 'Restoring your previous session data. You can send shortly.',
    action: null,
  },
  'session-busy': {
    titleZh: '会话忙',
    titleEn: 'Session busy',
    guidanceZh: '当前会话上一轮任务仍在收尾中，已自动为您排队。',
    guidanceEn:
      'The previous task in this session is still wrapping up. Your message has been queued automatically.',
    action: null,
  },
  'storage-busy': {
    titleZh: '存储同步中',
    titleEn: 'Storage syncing',
    guidanceZh: '本地会话存储正在同步数据，请稍候片刻。',
    guidanceEn: 'Local session storage is syncing data. Please wait a moment.',
    action: null,
  },
  internal: {
    titleZh: '软件内部错误',
    titleEn: 'Internal error',
    guidanceZh: '软件内部错误，请稍后重试；若反复出现请重启应用。',
    guidanceEn:
      'An internal error occurred. Retry later; if it keeps happening, restart the app.',
    action: {
      kind: 'restart-app',
      labelZh: '重启应用',
      labelEn: 'Restart app',
    },
  },
  'engine-crash': {
    titleZh: '引擎无响应',
    titleEn: 'Engine unresponsive',
    guidanceZh:
      '引擎无响应，可能已崩溃；任务可能已中断，请检查崩溃日志或重启应用。',
    guidanceEn:
      'The engine is unresponsive and may have crashed; the task may have been interrupted. Check the crash log or restart the app.',
    action: {
      kind: 'view-crash-log',
      labelZh: '查看崩溃日志',
      labelEn: 'View crash log',
    },
  },
  unknown: {
    titleZh: '未知错误',
    titleEn: 'Unknown error',
    guidanceZh: '发生了未知错误，请稍后重试。',
    guidanceEn: 'An unknown error occurred. Please try again later.',
    action: RETRY,
  },
};

/**
 * Rust provider kebab 错误码 → 家族（码集与 Rust `kind_str` 13 码对齐，
 * 见 kebab-codes-drift.test.ts；`aborted` 故意不登记——用户取消是正常
 * 静默收口，不构成失败呈现，由 userFacingErrors 显式处理）。
 */
export const KEBAB_CODE_TO_FAMILY: Readonly<Record<string, FailureFamily>> = {
  auth: 'auth',
  quota: 'quota',
  network: 'network',
  timeout: 'timeout',
  'endpoint-unavailable': 'endpoint-unavailable',
  'server-error': 'server',
  'rate-limit': 'rate-limit',
  'gateway-challenge': 'server',
  'context-length-exceeded': 'context-length',
  'payload-too-large': 'payload-too-large',
  'invalid-request': 'invalid-request',
  unknown: 'unknown',
};

/** 家族 → 既有软分类投影（userFacingErrors 的 classifySoftFailure 口径） */
export const FAMILY_TO_SOFT: Readonly<
  Partial<Record<FailureFamily, Exclude<SoftFailureKind, null>>>
> = {
  network: 'network',
  timeout: 'network',
  'endpoint-unavailable': 'network',
  auth: 'auth',
  quota: 'blocked',
  server: 'provider_fault',
  'rate-limit': 'provider_fault',
  'context-length': 'context',
  'payload-too-large': 'provider_fault',
  'invalid-request': 'provider_fault',
  'not-configured': 'no_key',
  'no-project': 'no_project',
  blocked: 'blocked',
};

/** 家族 → 既有差异化域投影（userFacingErrors 的 classifyErrorDomain 口径） */
export const FAMILY_TO_DOMAIN: Readonly<
  Partial<Record<FailureFamily, ErrorDomain>>
> = {
  network: 'S4',
  timeout: 'S4',
  'endpoint-unavailable': 'S4',
  server: 'S5',
  'rate-limit': 'S5',
  'context-length': 'S5',
  'payload-too-large': 'S5',
  'invalid-request': 'S5',
  'local-core-not-ready': 'S1',
  'not-configured': 'S2',
  restoring: 'S3',
  'session-busy': 'S7',
  'storage-busy': 'S8',
  internal: 'S6',
  'engine-crash': 'engine_crash',
};

/** 差异化域 → 家族（presentFailure 的域路径） */
export const DOMAIN_TO_FAMILY: Readonly<Record<ErrorDomain, FailureFamily>> = {
  S1: 'local-core-not-ready',
  S2: 'not-configured',
  S3: 'restoring',
  S4: 'network',
  S5: 'server',
  S6: 'internal',
  S7: 'session-busy',
  S8: 'storage-busy',
  engine_crash: 'engine-crash',
};

/** 软分类 → 家族（presentFailure 的软路径；ended = 静默收口，不呈现） */
export const SOFT_TO_FAMILY: Readonly<
  Partial<Record<Exclude<SoftFailureKind, null>, FailureFamily>>
> = {
  network: 'network',
  no_key: 'not-configured',
  auth: 'auth',
  no_project: 'no-project',
  blocked: 'blocked',
  provider_fault: 'server',
  context: 'context-length',
};
