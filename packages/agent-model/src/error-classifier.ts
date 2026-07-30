/**
 * @alpha Round 4 临时 shim — 完整 ErrorClassifier 实现在 Round 5 通过 @crish/agent-core 提供。
 *
 * 本 shim 从 agent-runtime/src/error-classifier.ts 裁剪而来，移除了对 transport 层
 * (ConnectionError / StreamInterruptedError) 的依赖，仅保留 provider 级分类逻辑
 * (HTTP 状态码 + 消息模式匹配)。transport 级错误分类将在 Round 5 由 agent-core
 * 的完整实现补回。
 *
 * 唯一权威来源：Round 5 迁移后为 @crish/agent-core。共存阶段本文件与
 * agent-runtime/src/error-classifier.ts 并存（禁令 23：共存→迁移→删除）。
 */

export enum ErrorDomain {
  USER_ABORT = 'USER_ABORT',
  TRANSIENT_NETWORK = 'TRANSIENT_NETWORK',
  TRANSIENT_SERVER = 'TRANSIENT_SERVER',
  RATE_LIMIT = 'RATE_LIMIT',
  CLIENT_AUTH = 'CLIENT_AUTH',
  CLIENT_INVALID_INPUT = 'CLIENT_INVALID_INPUT',
  QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED',
  STREAM_INTERRUPT = 'STREAM_INTERRUPT',
  ENDPOINT_UNAVAILABLE = 'ENDPOINT_UNAVAILABLE',
  GATEWAY_CHALLENGE = 'GATEWAY_CHALLENGE',
  UNKNOWN = 'UNKNOWN',
}

export type UiSeverity = 'silent' | 'info' | 'warning' | 'error';

export interface ClassifiedError {
  domain: ErrorDomain;
  retryable: boolean;
  uiSeverity: UiSeverity;
  subType?: string;
  httpStatus?: number;
  providerId?: string;
  legacyKind: string;
  recoveryHint?: string;
  retryAfterMs?: number;
  originalError?: unknown;
}

export interface ErrorClassifierOptions {
  signal?: AbortSignal;
  status?: number;
  headers?: Headers;
  providerId?: string;
}

const DEFAULT_MATRIX: Record<
  ErrorDomain,
  { retryable: boolean; uiSeverity: UiSeverity; legacyKind: string }
> = {
  [ErrorDomain.USER_ABORT]: {
    retryable: false,
    uiSeverity: 'silent',
    legacyKind: 'cancelled',
  },
  [ErrorDomain.TRANSIENT_NETWORK]: {
    retryable: true,
    uiSeverity: 'warning',
    legacyKind: 'network',
  },
  [ErrorDomain.TRANSIENT_SERVER]: {
    retryable: true,
    uiSeverity: 'warning',
    legacyKind: 'server',
  },
  [ErrorDomain.RATE_LIMIT]: {
    retryable: true,
    uiSeverity: 'info',
    legacyKind: 'rate-limit',
  },
  [ErrorDomain.CLIENT_AUTH]: {
    retryable: false,
    uiSeverity: 'error',
    legacyKind: 'auth',
  },
  [ErrorDomain.CLIENT_INVALID_INPUT]: {
    retryable: false,
    uiSeverity: 'warning',
    legacyKind: 'schema',
  },
  [ErrorDomain.QUOTA_EXHAUSTED]: {
    retryable: false,
    uiSeverity: 'error',
    legacyKind: 'quota',
  },
  [ErrorDomain.STREAM_INTERRUPT]: {
    retryable: true,
    uiSeverity: 'info',
    legacyKind: 'invalid-stream',
  },
  [ErrorDomain.ENDPOINT_UNAVAILABLE]: {
    retryable: false,
    uiSeverity: 'error',
    legacyKind: 'endpoint-unavailable',
  },
  [ErrorDomain.GATEWAY_CHALLENGE]: {
    retryable: false,
    uiSeverity: 'warning',
    legacyKind: 'gateway-challenge',
  },
  [ErrorDomain.UNKNOWN]: {
    retryable: false,
    uiSeverity: 'error',
    legacyKind: 'unknown',
  },
};

