/**
 * User-facing error policy for the desktop product.
 *
 * - Prefer calm, short copy for connectivity / setup issues.
 * - Agent runtime detail stays out of the bubble unless we classify a soft setup hint.
 * - 失败呈现文案（标题/一句话/动作）的单一真源是 failureTaxonomy.ts 的
 *   封闭分类表（批 C 第 2 件）：本模块只负责「分类」（kebab 码/域/文本
 *   软分类三路检测器），分类结果一律经分类表投影出文案，不再散写字面量。
 */

import { errorStore } from '../services/ErrorStore';
import { logger } from '../services/LoggerService';
import {
  DOMAIN_TO_FAMILY,
  FAILURE_FAMILIES,
  FAMILY_TO_DOMAIN,
  FAMILY_TO_SOFT,
  KEBAB_CODE_TO_FAMILY,
  SOFT_TO_FAMILY,
  type FailureAction,
  type FailureFamily,
} from './failureTaxonomy';

const NETWORK_RE =
  /network|timeout|offline|econn|enotfound|econnrefused|not connected|failed to connect|connect(?:ion)? (?:failed|refused|reset|closed)|disconnected|unable to connect|proxy|dns|net::|fetch failed|socket/i;

const NO_KEY_RE =
  /no provider|missing.*(?:api.?key|credential)|api.?key.*(?:missing|unset|required)|NO_PROVIDER|credential.*not|hasApiKey.?false|引擎未就绪/i;

const AUTH_RE =
  /invalid.?api.?key|unauthorized|401|authentication|auth.?failed|api.?key.*invalid|key.*expired|credential.*invalid/i;

const NO_PROJECT_RE =
  /no (?:project|workspace|cwd)|workspace (?:required|not set)|cwd (?:required|missing)/i;

const BLOCKED_RE =
  /blocked|denied by policy|hardline|permission denied|not allowed|safety/i;

export type SoftFailureKind =
  | 'network'
  | 'no_key'
  | 'auth'
  | 'no_project'
  | 'blocked'
  | 'provider_fault'
  | 'context'
  | 'ended'
  | null;

export function normalizeErrorText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || String(input);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.code === 'string' && typeof o.message !== 'string')
      return o.code;
    try {
      return JSON.stringify(input);
    } catch {
      return String(input);
    }
  }
  return String(input);
}

export function isNetworkishError(input: unknown): boolean {
  const text = normalizeErrorText(input);
  if (!text) return false;
  return NETWORK_RE.test(text);
}

/**
 * Rust session-loop 的 provider 收场文案包装：
 *   `provider 错误（{kind}）：{message}`（crates/session-loop/src/loop/handlers/stream_error.rs kind_str）。
 * AA-07 统一规范：kebab 错误码优先识别，前端不再按英文文本重复猜测。
 */
const RUST_PROVIDER_WRAPPER_RE = /provider\s*错误\s*（([^）]+)）\s*：/;

/**
 * kebab 错误码 → 前端软失败分类（未登记码回落到文本正则兜底）。
 * 批 C 第 2 件起由分类表派生：码 → 家族（KEBAB_CODE_TO_FAMILY）→ 软分类
 * 投影（FAMILY_TO_SOFT），与 KEBAB_TO_DOMAIN 同源，杜绝两表漂移。
 * `unknown` 故意不登记：兜底码，classifySoftFailure 兜底路径处理
 * （kebab-codes-drift.test.ts 豁免断言 + 兜底断言锁定）。
 * `aborted` 不登记为失败家族：用户取消/中断语义，显式落 ended 静默收口。
 */
const KEBAB_KIND_TO_SOFT: Record<string, SoftFailureKind> = {
  ...Object.fromEntries(
    Object.entries(KEBAB_CODE_TO_FAMILY).flatMap(([code, family]) => {
      const soft = FAMILY_TO_SOFT[family];
      return soft ? [[code, soft] as const] : [];
    })
  ),
  aborted: 'ended',
};

function classifyByKebabCode(text: string): SoftFailureKind | null {
  const m = RUST_PROVIDER_WRAPPER_RE.exec(text);
  if (!m) return null;
  return KEBAB_KIND_TO_SOFT[m[1]!] ?? null;
}

