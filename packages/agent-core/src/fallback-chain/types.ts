export type FallbackTarget = string | { id: string; provider?: string };

export type FallbackErrorType =
  | "rate-limit"
  | "context-overflow"
  | "timeout"
  | "server-error"
  | "auth-error"
  | "bad-request"
  | "network-error"
  | "quota-exhausted"
  | "unknown";

export interface FallbackConfig {
  onError?: FallbackTarget[];
  onRateLimit?: FallbackTarget[];
  onContextOverflow?: FallbackTarget[];
  onTimeout?: FallbackTarget[];
  onServerError?: FallbackTarget[];
  onQuotaExhausted?: FallbackTarget[];
  onNetworkError?: FallbackTarget[];
  maxAttempts: number;
}

export interface FallbackEvent {
  primaryModelId: string;
  fallbackModelId: string;
  errorType: FallbackErrorType;
  attemptIndex: number;
  latencyMs: number;
  message: string;
}

export type FallbackErrorClassifier = (error: unknown, status?: number) => {
  type: FallbackErrorType;
  retryable: boolean;
  message: string;
};