export class ErrorClassifier {
  static classify(
    error: unknown,
    options?: ErrorClassifierOptions
  ): ClassifiedError {
    const { signal, status, headers, providerId } = options ?? {};
    const message = error instanceof Error ? error.message : String(error);
    const lowerMsg = typeof message === 'string' ? message.toLowerCase() : '';

    if (signal?.aborted || isAbortError(error)) {
      return buildResult(ErrorDomain.USER_ABORT, {
        httpStatus: status,
        providerId,
        originalError: error,
        recoveryHint: '请求已被用户取消',
      });
    }

    if (status === 413) {
      return buildResult(ErrorDomain.CLIENT_INVALID_INPUT, {
        subType: 'payload_too_large',
        httpStatus: status,
        providerId,
        originalError: error,
        legacyKind: 'payload-too-large',
      });
    }

    if (looksLikeGatewayChallenge(headers, lowerMsg)) {
      return buildResult(ErrorDomain.GATEWAY_CHALLENGE, {
        httpStatus: status,
        providerId,
        originalError: error,
        recoveryHint: 'Cloudflare 质询拦截',
      });
    }

    if (status === 401 || status === 403) {
      return buildResult(ErrorDomain.CLIENT_AUTH, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (status === 402) {
      return buildResult(ErrorDomain.QUOTA_EXHAUSTED, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (status === 404 || status === 405 || status === 415) {
      return buildResult(ErrorDomain.ENDPOINT_UNAVAILABLE, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (status === 400 || status === 422) {
      const isCtxOverflow = detectContextLengthExceeded(lowerMsg);
      const isPayloadTooLarge = looksLikePayloadTooLargeMessage(lowerMsg);
      return buildResult(ErrorDomain.CLIENT_INVALID_INPUT, {
        subType: isCtxOverflow
          ? 'context_length_exceeded'
          : isPayloadTooLarge
            ? 'payload_too_large'
            : undefined,
        httpStatus: status,
        providerId,
        originalError: error,
        legacyKind: isCtxOverflow
          ? 'context-overflow'
          : isPayloadTooLarge
            ? 'payload-too-large'
            : 'schema',
        retryable: isCtxOverflow,
      });
    }

    if (status === 429) {
      return buildResult(ErrorDomain.RATE_LIMIT, {
        httpStatus: status,
        providerId,
        originalError: error,
        retryAfterMs: parseRetryAfter(headers),
      });
    }

    // NOTE: Round 4 shim 省略 StreamInterruptedError / ConnectionError 的 instanceof
    // 分支（transport 层错误归 agent-core，Round 5 补回）。流中断与连接错误在此
    // 由后续消息模式匹配兜底分类。

    if (/aborted|cancelled|canceled/i.test(lowerMsg)) {
      return buildResult(ErrorDomain.USER_ABORT, {
        httpStatus: status,
        providerId,
        originalError: error,
        recoveryHint: '请求已被用户取消',
      });
    }

    if (detectContextLengthExceeded(lowerMsg)) {
      return buildResult(ErrorDomain.CLIENT_INVALID_INPUT, {
        subType: 'context_length_exceeded',
        httpStatus: status,
        providerId,
        originalError: error,
        legacyKind: 'context-overflow',
        retryable: true,
      });
    }

    if (
      /unauthorized|forbidden|invalid api key|invalid authentication/i.test(
        lowerMsg
      )
    ) {
      return buildResult(ErrorDomain.CLIENT_AUTH, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (
      /insufficient.*(quota|balance|credit)|quota exceeded|out of credits/i.test(
        lowerMsg
      )
    ) {
      return buildResult(ErrorDomain.QUOTA_EXHAUSTED, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (/rate.?limit|too many requests/i.test(lowerMsg)) {
      return buildResult(ErrorDomain.RATE_LIMIT, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (
      /request_too_large|request too large|payload too large|entity too large/i.test(
        lowerMsg
      ) ||
      /(?:^|[^0-9])413(?:[^0-9]|$)/.test(lowerMsg)
    ) {
      return buildResult(ErrorDomain.CLIENT_INVALID_INPUT, {
        subType: 'payload_too_large',
        httpStatus: status,
        providerId,
        originalError: error,
        legacyKind: 'payload-too-large',
      });
    }

    if (
      status !== undefined &&
      [500, 502, 503, 504, 520, 522, 523, 524].includes(status)
    ) {
      return buildResult(ErrorDomain.TRANSIENT_SERVER, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (
      /\b502\b|\b503\b|\b504\b|\b520\b|\b522\b|\b523\b|\b524\b|bad gateway|gateway timeout|server error|overloaded|temporarily unavailable/i.test(
        lowerMsg
      )
    ) {
      return buildResult(ErrorDomain.TRANSIENT_SERVER, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    if (/timeout|timed out/i.test(lowerMsg)) {
      return buildResult(ErrorDomain.TRANSIENT_NETWORK, {
        httpStatus: status,
        providerId,
        originalError: error,
        recoveryHint: '请求超时',
      });
    }

    if (
      /econnreset|enotfound|econnrefused|fetch failed|network|socket hang up/i.test(
        lowerMsg
      )
    ) {
      return buildResult(ErrorDomain.TRANSIENT_NETWORK, {
        httpStatus: status,
        providerId,
        originalError: error,
      });
    }

    return buildResult(ErrorDomain.UNKNOWN, {
      httpStatus: status,
      providerId,
      originalError: error,
    });
  }
}

type ClassifiedErrorInput<T> = { [K in keyof T]?: T[K] | undefined };

function buildResult(
  domain: ErrorDomain,
  overrides?: ClassifiedErrorInput<ClassifiedError>
): ClassifiedError {
  const defaults =
    DEFAULT_MATRIX[domain] ?? DEFAULT_MATRIX[ErrorDomain.UNKNOWN];
  return {
    domain,
    retryable: overrides?.retryable ?? defaults.retryable,
    uiSeverity: overrides?.uiSeverity ?? defaults.uiSeverity,
    legacyKind: overrides?.legacyKind ?? defaults.legacyKind,
    ...(overrides?.subType !== undefined ? { subType: overrides.subType } : {}),
    ...(overrides?.httpStatus !== undefined
      ? { httpStatus: overrides.httpStatus }
      : {}),
    ...(overrides?.providerId !== undefined
      ? { providerId: overrides.providerId }
      : {}),
    ...(overrides?.recoveryHint !== undefined
      ? { recoveryHint: overrides.recoveryHint }
      : {}),
    ...(overrides?.retryAfterMs !== undefined
      ? { retryAfterMs: overrides.retryAfterMs }
      : {}),
    ...(overrides?.originalError !== undefined
      ? { originalError: overrides.originalError }
      : {}),
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted/i.test(error.message))
  )
    return true;
  return false;
}

function detectContextLengthExceeded(msg: string): boolean {
  return /context.*length.*exceed|maximum.*context|too long|context_length_exceeded/i.test(
    msg
  );
}

export function looksLikePayloadTooLargeMessage(msg: string): boolean {
  if (/4130\d*|model\s+version\s+4130/i.test(msg)) return false;
  return /payload\s+too\s+large|request_too_large|entity\s+too\s+large|request\s+exceeds\s+the\s+maximum\s+size|413/i.test(
    msg
  );
}

function parseRetryAfter(headers?: Headers): number | undefined {
  if (!headers) return undefined;
  const raw = headers.get('retry-after') ?? headers.get('Retry-After');
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const parsed = new Date(raw).getTime();
  if (!isNaN(parsed)) return parsed - Date.now();
  return undefined;
}

function looksLikeGatewayChallenge(
  headers?: Headers,
  message?: string
): boolean {
  if (!message) return false;
  const mitigated = headers?.get('cf-mitigated') ?? '';
  const server = headers?.get('server') ?? '';
  return (
    /challenge/i.test(mitigated) ||
    (/cloudflare/i.test(server) &&
      /challenge|just a moment|cf_chl|challenge-platform|enable javascript/i.test(
        message
      )) ||
    /cf_chl|challenge-platform|just a moment|enable javascript and cookies/i.test(
      message
    )
  );
}
