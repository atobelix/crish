import {
  isRecord as isRecordShared,
  isJsonObject,
  isJsonValue,
} from '@crish/shared-utils';
export { isJsonObject, isJsonValue };
import type { JsonObject } from '@crish/shared-types';
import type {
  DaemonEventCursorDiagnostic,
  DaemonEventReplayCursor,
  DaemonInboundMessage,
  DaemonOutboundMessage,
  SessionEventsMessage,
} from '../../types.js';
import type {
  ProtocolValidationIssue,
  ProtocolValidationResult,
  UnknownRecord,
} from './common-types.js';
import { APPROVAL_PROTOCOL_STATUSES } from './common-fields-entity.js';

export const isRecord = isRecordShared;

export function validateMessageBase<const T extends readonly string[]>(
  value: unknown,
  allowedTypes: T
): ProtocolValidationResult<UnknownRecord & { type: T[number] }> {
  if (!isRecord(value)) {
    return invalid('Message must be a JSON object', [
      { path: '$', message: 'Expected object' },
    ]);
  }

  const type = value.type;
  if (typeof type !== 'string' || type.length === 0) {
    return invalid('Message type is required', [
      { path: '$.type', message: 'Expected non-empty string' },
    ]);
  }

  if (!includesString(allowedTypes, type)) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_MESSAGE_TYPE',
        message: `Unknown message type: ${type}`,
        issues: [
          { path: '$.type', message: `Unsupported message type: ${type}` },
        ],
      },
    };
  }

  return ok(value as UnknownRecord & { type: T[number] });
}

export function withMessageCorrelation<
  T extends DaemonInboundMessage | DaemonOutboundMessage,
>(
  input: UnknownRecord,
  result: ProtocolValidationResult<T>
): ProtocolValidationResult<T> {
  if (!result.ok) return result;

  const issues: ProtocolValidationIssue[] = [];
  const requestId = optionalString(input, 'requestId', '$.requestId', issues, {
    nonEmpty: true,
  });
  const correlationId = optionalString(
    input,
    'correlationId',
    '$.correlationId',
    issues,
    {
      nonEmpty: true,
    }
  );

  if (issues.length > 0) return invalid('Invalid message correlation', issues);
  if (requestId === undefined && correlationId === undefined) return result;

  return ok({
    ...result.value,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

export function rejectUnknownFields(
  input: UnknownRecord,
  allowedFields: readonly string[],
  issues: ProtocolValidationIssue[],
  path = '$'
): void {
  for (const key of Object.keys(input)) {
    if (!includesString(allowedFields, key)) {
      issues.push({
        path: path === '$' ? `$.${key}` : `${path}.${key}`,
        message: 'Unexpected field',
      });
    }
  }
}

export function requiredString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }

  return readString(input[key], path, issues, options);
}

export function optionalString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): string | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return readString(input[key], path, issues, options);
}

export function validateOptionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean } = {}
): void {
  if (!(key in input) || input[key] === null) return;
  readString(input[key], path, issues, options);
}

export function readString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { nonEmpty?: boolean }
): string | undefined {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'Expected string' });
    return undefined;
  }

  if (options.nonEmpty && value.length === 0) {
    issues.push({ path, message: 'Expected non-empty string' });
    return undefined;
  }

  return value;
}

export function requiredInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }

  return readInteger(input[key], path, issues, options);
}

export function optionalInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return readInteger(input[key], path, issues, options);
}

export function requiredNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }
  return readNumber(input[key], path, issues, options);
}

export function optionalNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return readNumber(input[key], path, issues, options);
}

