// packages/shared-types/src/errors/classes.ts
import type { JsonObject } from '../primitive-types';
import type { CrishErrorCode, CrishErrorCategory } from './codes';
import { CRISH_ERROR_REGISTRY } from './info';

/**
 * Crish 错误基类（扩展版）。
 *
 * 共存阶段：code 字段接受新 CrishErrorCode 或旧裸 string。
 * 旧调用 `new CrishError(msg, "TOOL_ERROR", "permanent", false)` 继续工作。
 * 新调用 `new CrishError(msg, "tool.path_escape", "security", false, meta, { cause })`。
 *
 * 权威定义：./03-ERROR-MIGRATION.md 附录 A
 */
export class CrishError extends Error {
  readonly code: CrishErrorCode | string;
  readonly category: CrishErrorCategory;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action: string;
  readonly titleKey?: string;
  readonly actionKey?: string;
  readonly metadata?: JsonObject | undefined;
  readonly cause?: CrishError | undefined;

  constructor(
    message: string,
    code: CrishErrorCode | string,
    category: CrishErrorCategory,
    retryable: boolean,
    metadata?: JsonObject,
    options?: {
      cause?: CrishError;
      public?: boolean;
      action?: string;
      titleKey?: string;
      actionKey?: string;
    }
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    );
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.metadata = metadata;
    this.cause = options?.cause;
    // 旧码（不在注册表内）回退到 common.unknown 的元信息
    const info =
      typeof code === 'string' &&
      Object.prototype.hasOwnProperty.call(CRISH_ERROR_REGISTRY, code)
        ? CRISH_ERROR_REGISTRY[code as CrishErrorCode]
        : CRISH_ERROR_REGISTRY['common.unknown'];
    this.public = options?.public ?? info.public;
    this.action = options?.action ?? info.action;
    this.titleKey =
      options?.titleKey ?? info.titleKey ?? `error.${info.code}.title`;
    this.actionKey = options?.actionKey ?? info.actionKey ?? info.action;
    this.name = 'CrishError';
  }
}

/**
 * Provider 错误（deprecated 适配层，共存阶段保留）。
 * 迁移阶段构造函数改为接受 CrishErrorCode（provider.* 域）。
 * 删除阶段（Round 12）移除，统一用 CrishError(code="provider.*")。
 * @deprecated 改用 `new CrishError(msg, "provider.*", "transient"|"protocol"|"security", retryable)`
 * @see CrishError
 * @removeWhen Round 12 删除阶段统一用 CrishError
 */
export class ProviderError extends CrishError {
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    metadata?: JsonObject
  ) {
    super(message, code, 'transient', retryable, metadata);
    this.name = 'ProviderError';
  }
}

/**
 * 权限错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "plugin.permission_denied"|"tool.path_escape", "security", false)`
 * @see CrishError
 * @removeWhen Round 12 删除阶段统一用 CrishError
 */
export class PermissionError extends CrishError {
  constructor(message: string, code: string, metadata?: JsonObject) {
    super(message, code, 'security', false, metadata);
    this.name = 'PermissionError';
  }
}

/**
 * 会话错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "session.*", "permanent"|"transient", retryable)`
 * @see CrishError
 * @removeWhen Round 12 删除阶段统一用 CrishError
 */
export class SessionError extends CrishError {
  constructor(message: string, code: SessionErrorCode, metadata?: JsonObject) {
    super(message, code, 'permanent', false, metadata);
    this.name = 'SessionError';
  }
}

/**
 * 协议错误（deprecated 适配层）。
 * @deprecated 改用 `new CrishError(msg, "*.invalid_*"|"*.protocol_violation", "protocol", false)`
 * @see CrishError
 * @removeWhen Round 12 删除阶段统一用 CrishError
 */
export class ProtocolError extends CrishError {
  constructor(message: string, code: string, metadata?: JsonObject) {
    super(message, code, 'protocol', false, metadata);
    this.name = 'ProtocolError';
  }
}

/** 旧 SessionErrorCode 类型（deprecated，删除阶段移除） */
export type SessionErrorCode =
  | 'not_found'
  | 'invalid_session'
  | 'invalid_entry'
  | 'invalid_state'
  | 'storage';
