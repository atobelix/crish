import type { JsonObject } from '@crish/shared-types';

export type { JsonObject };

export type ProtocolValidationErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_MESSAGE_TYPE';

export interface ProtocolValidationIssue {
  path: string;
  message: string;
}

export interface ProtocolValidationError {
  code: ProtocolValidationErrorCode;
  message: string;
  issues: ProtocolValidationIssue[];
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolValidationError };

export type UnknownRecord = Record<string, unknown>;