export function readNumber(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number; max?: number } = {}
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'Expected number' });
    return undefined;
  }
  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected number >= ${options.min}` });
    return undefined;
  }
  if (options.max !== undefined && value > options.max) {
    issues.push({ path, message: `Expected number <= ${options.max}` });
    return undefined;
  }
  return value;
}

export function optionalNullableNumber(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): number | null | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  if (input[key] === null) return null;
  return optionalNumber(input, key, path, issues);
}

export function requiredNullableInteger(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number } = {}
): number | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }
  if (input[key] === null) return null;
  return readInteger(input[key], path, issues, options);
}

export function optionalBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  if (typeof input[key] !== 'boolean') {
    issues.push({ path, message: 'Expected boolean' });
    return undefined;
  }
  return input[key];
}

export function requiredBoolean(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): boolean | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }
  if (typeof input[key] !== 'boolean') {
    issues.push({ path, message: 'Expected boolean' });
    return undefined;
  }
  return input[key];
}

export function optionalNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return readNullableString(input[key], path, issues);
}

export function requiredNullableString(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }
  return readNullableString(input[key], path, issues);
}

export function readNullableString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[]
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') {
    issues.push({ path, message: 'Expected string or null' });
    return undefined;
  }
  if (value.length === 0) {
    issues.push({ path, message: 'Expected non-empty string or null' });
    return undefined;
  }
  return value;
}

export function optionalJsonObject(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): JsonObject | undefined {
  if (!(key in input)) return undefined;
  if (!isJsonObject(input[key])) {
    issues.push({ path, message: 'Expected JSON object' });
    return undefined;
  }
  return input[key] as JsonObject;
}

export function requiredEventLogMetadata(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage['eventLog'] | undefined {
  const value = requiredRecord(input, key, path, issues);
  if (!value) return undefined;
  return readEventLogMetadata(value, path, issues);
}

export function readEventLogMetadata(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): SessionEventsMessage['eventLog'] | undefined {
  rejectUnknownFields(
    value,
    ['eventLogId', 'generation', 'schemaVersion', 'protocolVersion'],
    issues,
    path
  );
  const eventLogId = requiredString(
    value,
    'eventLogId',
    `${path}.eventLogId`,
    issues,
    { nonEmpty: true }
  );
  const generation = requiredInteger(
    value,
    'generation',
    `${path}.generation`,
    issues,
    { min: 1 }
  );
  const schemaVersion = requiredInteger(
    value,
    'schemaVersion',
    `${path}.schemaVersion`,
    issues,
    { min: 1 }
  );
  const protocolVersion = requiredInteger(
    value,
    'protocolVersion',
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({ path: `${path}.schemaVersion`, message: 'Expected 1' });
  }
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    issues.push({ path: `${path}.protocolVersion`, message: 'Expected 1' });
  }
  if (
    eventLogId === undefined ||
    generation === undefined ||
    schemaVersion === undefined ||
    protocolVersion === undefined
  ) {
    return undefined;
  }
  return {
    eventLogId,
    generation,
    schemaVersion: schemaVersion as 1,
    protocolVersion: protocolVersion as 1,
  };
}

export function optionalEventReplayCursor(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: 'Expected object' });
    return undefined;
  }
  return readEventReplayCursor(input[key], path, issues);
}

export function readEventReplayCursor(
  value: UnknownRecord,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventReplayCursor | undefined {
  rejectUnknownFields(
    value,
    [
      'eventLogId',
      'generation',
      'schemaVersion',
      'protocolVersion',
      'afterSequence',
      'lastEventId',
    ],
    issues,
    path
  );
  const eventLogId = requiredString(
    value,
    'eventLogId',
    `${path}.eventLogId`,
    issues,
    { nonEmpty: true }
  );
  const generation = requiredInteger(
    value,
    'generation',
    `${path}.generation`,
    issues,
    { min: 1 }
  );
  const schemaVersion = requiredInteger(
    value,
    'schemaVersion',
    `${path}.schemaVersion`,
    issues,
    { min: 1 }
  );
  const protocolVersion = requiredInteger(
    value,
    'protocolVersion',
    `${path}.protocolVersion`,
    issues,
    { min: 1 }
  );
  const afterSequence = requiredInteger(
    value,
    'afterSequence',
    `${path}.afterSequence`,
    issues,
    { min: 0 }
  );
  const lastEventId = optionalString(
    value,
    'lastEventId',
    `${path}.lastEventId`,
    issues,
    { nonEmpty: true }
  );
  if (
    eventLogId === undefined ||
    generation === undefined ||
    schemaVersion === undefined ||
    protocolVersion === undefined ||
    afterSequence === undefined
  ) {
    return undefined;
  }
  return {
    eventLogId,
    generation,
    schemaVersion,
    protocolVersion,
    afterSequence,
    lastEventId,
  };
}

export function optionalEventCursorDiagnostic(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): DaemonEventCursorDiagnostic | undefined {
  if (!(key in input)) return undefined;
  if (!isRecord(input[key])) {
    issues.push({ path, message: 'Expected object' });
    return undefined;
  }
  const value = input[key];
  rejectUnknownFields(
    value,
    [
      'code',
      'message',
      'severity',
      'previous',
      'current',
      'replayedFromSequence',
    ],
    issues,
    path
  );
  const code = requiredString(value, 'code', `${path}.code`, issues, {
    nonEmpty: true,
  });
  if (code !== undefined && code !== 'EVENT_LOG_CURSOR_MISMATCH') {
    issues.push({
      path: `${path}.code`,
      message: 'Expected EVENT_LOG_CURSOR_MISMATCH',
    });
  }
  const message = requiredString(value, 'message', `${path}.message`, issues, {
    nonEmpty: true,
  });
  const severity = requiredString(
    value,
    'severity',
    `${path}.severity`,
    issues,
    { nonEmpty: true }
  );
  if (severity !== undefined && severity !== 'warning') {
    issues.push({ path: `${path}.severity`, message: 'Expected warning' });
  }
  const previous = optionalEventReplayCursor(
    value,
    'previous',
    `${path}.previous`,
    issues
  );
  const current = requiredEventLogMetadata(
    value,
    'current',
    `${path}.current`,
    issues
  );
  const replayedFromSequence = requiredInteger(
    value,
    'replayedFromSequence',
    `${path}.replayedFromSequence`,
    issues,
    { min: 0 }
  );
  if (
    code !== 'EVENT_LOG_CURSOR_MISMATCH' ||
    message === undefined ||
    severity !== 'warning' ||
    current === undefined ||
    replayedFromSequence === undefined
  ) {
    return undefined;
  }
  return {
    code,
    message,
    severity,
    previous,
    current,
    replayedFromSequence,
  };
}

export function readInteger(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  options: { min?: number }
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push({ path, message: 'Expected integer' });
    return undefined;
  }

  if (options.min !== undefined && value < options.min) {
    issues.push({ path, message: `Expected integer >= ${options.min}` });
    return undefined;
  }

  return value;
}

export function requiredRecord(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): UnknownRecord | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }

  if (!isRecord(input[key])) {
    issues.push({ path, message: 'Expected object' });
    return undefined;
  }

  return input[key] as UnknownRecord;
}

export function requiredArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }

  if (!Array.isArray(input[key])) {
    issues.push({ path, message: 'Expected array' });
    return undefined;
  }

  return input[key];
}

export function optionalArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): unknown[] | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: 'Expected array' });
    return undefined;
  }
  return input[key];
}

export function requiredStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  const values = requiredArray(input, key, path, issues);
  if (!values) return undefined;
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({
        path: `${path}[${index}]`,
        message: 'Expected non-empty string',
      });
    }
  });
  return values as string[];
}

export function optionalStringArray(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): string[] | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  if (!Array.isArray(input[key])) {
    issues.push({ path, message: 'Expected array' });
    return undefined;
  }
  const values = input[key] as unknown[];
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({
        path: `${path}[${index}]`,
        message: 'Expected non-empty string',
      });
    }
  });
  return values as string[];
}

export function requiredEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input)) {
    issues.push({ path, message: 'Required field is missing' });
    return undefined;
  }

  return readEnum(input[key], path, values, issues);
}

export function optionalEnum<const T extends readonly string[]>(
  input: UnknownRecord,
  key: string,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  return readEnum(input[key], path, values, issues);
}

export function requiredApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return requiredEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

export function optionalApprovalProtocolStatus(
  input: UnknownRecord,
  key: string,
  path: string,
  issues: ProtocolValidationIssue[]
): (typeof APPROVAL_PROTOCOL_STATUSES)[number] | undefined {
  return optionalEnum(input, key, path, APPROVAL_PROTOCOL_STATUSES, issues);
}

export function readEnum<const T extends readonly string[]>(
  value: unknown,
  path: string,
  values: T,
  issues: ProtocolValidationIssue[]
): T[number] | undefined {
  if (typeof value !== 'string' || !includesString(values, value)) {
    issues.push({
      path,
      message: `Expected one of: ${values.join(', ')}`,
    });
    return undefined;
  }

  return value;
}

export function includesString<const T extends readonly string[]>(
  values: T,
  value: string
): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export function ok<T>(value: T): ProtocolValidationResult<T> {
  return { ok: true, value };
}

export function invalid<T = never>(
  message: string,
  issues: ProtocolValidationIssue[]
): ProtocolValidationResult<T> {
  return {
    ok: false,
    error: {
      code: 'INVALID_MESSAGE',
      message,
      issues,
    },
  };
}

