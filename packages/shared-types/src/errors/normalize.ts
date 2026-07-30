// packages/shared-types/src/errors/normalize.ts
// 权威定义：./03-ERROR-MIGRATION.md 附录 B、§3
import type { CrishErrorCode } from './codes';
import { CrishError } from './classes';

/**
 * 旧错误码 → 新 CrishErrorCode 映射。
 * 覆盖：SessionErrorCode、ProviderErrorKind、自由字符串码（含 TOOL_ERROR 拆分）、ErrorDomain。
 * 权威定义：./03-ERROR-MIGRATION.md §3 + 附录 B
 *
 * @param legacyCode 旧错误码字符串
 * @param context 拆分上下文（仅 TOOL_ERROR / ARTIFACT_ERROR / ADAPTER_ERROR / CLIENT_INVALID_INPUT 需要）
 */
export function migrateErrorCode(
  legacyCode: string,
  context?: {
    kind?: 'path' | 'input' | 'not_found' | 'execution';
    subType?: string;
  }
): CrishErrorCode {
  // ── SessionErrorCode（§3.1）──
  switch (legacyCode) {
    case 'not_found':
      return 'session.not_found';
    case 'invalid_session':
      return 'session.invalid_session';
    case 'invalid_entry':
      return 'session.invalid_entry';
    case 'invalid_state':
      return 'session.invalid_state';
    case 'storage':
      return 'session.storage_failed';
  }
  // ── ProviderErrorKind（§3.3）──
  switch (legacyCode) {
    case 'network':
      return 'provider.network';
    case 'gateway-challenge':
      return 'provider.gateway_challenge';
    case 'rate-limit':
      return 'provider.rate_limit';
    case 'auth':
      return 'provider.auth';
    case 'quota':
      return 'provider.quota';
    case 'endpoint-unavailable':
      return 'provider.endpoint_unavailable';
    case 'schema':
      return 'provider.schema';
    case 'server':
      return 'provider.server';
    case 'timeout':
      return 'provider.timeout';
    case 'cancelled':
      return 'provider.cancelled';
    case 'invalid-stream':
      return 'provider.stream_interrupted';
    case 'unknown':
      return 'provider.unknown';
  }
  // ── 自由字符串码（§3.4）──
  switch (legacyCode) {
    case 'CONFIG_ERROR':
      return 'config.invalid';
    case 'CHECKPOINT_ERROR':
      return 'store.corrupted';
    case 'BOUNDARY_ERROR':
      return 'store.corrupted';
    case 'ARTIFACT_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'artifact.invalid_uri';
    case 'ADAPTER_ERROR':
      return context?.kind === 'not_found'
        ? 'artifact.not_found'
        : 'store.corrupted';
    case 'SCOPED_CONTEXT_ERROR':
      return 'store.corrupted';
    case 'DAEMON_DEAD':
      return 'network.daemon_dead';
    case 'NETWORK_ERROR':
      return 'provider.network';
    case 'INVALID_RUN_STATE':
      return 'run.invalid_state';
    case 'NOT_A_GOAL_RUN':
      return 'run.not_goal_run';
    case 'DAEMON_ERROR':
      return 'network.daemon_dead';
  }
  // ── TOOL_ERROR 按 context.kind 拆分（§3.4，49 处 → 4 码）──
  if (legacyCode === 'TOOL_ERROR') {
    switch (context?.kind) {
      case 'path':
        return 'tool.path_escape';
      case 'input':
        return 'tool.invalid_input';
      case 'not_found':
        return 'tool.not_found';
      case 'execution':
        return 'tool.execution_failed';
      default:
        return 'tool.execution_failed';
    }
  }
  // ── ErrorDomain 枚举值（§3.2）──
  switch (legacyCode) {
    case 'USER_ABORT':
      return 'runtime.aborted';
    case 'TRANSIENT_NETWORK':
      return 'provider.network';
    case 'TRANSIENT_SERVER':
      return 'provider.server';
    case 'RATE_LIMIT':
      return 'provider.rate_limit';
    case 'CLIENT_AUTH':
      return 'provider.auth';
    case 'CLIENT_INVALID_INPUT':
      return context?.subType === 'context_length_exceeded'
        ? 'context.length_exceeded'
        : 'provider.schema';
    case 'QUOTA_EXHAUSTED':
      return 'provider.quota';
    case 'STREAM_INTERRUPT':
      return 'provider.stream_interrupted';
    case 'ENDPOINT_UNAVAILABLE':
      return 'provider.endpoint_unavailable';
    case 'GATEWAY_CHALLENGE':
      return 'provider.gateway_challenge';
    case 'UNKNOWN':
      return 'common.unknown';
  }
  return 'common.unknown';
}

/** 类型守卫：判断未知值是否为 CrishError 实例 */
export function isCrishError(value: unknown): value is CrishError {
  return value instanceof CrishError;
}

/**
 * 标准化函数：将任意错误（Error/CrishError/未知值）归一为 CrishError。
 * - CrishError 直接返回
 * - Error 用 common.unknown 包装
 * - 其他值用 String() 转为 message
 */
export function normalizeCrishError(error: unknown): CrishError {
  if (error instanceof CrishError) return error;
  if (error instanceof Error) {
    return new CrishError(error.message, 'common.unknown', 'permanent', false);
  }
  return new CrishError(String(error), 'common.unknown', 'permanent', false);
}