export function classifySoftFailure(input: unknown): SoftFailureKind {
  const text = normalizeErrorText(input);
  if (!text) return null;
  // kebab 错误码优先（统一规范）；未登记码 → 落到文本正则兜底
  const kebab = classifyByKebabCode(text);
  if (kebab) return kebab;
  if (NO_KEY_RE.test(text)) return 'no_key';
  if (AUTH_RE.test(text)) return 'auth';
  if (NO_PROJECT_RE.test(text)) return 'no_project';
  if (isNetworkishError(text)) return 'network';
  if (BLOCKED_RE.test(text)) return 'blocked';
  // Generic run failure without technical dump
  if (/run failed|RUN_ERROR|failed|error/i.test(text)) return 'ended';
  return null;
}

export type UserFacingMessage = string | null;

/**
 * 差异化八域（docs/system-audit-and-redesign/02-核心聊天与容错状态机详案 S1-S8）：
 * - S1 本地核心未就绪（waitUntilConnected 超时 / initialized=false）
 * - S2 引擎未就绪（provider 配置缺失）
 * - S3 restore 进行中（restore.state=pending）
 * - S4 provider 网络（kebab 码 network/timeout/endpoint-unavailable）
 * - S5 provider 侧故障（server-error/rate-limit/gateway-challenge）
 * - S6 内部错误（panic / 未捕获异常）
 * - S7 会话排队中（SESSION_BUSY / 串行守卫）
 * - S8 存储同步中（STORAGE_BUSY / database locked）
 * - engine_crash（T5-1 追加）：引擎崩溃/无响应域（崩溃文案显式分类，
 *   不再落入 S6 内部错误——「引擎已崩溃」需要独立的呈现面与恢复指引）
 */
export type ErrorDomain =
  'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'engine_crash';

/**
 * 差异化文案表（用户裁决选项 A：分层 + 动作指引，不虚假承诺「自动恢复」）。
 * 除 ErrorDomain 各域外另含非域派生文案 S7_EXHAUSTED（串行守卫自动排队
 * 退避重试用尽 → ComposerErrorBar 失败提示，FINAL-PLAN P1-d 方案 B）。
 */
export const DOMAIN_MESSAGES: Readonly<
  Record<ErrorDomain, string> & { S7_EXHAUSTED: string }
> = {
  S1: FAILURE_FAMILIES['local-core-not-ready'].guidanceZh,
  S2: FAILURE_FAMILIES['not-configured'].guidanceZh,
  S3: FAILURE_FAMILIES.restoring.guidanceZh,
  S4: FAILURE_FAMILIES.network.guidanceZh,
  S5: FAILURE_FAMILIES.server.guidanceZh,
  S6: FAILURE_FAMILIES.internal.guidanceZh,
  S7: FAILURE_FAMILIES['session-busy'].guidanceZh,
  S8: FAILURE_FAMILIES['storage-busy'].guidanceZh,
  S7_EXHAUSTED: '上一轮任务长时间未结束，本条消息未能发出，请稍后点击重试。',
  // T5-1：崩溃域——只给「自动重连 / 查看崩溃日志」，不给「重启引擎」
  // 按钮（进程内架构重启 = 整个 Tauri 重启，产品待决明示不做）
  engine_crash: FAILURE_FAMILIES['engine-crash'].guidanceZh,
};

/**
 * 历史上曾写入 thinking 流的域文案旧变体（S-1，FINAL-PLAN §2）。
 * DOMAIN_MESSAGES.S7 改文案时，必须把旧值登记到这里（否则已持久化的旧消息
 * 会重新出现「已思考」行；userFacingErrors.test 有防漂移断言）。
 */
export const LEGACY_DOMAIN_NOTICE_VARIANTS: readonly string[] = [
  '当前会话上一轮任务仍在收尾中…',
  '当前会话上一轮任务仍在收尾中...',
];

const TRAILING_PUNCT_RE = /[\s。．.，,；;！!…]+$/u;

function stripTrailingPunct(text: string): string {
  return text.trim().replace(TRAILING_PUNCT_RE, '');
}

/**
 * S-1：思考文本是否只是误写入 thinking 的 S7 域文案（HEAD 版 SESSION_BUSY 分支
 * `onThought(DOMAIN_MESSAGES.S7)` 遗留）。前缀由 DOMAIN_MESSAGES.S7 推导，
 * 不另写字面量。每一非空行都必须是该文案（或登记的旧变体）才判真。
 */
