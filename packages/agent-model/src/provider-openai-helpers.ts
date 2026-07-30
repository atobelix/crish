import type { JsonObject, ProviderErrorKind } from '@crish/shared-types';
import {
  compactObject,
  textContent,
  type SystemPromptWireMode,
} from './openai-request-build';
import type { AgentProviderRequest } from './provider/types';
import { ErrorClassifier } from './error-classifier';
import { recordField, stringField } from './provider-openai-base';

export const DEFAULT_DIAGNOSTIC_HEADERS = [
  'cf-ray',
  'cf-cache-status',
  'x-request-id',
  'x-openrouter-provider',
  'x-openrouter-model',
  'x-openrouter-id',
  'x-vercel-id',
  'cf-mitigated',
  'retry-after',
  'content-type',
  'via',
  'server',
];

export async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ''}`;
}

export function classifyTransportProviderError(reason: string): {
  kind: ProviderErrorKind;
  retryable: boolean;
} {
  const classified = ErrorClassifier.classify(new Error(reason));
  return {
    kind: classified.legacyKind as ProviderErrorKind,
    retryable: classified.retryable,
  };
}

export function classifyStreamProviderError(
  reason: string,
  cause: unknown
): { kind: ProviderErrorKind; retryable: boolean } {
  const error = cause instanceof Error ? cause : new Error(reason);
  const classified = ErrorClassifier.classify(error);
  return {
    kind: classified.legacyKind as ProviderErrorKind,
    retryable: classified.retryable,
  };
}

export function classifyHttpProviderError(
  response: Response,
  error: string
): { kind: ProviderErrorKind; retryable: boolean } {
  const classified = ErrorClassifier.classify(new Error(error), {
    status: response.status,
    headers: response.headers,
  });
  return {
    kind: classified.legacyKind as ProviderErrorKind,
    retryable: classified.retryable,
  };
}

export function isResponsesEndpointUnavailable(
  status: number,
  error: string
): boolean {
  if (status === 404 || status === 405 || status === 415) return true;
  if (status === 400 || status === 422)
    return (
      /\bresponses?\b/i.test(error) &&
      /\b(unknown|unsupported|invalid|not found|not_found)\b/i.test(error)
    );
  return false;
}

export function isSystemRoleUnsupported(
  status: number,
  error: string
): boolean {
  if (status < 400 || status >= 500) return false;
  return /system\s+messages?\s+are\s+not\s+allowed|system\s+role\s+(is\s+)?(not\s+)?(allowed|supported)|role[^"'`]*system[^"'`]*(not\s+allowed|unsupported|invalid)/i.test(
    error
  );
}

export function hasSystemRoleWireContent(
  request: AgentProviderRequest
): boolean {
  return (
    Boolean(request.systemPrompt?.trim()) ||
    request.messages.some(
      (message) =>
        message.role === 'system' && textContent(message).trim().length > 0
    )
  );
}

export function requestDiagnosticFields(
  request: AgentProviderRequest,
  wireMode: SystemPromptWireMode,
  streamRequested: boolean
): Record<string, unknown> {
  const roleCounts = { system: 0, user: 0, assistant: 0, tool: 0 };
  let systemMessageCount = request.systemPrompt?.trim() ? 1 : 0;
  for (const message of request.messages) {
    roleCounts[message.role] += 1;
    if (message.role === 'system' && textContent(message).trim().length > 0)
      systemMessageCount += 1;
  }
  return compactObject({
    streamRequested,
    systemPromptWireMode: wireMode,
    hasSystemRole: systemMessageCount > 0,
    systemPromptPresent: Boolean(request.systemPrompt?.trim()),
    systemMessageCount,
    rewrittenSystemMessageCount:
      wireMode === 'user-prefix' ? systemMessageCount : 0,
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    messageRoleCounts: roleCounts,
  });
}

export function trimDiagnosticReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim();
  return normalized.length <= 500
    ? normalized
    : `${normalized.slice(0, 500)}...`;
}

export function actualModelFromPayload(body: JsonObject): string | undefined {
  return (
    stringField(body.model) ??
    stringField(recordField(body.response, undefined)?.model)
  );
}

export function providerBodyError(
  body: Record<string, unknown> | undefined
): string | undefined {
  if (!body) return undefined;
  const error = recordField(body.error, undefined);
  return (
    stringField(error?.message) ??
    stringField(body.error) ??
    stringField(body.message) ??
    stringField(body.error_description) ??
    stringField(body.code)
  );
}
