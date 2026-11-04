// 远程流内失败分类映射（批 C ⑮ 移动件）：桌面引擎回传的原始 reason
// 串先映射到本地封闭分类（LocalChatErrorKind 正典）再呈现——标题 +
// 一句话走 localChatErrorMessage 既有文案表，原始串只进详情（用户
// 点开才见，与本地错误横幅的 detail 口径一致）；映射不中归 unknown
// 诚实呈现「未分类」，不吞不编。
// 分类复用 localChatProtocol.classifyHttpError（桌面判定序的本地子集，
// 模式表单一真源）：能从原始串提取 HTTP 状态码时按状态码判；无状态
// 码时以状态码 0 走同一模式表（模型/鉴权/配额/限流/上下文等错误体
// 模式与状态码无关），再补网络/中断两类无 HTTP 语义的形态。
import type { LocalChatError, LocalChatErrorKind } from '../types/localChat';
import { classifyHttpError, localChatErrorMessage } from './localChatProtocol';

export interface RemoteFailurePresentation {
  /** 时间线 notice 主文案（标题 + 一句话；未分类时明示「未分类」） */
  text: string;
  /** 原始 reason 串（仅用户主动点开详情时呈现；空串/缺失时不设） */
  detail?: string;
  kind: LocalChatErrorKind;
}

// 无状态码自由文本的网络/中断形态（classifyHttpError 只覆盖 HTTP 语义）
const NETWORK_TEXT_PATTERNS = [
  '网络',
  '连接',
  '超时',
  'network',
  'offline',
  'timeout',
  'timed out',
  'dns',
  'econn',
  'socket',
  'unreachable',
  'fetch failed',
];
const STREAM_TEXT_PATTERNS = [
  '中断',
  '断开',
  'stream',
  'abort',
  'econnreset',
  'closed',
];

function containsAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => haystack.includes(p));
}

/** 从原始串提取 HTTP 状态码（"HTTP 401" / "status: 500" / 裸 4xx-5xx） */
export function extractHttpStatus(text: string): number | null {
  const prefixed = /(?:http|status|code|error)[^\d]{0,12}([1-5]\d\d)/i.exec(
    text
  );
  if (prefixed) return Number(prefixed[1]);
  const bare = /\b([45]\d\d)\b/.exec(text);
  return bare ? Number(bare[1]) : null;
}

/** 原始 reason 串 → 本地封闭分类（映射不中 = unknown，不猜测） */
export function classifyRemoteFailure(
  reason: string | null | undefined
): LocalChatError {
  const raw = (reason ?? '').trim();
  if (raw === '') {
    return { kind: 'unknown', status: null, message: '', retryable: false };
  }
  const status = extractHttpStatus(raw);
  if (status !== null) {
    const classified = classifyHttpError(status, raw);
    return { ...classified, detail: raw };
  }
  // 无状态码：同一模式表以 0 走一遍（错误体模式优先于其余推断）
  const probed = classifyHttpError(0, raw);
  if (probed.kind !== 'unknown') return { ...probed, detail: raw };
  // 上下文超长在 classifyHttpError 里只挂在 400/422 分支（其模式本身
  // 与状态码无关）：以 400 再探一遍，只提升 contextLength 结论，
  // 其余 400 结论（invalidRequest）不采——无状态码时不冒充请求不合法
  const probed400 = classifyHttpError(400, raw);
  if (probed400.kind === 'contextLength') {
    return { ...probed400, status: null, detail: raw };
  }
  const haystack = raw.toLowerCase();
  if (containsAny(haystack, STREAM_TEXT_PATTERNS)) {
    return {
      kind: 'stream',
      status: null,
      message: '',
      detail: raw,
      retryable: true,
    };
  }
  if (containsAny(haystack, NETWORK_TEXT_PATTERNS)) {
    return {
      kind: 'network',
      status: null,
      message: '',
      detail: raw,
      retryable: true,
    };
  }
  return {
    kind: 'unknown',
    status: null,
    message: '',
    detail: raw,
    retryable: false,
  };
}

/** 远程失败呈现：分类文案为主，原始串退居详情；未分类诚实标注 */
export function presentRemoteFailure(
  reason: string | null | undefined
): RemoteFailurePresentation {
  const raw = (reason ?? '').trim();
  if (raw === '') return { text: '运行失败', kind: 'unknown' };
  const error = classifyRemoteFailure(raw);
  if (error.kind === 'unknown') {
    return { text: '运行失败（未分类）', detail: raw, kind: 'unknown' };
  }
  return { text: localChatErrorMessage(error), detail: raw, kind: error.kind };
}
