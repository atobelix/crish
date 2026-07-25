import { ErrorClassifier } from "../error-classifier";
import type { ProviderDiagnostic } from "@crish/shared-types";
import type {
  ProviderStreamErrorKind,
  ProviderStreamProviderError,
  ProviderStreamErrorInput
} from "./types";

export function classifyProviderStreamError(input: ProviderStreamErrorInput | ProviderDiagnostic | unknown): ProviderStreamProviderError {
  const record = objectRecord(input);
  const nestedError = record ? record.error : undefined;
  const nestedRecord = objectRecord(nestedError);
  const message =
    stringField(record?.message) ??
    stringField(record?.reason) ??
    stringField(nestedRecord?.message) ??
    stringField(record?.error) ??
    (input instanceof Error ? input.message : undefined) ??
    (typeof input === "string" ? input : undefined) ??
    "Provider stream failed";
  const status = numberField(record?.status);
  const statusText = stringField(record?.statusText);
  const code = stringField(record?.code) ?? stringField(nestedRecord?.code) ?? (input instanceof Error ? input.name : undefined);
  const headers = headersRecord(record?.headers);
  const explicitKind = providerStreamErrorKindField(record?.errorKind);
  const providerId = stringField(record?.providerId);
  const phase = providerStreamErrorPhaseField(record?.phase);
  const classifiedMsg = code ? `${message} ${code}` : message;
  const delegateKind = ErrorClassifier.classify(new Error(classifiedMsg), { headers: new Headers(headers), ...(status !== undefined ? { status } : {}) }).legacyKind as ProviderStreamErrorKind;
  const classified = explicitKind ?? (detectTimeout(classifiedMsg) ? "timeout" : delegateKind);
  const retryable = booleanField(record?.retryable) ?? defaultRetryableForProviderStreamError(classified);

  return {
    kind: classified,
    message,
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(statusText !== undefined ? { statusText } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(phase !== undefined ? { phase } : {})
  };
}

function detectTimeout(message: string): boolean {
  return /timeout|timed out/i.test(message);
}

function defaultRetryableForProviderStreamError(kind: ProviderStreamErrorKind): boolean {
  if (kind === "network" || kind === "rate-limit" || kind === "server" || kind === "timeout") return true;
  return false;
}

function providerStreamErrorKindField(value: unknown): ProviderStreamErrorKind | undefined {
  if (typeof value !== "string") return undefined;
  return providerStreamErrorKinds.includes(value as ProviderStreamErrorKind) ? (value as ProviderStreamErrorKind) : undefined;
}

function providerStreamErrorPhaseField(value: unknown): ProviderDiagnostic["phase"] | "stream" | undefined {
  if (value === "stream") return "stream";
  if (typeof value !== "string") return undefined;
  return providerDiagnosticPhases.includes(value as ProviderDiagnostic["phase"]) ? (value as ProviderDiagnostic["phase"]) : undefined;
}

function headersRecord(value: unknown): Record<string, string> {
  if (value instanceof Headers) {
    return Object.fromEntries([...value.entries()].map(([key, headerValue]) => [key.toLowerCase(), headerValue]));
  }
  const record = objectRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, headerValue]) => [key.toLowerCase(), headerValue])
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const providerStreamErrorKinds: readonly ProviderStreamErrorKind[] = [
  "network",
  "gateway-challenge",
  "rate-limit",
  "auth",
  "quota",
  "endpoint-unavailable",
  "schema",
  "server",
  "unknown",
  "timeout",
  "cancelled",
  "invalid-stream",
  "invalid-tool-call"
];

const providerDiagnosticPhases: readonly ProviderDiagnostic["phase"][] = [
  "request-start",
  "response-start",
  "sse-first-byte",
  "retry",
  "request-error",
  "stream-end",
  "endpoint-fallback",
  "transport-fallback",
  "model-selected",
  "model-mismatch"
];