export function isLegacyDomainNoticeThought(
  text: string | undefined | null
): boolean {
  if (!text || !text.trim()) return false;
  const known = [DOMAIN_MESSAGES.S7, ...LEGACY_DOMAIN_NOTICE_VARIANTS]
    .map(stripTrailingPunct)
    .filter(Boolean);
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripTrailingPunct(l))
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => known.some((k) => line === k));
}

/**
 * kebab 错误码 → 域（Rust provider 包装 `provider 错误（{kind}）：{message}`）。
 * 批 C 第 2 件起由分类表派生：码 → 家族 → 域投影（FAMILY_TO_DOMAIN）；
 * auth/quota/unknown 无域投影（既有分类接管），aborted 显式返回 null
 * （classifyErrorDomain 内处理，用户取消静默收口）。
 */
const KEBAB_TO_DOMAIN: Record<string, ErrorDomain> = Object.fromEntries(
  Object.entries(KEBAB_CODE_TO_FAMILY).flatMap(([code, family]) => {
    const domain = FAMILY_TO_DOMAIN[family];
    return domain ? [[code, domain] as const] : [];
  })
);

const SESSION_BUSY_RE = /SESSION_BUSY|已有活动 run|串行守卫/i;
const STORAGE_BUSY_RE =
  /database locked|sqlite busy|store\.(?:append_event|query|lock)/i;
const PROVIDER_CONFIG_MISSING_RE =
  /provider\s*配置缺失|provider config.*missing|no provider/i;
const RESTORE_IN_PROGRESS_RE = /restore in progress|restore.*进行中/i;
const LOCAL_CORE_NOT_READY_RE = /engine not ready|引擎未就绪|核心未就绪/i;
const PROVIDER_SIDE_FAULT_RE = /server.?error|5\d{2}|rate.?limit|gateway|429/i;
const INTERNAL_ERROR_RE =
  /encoding error|tauri command not available|command not available|^unknown:|panic:|unhandled exception/i;
// T5-1：引擎崩溃/无响应域（崩溃台账文案 / 收割终态标记 / 心跳判死域）
const ENGINE_CRASH_RE =
  /crash-.*\.log|引擎无响应|引擎已崩溃|engine crashed|engine unresponsive|已中断，无终态收口|core dumped/i;

/**
 * 引擎崩溃/无响应文案判定（T5-1 崩溃域分类；崩溃台账 / 收割终态 /
 * 心跳判死域的文案统一入口）。
 */
export function isEngineCrashishError(input: unknown): boolean {
  const text = normalizeErrorText(input);
  if (!text) return false;
  return ENGINE_CRASH_RE.test(text);
}

/** core_get_status 返回体形状判定（serde camelCase：initialized/engineReady/restore 等） */
function isStatusLike(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const o = input as Record<string, unknown>;
  return (
    typeof o.initialized === 'boolean' ||
    typeof o.engineReady === 'boolean' ||
    typeof o.engine_ready === 'boolean' ||
    typeof o.dbReady === 'boolean' ||
    o.restore != null
  );
}

/**
 * core_get_status 状态对象 → 域（S1/S2/S3；就绪 → null）。
 * 判定顺序对齐 Rust 门禁（core_run_commands.rs:2851-2874）：
 * initialized=false → S1；restore.state=pending → S3；engineReady=false → S2。
 */
function classifyStatusDomain(
  status: Record<string, unknown>
): ErrorDomain | null {
  if (status.initialized === false) return 'S1';
  const restore =
    typeof status.restore === 'object' && status.restore !== null
      ? (status.restore as Record<string, unknown>)
      : null;
  if (restore?.state === 'pending') return 'S3';
  const engineReady = status.engineReady ?? status.engine_ready;
  if (engineReady === false) return 'S2';
  return null;
}

/**
 * 差异化八域判定（S1-S8）。
 * 支持两类 detail：core_get_status 状态对象（S1/S2/S3）与错误文本/对象（S1-S8）。
 * 未命中任何域 → null（保留既有 classifySoftFailure 分类路径，不做越权判定）。
 */
