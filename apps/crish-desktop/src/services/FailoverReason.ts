export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'provider_unavailable'
  | 'timeout'
  | 'internal'
  | 'network'
  | 'quota';

export interface ClassifiedError {
  reason: FailoverReason;
  retryable: boolean;
  recoverySuggestion: string;
}

export function classifyError(code: string, message: string): ClassifiedError {
  if (/auth|unauthorized|401|403/.test(message)) return { reason: 'auth', retryable: false, recoverySuggestion: '检查 API 密钥设置' };
  if (/rate|429|too many/.test(message)) return { reason: 'rate_limit', retryable: true, recoverySuggestion: '等待后重试' };
  if (/context|token.*limit|max.*length/.test(message)) return { reason: 'context_overflow', retryable: false, recoverySuggestion: '缩短对话内容' };
  if (/timeout|timed?out/.test(message)) return { reason: 'timeout', retryable: true, recoverySuggestion: '网络不稳定，请重试' };
  if (/unavailable|503|502|down/.test(message)) return { reason: 'provider_unavailable', retryable: true, recoverySuggestion: '服务暂不可用，请稍后重试' };
  if (/network|fetch|ECONNREFUSED|ENOTFOUND/.test(message)) return { reason: 'network', retryable: true, recoverySuggestion: '检查网络连接' };
  if (/quota|limit.*exceed/.test(message)) return { reason: 'quota', retryable: false, recoverySuggestion: '已超出配额限制' };
  return { reason: 'internal', retryable: false, recoverySuggestion: '未知错误，请联系支持' };
}
