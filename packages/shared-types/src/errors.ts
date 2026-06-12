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
    code: string,
    metadata?: JsonObject,
  ) {
    super(message, code, "permanent", false, metadata);
    this.name = "SessionError";
  }
}

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
