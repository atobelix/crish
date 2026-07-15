import type { JsonObject } from "./primitive-types";

export class ConexError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly category: "transient" | "permanent" | "security" | "protocol",
    public readonly retryable: boolean,
    public readonly metadata?: JsonObject,
  ) {
    super(message);
    this.name = "ConexError";
  }
}

export class ProviderError extends ConexError {
  constructor(
    message: string,
    code: string,
    retryable: boolean,
    metadata?: JsonObject,
  ) {
    super(message, code, "transient", retryable, metadata);
    this.name = "ProviderError";
  }
}

export class PermissionError extends ConexError {
  constructor(
    message: string,
    code: string,
    metadata?: JsonObject,
  ) {
    super(message, code, "security", false, metadata);
    this.name = "PermissionError";
  }
}

export class SessionError extends ConexError {
  constructor(
    message: string,
    code: SessionErrorCode,
    metadata?: JsonObject,
  ) {
    super(message, code, "permanent", false, metadata);
    this.name = "SessionError";
  }
}

/**
 * Session 子系统的错误码。
 *
 * 对齐 Pi 的 SessionErrorCode 模式，使用联合类型替代 string，
 * 在编译时即可捕获无效错误码。
 */
export type SessionErrorCode =
  | "not_found"
  | "invalid_session"
  | "invalid_entry"
  | "invalid_state"
  | "storage";

export class ProtocolError extends ConexError {
  constructor(
    message: string,
    code: string,
    metadata?: JsonObject,
  ) {
    super(message, code, "protocol", false, metadata);
    this.name = "ProtocolError";
  }
}