export function classifyErrorDomain(input: unknown): ErrorDomain | null {
  if (isStatusLike(input)) return classifyStatusDomain(input);
  const text = normalizeErrorText(input);
  if (!text) return null;
  // kebab 错误码优先（统一规范）；未登记码（auth/quota 等）→ 既有分类接管
  const wrapper = RUST_PROVIDER_WRAPPER_RE.exec(text);
  if (wrapper) {
    const code = wrapper[1]!;
    if (code === 'aborted') return null; // 用户取消正常静默收口，绝不上抛 S6
    return KEBAB_TO_DOMAIN[code] ?? null;
  }
  // 串行并发 (S7) 与存储繁忙 (S8) 优先分流
  if (SESSION_BUSY_RE.test(text)) return 'S7';
  if (STORAGE_BUSY_RE.test(text)) return 'S8';
  // T5-1：崩溃域显式分类（先于 S6——崩溃文案不再落入「内部错误」泛域）
  if (ENGINE_CRASH_RE.test(text)) return 'engine_crash';
  // S2 先于 S1：Rust 门禁文案「engine not ready（provider 配置缺失）」同时含两者
  if (PROVIDER_CONFIG_MISSING_RE.test(text)) return 'S2';
  if (RESTORE_IN_PROGRESS_RE.test(text)) return 'S3';
  if (LOCAL_CORE_NOT_READY_RE.test(text)) return 'S1';
  if (isNetworkishError(text)) return 'S4';
  if (PROVIDER_SIDE_FAULT_RE.test(text)) return 'S5';
  if (INTERNAL_ERROR_RE.test(text)) return 'S6';
  return null;
}

/** 差异化文案取值（S1-S8 域 → 用户可见文案） */
export function domainUserMessage(domain: ErrorDomain): string {
  return DOMAIN_MESSAGES[domain];
}

/**
 * 网络/连接类失败的用户文案（不再一刀切「正在自动恢复」）。
 * 消费 detail 做分域判定（S1-S8）；detail 缺失或未命中任何域 → S4 兜底
 *（默认归为 S4 网络连接异常，彻底消灭网络波动误退回 S6 的无参死循环）。
 */
export function networkUserMessage(detail?: unknown): string {
  if (detail !== undefined && detail !== null) {
    const domain = classifyErrorDomain(detail);
    if (domain) return DOMAIN_MESSAGES[domain];
  }
  return DOMAIN_MESSAGES.S4;
}

export function productStartingMessage(): string {
  return '正在启动…';
}

export function softFailureMessage(
  kind: SoftFailureKind,
  detail?: unknown
): UserFacingMessage {
  switch (kind) {
    case 'network':
      return networkUserMessage(detail);
    case 'no_key':
      return FAILURE_FAMILIES['not-configured'].guidanceZh;
    case 'auth':
      return FAILURE_FAMILIES.auth.guidanceZh;
    case 'no_project':
      return FAILURE_FAMILIES['no-project'].guidanceZh;
    case 'blocked': {
      // quota 经软分类同落 blocked：detail 带 kebab 码时按家族出文案
      // （额度用尽 ≠ 策略拦截，旧实现一律出拦截文案是归一前的混淆点）
      if (detail !== undefined && detail !== null) {
        const wrapper = RUST_PROVIDER_WRAPPER_RE.exec(
          normalizeErrorText(detail)
        );
        if (wrapper && KEBAB_CODE_TO_FAMILY[wrapper[1]!] === 'quota') {
          return FAILURE_FAMILIES.quota.guidanceZh;
        }
      }
      return FAILURE_FAMILIES.blocked.guidanceZh;
    }
    case 'provider_fault':
      // S5 域：provider 侧故障（server-error/rate-limit/gateway-challenge）
      return FAILURE_FAMILIES.server.guidanceZh;
    case 'context':
      // T-F 06（T3.2）：context-length-exceeded 专属文案
      return FAILURE_FAMILIES['context-length'].guidanceZh;
    case 'ended':
      return null;
    default:
      return null;
  }
}

/** 失败呈现（分类表查表结果）：内联面只许标题 + 一句话 + 至多一个动作 */
export interface FailurePresentation {
  family: FailureFamily;
  title: string;
  guidance: string;
  action: FailureAction | null;
}

function presentationOf(family: FailureFamily): FailurePresentation {
  const copy = FAILURE_FAMILIES[family];
  return {
    family,
    title: copy.titleZh,
    guidance: copy.guidanceZh,
    action: copy.action,
  };
}

/**
 * 任意失败输入 → 分类表呈现（批 C 第 2 件的查表入口）。
 * 判定顺序：kebab 错误码（权威结构化信号）→ 差异化域 → 文本软分类。
 * aborted（用户取消）与完全无法分类的输入返回 null：前者静默收口，
 * 后者由调用方走通用兜底文案——原始错误串永不经本函数内联出面。
 */
export function presentFailure(input: unknown): FailurePresentation | null {
  const text = normalizeErrorText(input);
  if (text) {
    const wrapper = RUST_PROVIDER_WRAPPER_RE.exec(text);
    if (wrapper) {
      const code = wrapper[1]!;
      if (code === 'aborted') return null;
      const family = KEBAB_CODE_TO_FAMILY[code];
      if (family) return presentationOf(family);
    }
  }
  const domain = classifyErrorDomain(input);
  if (domain) return presentationOf(DOMAIN_TO_FAMILY[domain]);
  const soft = classifySoftFailure(input);
  if (soft) {
    const family = SOFT_TO_FAMILY[soft];
    if (family) return presentationOf(family);
  }
  return null;
}

/**
 * @deprecated 禁止再写入 assistant 气泡。错误/中断只走 onRunError → 横幅/toast。
 * 仍返回文案供 surfaceStreamFailure 组 notice，勿 updateMessageText 进气泡。
 * @see onRunError（横幅/toast 错误链路）
 */
export function assistantBubbleForFailure(input: unknown): string | null {
  const kind = classifySoftFailure(input);
  if (kind) return softFailureMessage(kind, input);
  if (isNetworkishError(input)) return networkUserMessage(input);
  return null;
}

/**
 * 持久化降级专名面（D-05 S1 上报链）：命中这些 scope 的内部错误除 console 日志外，
 * 额外推入 errorStore（severity=warning）→ 经 errorStore.push 进入 telemetry.error，
 * 供「批写降级可感知」UI 槽与诊断检索（persist-degraded-ls / persist-degraded-meta /
 * hydrate-degraded-repair / hydrate-degraded-repair-failed）。
 * 其它 scope 保持既有 console.warn 行为不变（避免把全仓内部错误全部推入错误面板）。
 */
const PERSIST_DEGRADED_SCOPE_RE = /^(persist-degraded-|hydrate-degraded-)/;

/**
 * logInternalError 可观测性选项（维度 5 扩面：severity 参数 + scope 路由）。
 * - severity 缺省 = 'info'：仅 logger.warn，不推入 errorStore（向后兼容；
 *   全仓 77 处既有调用点零改动仍保持原行为）。
 * - severity = 'warning' / 'error'：额外推入 errorStore（用户可见错误面板）。
 * - autoResolve：推入 errorStore 时是否允许自动解决（缺省 true）。
 */
export interface LogInternalErrorOptions {
  severity?: 'info' | 'warning' | 'error';
  autoResolve?: boolean;
}

export function logInternalError(
  scope: string,
  input: unknown,
  options?: LogInternalErrorOptions
): void {
  const severity = options?.severity ?? 'info';
  // 修复 1：删除 console.warn 裸调 → 改为 logger.warn，使所有 logInternalError
  // 调用（全仓 77 处）自动经 LoggerService 统一输出（单一真源）。
  try {
    logger.warn(`[${scope}]`, {
      module: 'userFacingErrors',
      err: normalizeErrorText(input)
        ? { message: normalizeErrorText(input) }
        : undefined,
    });
  } catch {
    /* ignore */
  }
  // severity = 'warning'/'error' → 推入 errorStore
  if (severity === 'warning' || severity === 'error') {
    try {
      errorStore.push({
        code: scope,
        module: 'userFacingErrors',
        severity,
        message: `内部错误（${scope}）`,
        autoResolve: options?.autoResolve ?? true,
        ...(normalizeErrorText(input)
          ? { technical: normalizeErrorText(input) }
          : {}),
      });
    } catch {
      /* 上报失败不阻断主流程 */
    }
    return;
  }
  // persist-degraded-*/hydrate-degraded-* scope 保持原有推入行为
  if (PERSIST_DEGRADED_SCOPE_RE.test(scope)) {
    try {
      errorStore.push({
        code: scope,
        module: 'session-persistence',
        severity: 'warning',
        message: `会话持久化降级（${scope}）`,
        ...(normalizeErrorText(input)
          ? { technical: normalizeErrorText(input) }
          : {}),
      });
    } catch {
      /* 上报失败不阻断降级主流程 */
    }
  }
}
