// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)
// Registry: crates/conex-types/contracts/engine-events.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

import type {
  EngineEvent,
  EngineAgentStartEvent,
  EngineAgentEndEvent,
  EngineTurnStartEvent,
  EngineTurnEndEvent,
  EngineMessageStartEvent,
  EngineMessageDeltaEvent,
  EngineMessageEndEvent,
  EngineToolStartEvent,
  EngineToolUpdateEvent,
  EngineToolEndEvent,
  EngineToolBatchStartEvent,
  EngineToolBatchEndEvent,
  EngineToolInputRepairedEvent,
  EngineContextCompressionStartEvent,
  EngineContextCompressionEndEvent,
  EngineProviderDiagnosticEvent,
  EngineRuntimeErrorEvent,
  EngineRuntimeSteeringEvent,
  EngineRuntimeInterventionRequiredEvent,
  EngineApprovalRequestedEvent,
  EngineApprovalResolvedEvent,
  EngineCheckpointCreatedEvent,
  EngineCheckpointRestoredEvent,
  EngineRunTerminalEvent,
  EngineCacheStatsUpdatedEvent,
  EngineCacheWasteAlertEvent,
  EngineColdCacheWarningEvent,
} from './events';
import type {
  AgentMessage,
  AgentMessageBlock,
  AgentMessageBlockText,
  AgentMessageBlockThought,
  AgentMessageBlockToolCall,
  AgentMessageBlockToolResult,
  ToolOutput,
  ToolArtifact,
  ToolBatchCall,
  ToolBatchResult,
  ToolProgressUpdate,
  ProviderDiagnostic,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolMetadata,
  PermissionRequest,
  ContextCompressionPolicyMetadata,
  ContextCompressionHandoffMetadata,
  ContextCompressionCacheBoundaryMetadata,
  ContextCompressionRecord,
  RunCacheStats,
  AgentMessageRole,
  AgentEndReason,
  RunTerminalStatus,
  ApprovalDecision,
  ToolCategory,
  ToolConcurrency,
  ToolArtifactKind,
  ProviderDiagnosticPhase,
  SystemPromptWireMode,
  ProviderErrorKind,
  RuntimeCheckpointKind,
  ContextCompressionTrigger,
  ContextCompressionReason,
  ContextCompressionPolicyTier,
  ContextCompressionPolicyAction,
  CompressionCacheInvalidation,
  MissAttribution,
} from './types';
import {
  AGENT_MESSAGE_ROLE_VALUES,
  AGENT_END_REASON_VALUES,
  RUN_TERMINAL_STATUS_VALUES,
  APPROVAL_DECISION_VALUES,
  TOOL_CATEGORY_VALUES,
  TOOL_CONCURRENCY_VALUES,
  TOOL_ARTIFACT_KIND_VALUES,
  PROVIDER_DIAGNOSTIC_PHASE_VALUES,
  SYSTEM_PROMPT_WIRE_MODE_VALUES,
  PROVIDER_ERROR_KIND_VALUES,
  RUNTIME_CHECKPOINT_KIND_VALUES,
  CONTEXT_COMPRESSION_TRIGGER_VALUES,
  CONTEXT_COMPRESSION_REASON_VALUES,
  CONTEXT_COMPRESSION_POLICY_TIER_VALUES,
  CONTEXT_COMPRESSION_POLICY_ACTION_VALUES,
  COMPRESSION_CACHE_INVALIDATION_VALUES,
  MISS_ATTRIBUTION_VALUES,
} from './types';
import type { JsonValue } from '../../primitive-types';

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export function parseOk<T>(data: T): ParseResult<T> {
  return { ok: true, data };
}

export function parseErr(error: string): ParseResult<never> {
  return { ok: false, error };
}

export function isParseOk<T>(
  result: ParseResult<T>
): result is { readonly ok: true; readonly data: T } {
  return result.ok === true;
}

export function isParseErr<T>(
  result: ParseResult<T>
): result is { readonly ok: false; readonly error: string } {
  return result.ok === false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkString(v: unknown): ParseResult<string> {
  return typeof v === 'string' ? parseOk(v) : parseErr('expected a string');
}

function checkNumber(v: unknown): ParseResult<number> {
  return typeof v === 'number' && Number.isFinite(v)
    ? parseOk(v)
    : parseErr('expected a number');
}

function checkBoolean(v: unknown): ParseResult<boolean> {
  return typeof v === 'boolean' ? parseOk(v) : parseErr('expected a boolean');
}

function checkJsonValue(v: unknown): ParseResult<JsonValue> {
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    return parseOk(v);
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = checkJsonValue(item);
      if (!r.ok) return r;
    }
    return parseOk(v);
  }
  if (isRecord(v)) {
    for (const key of Object.keys(v)) {
      const r = checkJsonValue(v[key]);
      if (!r.ok) return r;
    }
    return parseOk(v as JsonValue);
  }
  return parseErr('expected a JSON value');
}

function parseArrayOf<T>(
  v: unknown,
  item: (x: unknown) => ParseResult<T>
): ParseResult<T[]> {
  if (!Array.isArray(v)) return parseErr('expected an array');
  const out: T[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = item(v[i]);
    if (!r.ok) return parseErr('array item ' + i + ': ' + r.error);
    out.push(r.data);
  }
  return parseOk(out);
}

function reqField<T>(
  obj: Record<string, unknown>,
  key: string,
  parser: (v: unknown) => ParseResult<T>
): ParseResult<T> {
  if (!(key in obj)) return parseErr("missing required field '" + key + "'");
  return parser(obj[key]);
}

function optField<T>(
  obj: Record<string, unknown>,
  key: string,
  parser: (v: unknown) => ParseResult<T>
): ParseResult<T | undefined> {
  const v = obj[key];
  if (v === undefined) return parseOk(undefined);
  return parser(v);
}

export function parseAgentMessageRole(
  v: unknown
): ParseResult<AgentMessageRole> {
  if (
    typeof v === 'string' &&
    (AGENT_MESSAGE_ROLE_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as AgentMessageRole);
  }
  return parseErr(
    'AgentMessageRole: expected one of ' + AGENT_MESSAGE_ROLE_VALUES.join(', ')
  );
}

export function parseAgentEndReason(v: unknown): ParseResult<AgentEndReason> {
  if (
    typeof v === 'string' &&
    (AGENT_END_REASON_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as AgentEndReason);
  }
  return parseErr(
    'AgentEndReason: expected one of ' + AGENT_END_REASON_VALUES.join(', ')
  );
}

export function parseRunTerminalStatus(
  v: unknown
): ParseResult<RunTerminalStatus> {
  if (
    typeof v === 'string' &&
    (RUN_TERMINAL_STATUS_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as RunTerminalStatus);
  }
  return parseErr(
    'RunTerminalStatus: expected one of ' +
      RUN_TERMINAL_STATUS_VALUES.join(', ')
  );
}

export function parseApprovalDecision(
  v: unknown
): ParseResult<ApprovalDecision> {
  if (
    typeof v === 'string' &&
    (APPROVAL_DECISION_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ApprovalDecision);
  }
  return parseErr(
    'ApprovalDecision: expected one of ' + APPROVAL_DECISION_VALUES.join(', ')
  );
}

export function parseToolCategory(v: unknown): ParseResult<ToolCategory> {
  if (
    typeof v === 'string' &&
    (TOOL_CATEGORY_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ToolCategory);
  }
  return parseErr(
    'ToolCategory: expected one of ' + TOOL_CATEGORY_VALUES.join(', ')
  );
}

export function parseToolConcurrency(v: unknown): ParseResult<ToolConcurrency> {
  if (
    typeof v === 'string' &&
    (TOOL_CONCURRENCY_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ToolConcurrency);
  }
  return parseErr(
    'ToolConcurrency: expected one of ' + TOOL_CONCURRENCY_VALUES.join(', ')
  );
}

export function parseToolArtifactKind(
  v: unknown
): ParseResult<ToolArtifactKind> {
  if (
    typeof v === 'string' &&
    (TOOL_ARTIFACT_KIND_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ToolArtifactKind);
  }
  return parseErr(
    'ToolArtifactKind: expected one of ' + TOOL_ARTIFACT_KIND_VALUES.join(', ')
  );
}

export function parseProviderDiagnosticPhase(
  v: unknown
): ParseResult<ProviderDiagnosticPhase> {
  if (
    typeof v === 'string' &&
    (PROVIDER_DIAGNOSTIC_PHASE_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ProviderDiagnosticPhase);
  }
  return parseErr(
    'ProviderDiagnosticPhase: expected one of ' +
      PROVIDER_DIAGNOSTIC_PHASE_VALUES.join(', ')
  );
}

export function parseSystemPromptWireMode(
  v: unknown
): ParseResult<SystemPromptWireMode> {
  if (
    typeof v === 'string' &&
    (SYSTEM_PROMPT_WIRE_MODE_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as SystemPromptWireMode);
  }
  return parseErr(
    'SystemPromptWireMode: expected one of ' +
      SYSTEM_PROMPT_WIRE_MODE_VALUES.join(', ')
  );
}

export function parseProviderErrorKind(
  v: unknown
): ParseResult<ProviderErrorKind> {
  if (
    typeof v === 'string' &&
    (PROVIDER_ERROR_KIND_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ProviderErrorKind);
  }
  return parseErr(
    'ProviderErrorKind: expected one of ' +
      PROVIDER_ERROR_KIND_VALUES.join(', ')
  );
}

export function parseRuntimeCheckpointKind(
  v: unknown
): ParseResult<RuntimeCheckpointKind> {
  if (
    typeof v === 'string' &&
    (RUNTIME_CHECKPOINT_KIND_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as RuntimeCheckpointKind);
  }
  return parseErr(
    'RuntimeCheckpointKind: expected one of ' +
      RUNTIME_CHECKPOINT_KIND_VALUES.join(', ')
  );
}

export function parseContextCompressionTrigger(
  v: unknown
): ParseResult<ContextCompressionTrigger> {
  if (
    typeof v === 'string' &&
    (CONTEXT_COMPRESSION_TRIGGER_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ContextCompressionTrigger);
  }
  return parseErr(
    'ContextCompressionTrigger: expected one of ' +
      CONTEXT_COMPRESSION_TRIGGER_VALUES.join(', ')
  );
}

export function parseContextCompressionReason(
  v: unknown
): ParseResult<ContextCompressionReason> {
  if (
    typeof v === 'string' &&
    (CONTEXT_COMPRESSION_REASON_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ContextCompressionReason);
  }
  return parseErr(
    'ContextCompressionReason: expected one of ' +
      CONTEXT_COMPRESSION_REASON_VALUES.join(', ')
  );
}

export function parseContextCompressionPolicyTier(
  v: unknown
): ParseResult<ContextCompressionPolicyTier> {
  if (
    typeof v === 'string' &&
    (CONTEXT_COMPRESSION_POLICY_TIER_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ContextCompressionPolicyTier);
  }
  return parseErr(
    'ContextCompressionPolicyTier: expected one of ' +
      CONTEXT_COMPRESSION_POLICY_TIER_VALUES.join(', ')
  );
}

export function parseContextCompressionPolicyAction(
  v: unknown
): ParseResult<ContextCompressionPolicyAction> {
  if (
    typeof v === 'string' &&
    (CONTEXT_COMPRESSION_POLICY_ACTION_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as ContextCompressionPolicyAction);
  }
  return parseErr(
    'ContextCompressionPolicyAction: expected one of ' +
      CONTEXT_COMPRESSION_POLICY_ACTION_VALUES.join(', ')
  );
}

export function parseCompressionCacheInvalidation(
  v: unknown
): ParseResult<CompressionCacheInvalidation> {
  if (
    typeof v === 'string' &&
    (COMPRESSION_CACHE_INVALIDATION_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as CompressionCacheInvalidation);
  }
  return parseErr(
    'CompressionCacheInvalidation: expected one of ' +
      COMPRESSION_CACHE_INVALIDATION_VALUES.join(', ')
  );
}

export function parseMissAttribution(v: unknown): ParseResult<MissAttribution> {
  if (
    typeof v === 'string' &&
    (MISS_ATTRIBUTION_VALUES as readonly string[]).includes(v)
  ) {
    return parseOk(v as MissAttribution);
  }
  return parseErr(
    'MissAttribution: expected one of ' + MISS_ATTRIBUTION_VALUES.join(', ')
  );
}

export function parseAgentMessage(v: unknown): ParseResult<AgentMessage> {
  if (!isRecord(v)) return parseErr('AgentMessage: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const role = reqField(v, 'role', parseAgentMessageRole);
  if (!role.ok) return role;
  const createdAt = reqField(v, 'createdAt', checkString);
  if (!createdAt.ok) return createdAt;
  const blocks = reqField(v, 'blocks', (x) =>
    parseArrayOf(x, parseAgentMessageBlock)
  );
  if (!blocks.ok) return blocks;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  const clientMessageId = optField(v, 'clientMessageId', checkString);
  if (!clientMessageId.ok) return clientMessageId;
  const content = optField(v, 'content', checkString);
  if (!content.ok) return content;
  return parseOk({
    id: id.data,
    role: role.data,
    createdAt: createdAt.data,
    blocks: blocks.data,
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
    ...(clientMessageId.data !== undefined
      ? { clientMessageId: clientMessageId.data }
      : {}),
    ...(content.data !== undefined ? { content: content.data } : {}),
  });
}

export function parseAgentMessageBlockText(
  v: unknown
): ParseResult<AgentMessageBlockText> {
  if (!isRecord(v))
    return parseErr('AgentMessageBlockText: payload must be an object');
  if (v['type'] !== 'text')
    return parseErr('AgentMessageBlockText: type mismatch');
  const text = reqField(v, 'text', checkString);
  if (!text.ok) return text;
  return parseOk({
    type: 'text',
    text: text.data,
  });
}

export function parseAgentMessageBlockThought(
  v: unknown
): ParseResult<AgentMessageBlockThought> {
  if (!isRecord(v))
    return parseErr('AgentMessageBlockThought: payload must be an object');
  if (v['type'] !== 'thought')
    return parseErr('AgentMessageBlockThought: type mismatch');
  const text = reqField(v, 'text', checkString);
  if (!text.ok) return text;
  const redacted = optField(v, 'redacted', checkBoolean);
  if (!redacted.ok) return redacted;
  return parseOk({
    type: 'thought',
    text: text.data,
    ...(redacted.data !== undefined ? { redacted: redacted.data } : {}),
  });
}

export function parseAgentMessageBlockToolCall(
  v: unknown
): ParseResult<AgentMessageBlockToolCall> {
  if (!isRecord(v))
    return parseErr('AgentMessageBlockToolCall: payload must be an object');
  if (v['type'] !== 'tool-call')
    return parseErr('AgentMessageBlockToolCall: type mismatch');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const input = reqField(v, 'input', checkJsonValue);
  if (!input.ok) return input;
  return parseOk({
    type: 'tool-call',
    id: id.data,
    toolName: toolName.data,
    input: input.data,
  });
}

export function parseAgentMessageBlockToolResult(
  v: unknown
): ParseResult<AgentMessageBlockToolResult> {
  if (!isRecord(v))
    return parseErr('AgentMessageBlockToolResult: payload must be an object');
  if (v['type'] !== 'tool-result')
    return parseErr('AgentMessageBlockToolResult: type mismatch');
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const output = reqField(v, 'output', parseToolOutput);
  if (!output.ok) return output;
  const isError = reqField(v, 'isError', checkBoolean);
  if (!isError.ok) return isError;
  return parseOk({
    type: 'tool-result',
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    output: output.data,
    isError: isError.data,
  });
}

export function parseAgentMessageBlock(
  v: unknown
): ParseResult<AgentMessageBlock> {
  if (!isRecord(v))
    return parseErr('AgentMessageBlock: payload must be an object');
  const t = v['type'];
  switch (t) {
    case 'text':
      return parseAgentMessageBlockText(v);
    case 'thought':
      return parseAgentMessageBlockThought(v);
    case 'tool-call':
      return parseAgentMessageBlockToolCall(v);
    case 'tool-result':
      return parseAgentMessageBlockToolResult(v);
    default:
      return parseErr("AgentMessageBlock: unknown type '" + String(t) + "'");
  }
}

export function parseToolOutput(v: unknown): ParseResult<ToolOutput> {
  if (!isRecord(v)) return parseErr('ToolOutput: payload must be an object');
  const text = optField(v, 'text', checkString);
  if (!text.ok) return text;
  const json = optField(v, 'json', checkJsonValue);
  if (!json.ok) return json;
  const artifacts = optField(v, 'artifacts', (x) =>
    parseArrayOf(x, parseToolArtifact)
  );
  if (!artifacts.ok) return artifacts;
  return parseOk({
    ...(text.data !== undefined ? { text: text.data } : {}),
    ...(json.data !== undefined ? { json: json.data } : {}),
    ...(artifacts.data !== undefined ? { artifacts: artifacts.data } : {}),
  });
}

export function parseToolArtifact(v: unknown): ParseResult<ToolArtifact> {
  if (!isRecord(v)) return parseErr('ToolArtifact: payload must be an object');
  const kind = reqField(v, 'kind', parseToolArtifactKind);
  if (!kind.ok) return kind;
  const title = reqField(v, 'title', checkString);
  if (!title.ok) return title;
  const uri = optField(v, 'uri', checkString);
  if (!uri.ok) return uri;
  const text = optField(v, 'text', checkString);
  if (!text.ok) return text;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  return parseOk({
    kind: kind.data,
    title: title.data,
    ...(uri.data !== undefined ? { uri: uri.data } : {}),
    ...(text.data !== undefined ? { text: text.data } : {}),
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
  });
}

export function parseToolBatchCall(v: unknown): ParseResult<ToolBatchCall> {
  if (!isRecord(v)) return parseErr('ToolBatchCall: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const summary = reqField(v, 'summary', checkString);
  if (!summary.ok) return summary;
  const input = reqField(v, 'input', checkJsonValue);
  if (!input.ok) return input;
  const category = reqField(v, 'category', parseToolCategory);
  if (!category.ok) return category;
  const concurrency = reqField(v, 'concurrency', parseToolConcurrency);
  if (!concurrency.ok) return concurrency;
  return parseOk({
    id: id.data,
    toolName: toolName.data,
    summary: summary.data,
    input: input.data,
    category: category.data,
    concurrency: concurrency.data,
  });
}

export function parseToolBatchResult(v: unknown): ParseResult<ToolBatchResult> {
  if (!isRecord(v))
    return parseErr('ToolBatchResult: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const output = reqField(v, 'output', parseToolOutput);
  if (!output.ok) return output;
  const isError = reqField(v, 'isError', checkBoolean);
  if (!isError.ok) return isError;
  const durationMs = reqField(v, 'durationMs', checkNumber);
  if (!durationMs.ok) return durationMs;
  return parseOk({
    id: id.data,
    toolName: toolName.data,
    output: output.data,
    isError: isError.data,
    durationMs: durationMs.data,
  });
}

export function parseToolProgressUpdate(
  v: unknown
): ParseResult<ToolProgressUpdate> {
  if (!isRecord(v))
    return parseErr('ToolProgressUpdate: payload must be an object');
  const text = optField(v, 'text', checkString);
  if (!text.ok) return text;
  const json = optField(v, 'json', checkJsonValue);
  if (!json.ok) return json;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  return parseOk({
    ...(text.data !== undefined ? { text: text.data } : {}),
    ...(json.data !== undefined ? { json: json.data } : {}),
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
  });
}

export function parseProviderDiagnostic(
  v: unknown
): ParseResult<ProviderDiagnostic> {
  if (!isRecord(v))
    return parseErr('ProviderDiagnostic: payload must be an object');
  const phase = reqField(v, 'phase', parseProviderDiagnosticPhase);
  if (!phase.ok) return phase;
  const providerId = optField(v, 'providerId', checkString);
  if (!providerId.ok) return providerId;
  const endpoint = optField(v, 'endpoint', checkString);
  if (!endpoint.ok) return endpoint;
  const url = optField(v, 'url', checkString);
  if (!url.ok) return url;
  const attempt = optField(v, 'attempt', checkNumber);
  if (!attempt.ok) return attempt;
  const maxAttempts = optField(v, 'maxAttempts', checkNumber);
  if (!maxAttempts.ok) return maxAttempts;
  const elapsedMs = optField(v, 'elapsedMs', checkNumber);
  if (!elapsedMs.ok) return elapsedMs;
  const status = optField(v, 'status', checkNumber);
  if (!status.ok) return status;
  const statusText = optField(v, 'statusText', checkString);
  if (!statusText.ok) return statusText;
  const retryable = optField(v, 'retryable', checkBoolean);
  if (!retryable.ok) return retryable;
  const reason = optField(v, 'reason', checkString);
  if (!reason.ok) return reason;
  const errorKind = optField(v, 'errorKind', parseProviderErrorKind);
  if (!errorKind.ok) return errorKind;
  const retryAfterMs = optField(v, 'retryAfterMs', checkNumber);
  if (!retryAfterMs.ok) return retryAfterMs;
  const chunks = optField(v, 'chunks', checkNumber);
  if (!chunks.ok) return chunks;
  const bytes = optField(v, 'bytes', checkNumber);
  if (!bytes.ok) return bytes;
  const headers = optField(v, 'headers', checkJsonValue);
  if (!headers.ok) return headers;
  const configuredModel = optField(v, 'configuredModel', checkString);
  if (!configuredModel.ok) return configuredModel;
  const actualModel = optField(v, 'actualModel', checkString);
  if (!actualModel.ok) return actualModel;
  const modelMismatch = optField(v, 'modelMismatch', checkBoolean);
  if (!modelMismatch.ok) return modelMismatch;
  const streamRequested = optField(v, 'streamRequested', checkBoolean);
  if (!streamRequested.ok) return streamRequested;
  const systemPromptWireMode = optField(
    v,
    'systemPromptWireMode',
    parseSystemPromptWireMode
  );
  if (!systemPromptWireMode.ok) return systemPromptWireMode;
  const hasSystemRole = optField(v, 'hasSystemRole', checkBoolean);
  if (!hasSystemRole.ok) return hasSystemRole;
  const systemPromptPresent = optField(v, 'systemPromptPresent', checkBoolean);
  if (!systemPromptPresent.ok) return systemPromptPresent;
  const systemMessageCount = optField(v, 'systemMessageCount', checkNumber);
  if (!systemMessageCount.ok) return systemMessageCount;
  const rewrittenSystemMessageCount = optField(
    v,
    'rewrittenSystemMessageCount',
    checkNumber
  );
  if (!rewrittenSystemMessageCount.ok) return rewrittenSystemMessageCount;
  const messageCount = optField(v, 'messageCount', checkNumber);
  if (!messageCount.ok) return messageCount;
  const toolCount = optField(v, 'toolCount', checkNumber);
  if (!toolCount.ok) return toolCount;
  const messageRoleCounts = optField(v, 'messageRoleCounts', checkJsonValue);
  if (!messageRoleCounts.ok) return messageRoleCounts;
  const partial = optField(v, 'partial', checkJsonValue);
  if (!partial.ok) return partial;
  return parseOk({
    phase: phase.data,
    ...(providerId.data !== undefined ? { providerId: providerId.data } : {}),
    ...(endpoint.data !== undefined ? { endpoint: endpoint.data } : {}),
    ...(url.data !== undefined ? { url: url.data } : {}),
    ...(attempt.data !== undefined ? { attempt: attempt.data } : {}),
    ...(maxAttempts.data !== undefined
      ? { maxAttempts: maxAttempts.data }
      : {}),
    ...(elapsedMs.data !== undefined ? { elapsedMs: elapsedMs.data } : {}),
    ...(status.data !== undefined ? { status: status.data } : {}),
    ...(statusText.data !== undefined ? { statusText: statusText.data } : {}),
    ...(retryable.data !== undefined ? { retryable: retryable.data } : {}),
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
    ...(errorKind.data !== undefined ? { errorKind: errorKind.data } : {}),
    ...(retryAfterMs.data !== undefined
      ? { retryAfterMs: retryAfterMs.data }
      : {}),
    ...(chunks.data !== undefined ? { chunks: chunks.data } : {}),
    ...(bytes.data !== undefined ? { bytes: bytes.data } : {}),
    ...(headers.data !== undefined ? { headers: headers.data } : {}),
    ...(configuredModel.data !== undefined
      ? { configuredModel: configuredModel.data }
      : {}),
    ...(actualModel.data !== undefined
      ? { actualModel: actualModel.data }
      : {}),
    ...(modelMismatch.data !== undefined
      ? { modelMismatch: modelMismatch.data }
      : {}),
    ...(streamRequested.data !== undefined
      ? { streamRequested: streamRequested.data }
      : {}),
    ...(systemPromptWireMode.data !== undefined
      ? { systemPromptWireMode: systemPromptWireMode.data }
      : {}),
    ...(hasSystemRole.data !== undefined
      ? { hasSystemRole: hasSystemRole.data }
      : {}),
    ...(systemPromptPresent.data !== undefined
      ? { systemPromptPresent: systemPromptPresent.data }
      : {}),
    ...(systemMessageCount.data !== undefined
      ? { systemMessageCount: systemMessageCount.data }
      : {}),
    ...(rewrittenSystemMessageCount.data !== undefined
      ? { rewrittenSystemMessageCount: rewrittenSystemMessageCount.data }
      : {}),
    ...(messageCount.data !== undefined
      ? { messageCount: messageCount.data }
      : {}),
    ...(toolCount.data !== undefined ? { toolCount: toolCount.data } : {}),
    ...(messageRoleCounts.data !== undefined
      ? { messageRoleCounts: messageRoleCounts.data }
      : {}),
    ...(partial.data !== undefined ? { partial: partial.data } : {}),
  });
}

export function parseRuntimeCheckpointRecord(
  v: unknown
): ParseResult<RuntimeCheckpointRecord> {
  if (!isRecord(v))
    return parseErr('RuntimeCheckpointRecord: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const kind = reqField(v, 'kind', parseRuntimeCheckpointKind);
  if (!kind.ok) return kind;
  const label = reqField(v, 'label', checkString);
  if (!label.ok) return label;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const artifactUri = optField(v, 'artifactUri', checkString);
  if (!artifactUri.ok) return artifactUri;
  const manifestPath = optField(v, 'manifestPath', checkString);
  if (!manifestPath.ok) return manifestPath;
  const snapshotPath = optField(v, 'snapshotPath', checkString);
  if (!snapshotPath.ok) return snapshotPath;
  const sourcePath = optField(v, 'sourcePath', checkString);
  if (!sourcePath.ok) return sourcePath;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  return parseOk({
    id: id.data,
    kind: kind.data,
    label: label.data,
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    ...(artifactUri.data !== undefined
      ? { artifactUri: artifactUri.data }
      : {}),
    ...(manifestPath.data !== undefined
      ? { manifestPath: manifestPath.data }
      : {}),
    ...(snapshotPath.data !== undefined
      ? { snapshotPath: snapshotPath.data }
      : {}),
    ...(sourcePath.data !== undefined ? { sourcePath: sourcePath.data } : {}),
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
  });
}

export function parseRuntimeCheckpointRestoreRecord(
  v: unknown
): ParseResult<RuntimeCheckpointRestoreRecord> {
  if (!isRecord(v))
    return parseErr(
      'RuntimeCheckpointRestoreRecord: payload must be an object'
    );
  const checkpointId = reqField(v, 'checkpointId', checkString);
  if (!checkpointId.ok) return checkpointId;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const restored = reqField(v, 'restored', (x) => parseArrayOf(x, checkString));
  if (!restored.ok) return restored;
  const deleted = reqField(v, 'deleted', (x) => parseArrayOf(x, checkString));
  if (!deleted.ok) return deleted;
  const skipped = reqField(v, 'skipped', (x) => parseArrayOf(x, checkString));
  if (!skipped.ok) return skipped;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  return parseOk({
    checkpointId: checkpointId.data,
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    restored: restored.data,
    deleted: deleted.data,
    skipped: skipped.data,
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
  });
}

export function parseToolMetadata(v: unknown): ParseResult<ToolMetadata> {
  if (!isRecord(v)) return parseErr('ToolMetadata: payload must be an object');
  const category = optField(v, 'category', checkString);
  if (!category.ok) return category;
  const isReadOnly = optField(v, 'isReadOnly', checkBoolean);
  if (!isReadOnly.ok) return isReadOnly;
  const fatalOnError = optField(v, 'fatalOnError', checkBoolean);
  if (!fatalOnError.ok) return fatalOnError;
  const concurrency = optField(v, 'concurrency', checkString);
  if (!concurrency.ok) return concurrency;
  return parseOk({
    ...(category.data !== undefined ? { category: category.data } : {}),
    ...(isReadOnly.data !== undefined ? { isReadOnly: isReadOnly.data } : {}),
    ...(fatalOnError.data !== undefined
      ? { fatalOnError: fatalOnError.data }
      : {}),
    ...(concurrency.data !== undefined
      ? { concurrency: concurrency.data }
      : {}),
  });
}

export function parsePermissionRequest(
  v: unknown
): ParseResult<PermissionRequest> {
  if (!isRecord(v))
    return parseErr('PermissionRequest: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const cwd = reqField(v, 'cwd', checkString);
  if (!cwd.ok) return cwd;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const parameters = reqField(v, 'parameters', checkJsonValue);
  if (!parameters.ok) return parameters;
  const summary = reqField(v, 'summary', checkString);
  if (!summary.ok) return summary;
  const toolMetadata = reqField(v, 'toolMetadata', parseToolMetadata);
  if (!toolMetadata.ok) return toolMetadata;
  const metadata = optField(v, 'metadata', checkJsonValue);
  if (!metadata.ok) return metadata;
  return parseOk({
    id: id.data,
    sessionId: sessionId.data,
    cwd: cwd.data,
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    parameters: parameters.data,
    summary: summary.data,
    toolMetadata: toolMetadata.data,
    ...(metadata.data !== undefined ? { metadata: metadata.data } : {}),
  });
}

export function parseContextCompressionPolicyMetadata(
  v: unknown
): ParseResult<ContextCompressionPolicyMetadata> {
  if (!isRecord(v))
    return parseErr(
      'ContextCompressionPolicyMetadata: payload must be an object'
    );
  const tier = reqField(v, 'tier', parseContextCompressionPolicyTier);
  if (!tier.ok) return tier;
  const action = reqField(v, 'action', parseContextCompressionPolicyAction);
  if (!action.ok) return action;
  const forced = reqField(v, 'forced', checkBoolean);
  if (!forced.ok) return forced;
  const thresholdExceeded = reqField(v, 'thresholdExceeded', checkBoolean);
  if (!thresholdExceeded.ok) return thresholdExceeded;
  const providerRetry = reqField(v, 'providerRetry', checkBoolean);
  if (!providerRetry.ok) return providerRetry;
  return parseOk({
    tier: tier.data,
    action: action.data,
    forced: forced.data,
    thresholdExceeded: thresholdExceeded.data,
    providerRetry: providerRetry.data,
  });
}

export function parseContextCompressionHandoffMetadata(
  v: unknown
): ParseResult<ContextCompressionHandoffMetadata> {
  if (!isRecord(v))
    return parseErr(
      'ContextCompressionHandoffMetadata: payload must be an object'
    );
  const trigger = reqField(v, 'trigger', parseContextCompressionTrigger);
  if (!trigger.ok) return trigger;
  const reason = reqField(v, 'reason', parseContextCompressionReason);
  if (!reason.ok) return reason;
  const tier = reqField(v, 'tier', parseContextCompressionPolicyTier);
  if (!tier.ok) return tier;
  const action = reqField(v, 'action', parseContextCompressionPolicyAction);
  if (!action.ok) return action;
  const providerRetry = reqField(v, 'providerRetry', checkBoolean);
  if (!providerRetry.ok) return providerRetry;
  const summary = reqField(v, 'summary', checkString);
  if (!summary.ok) return summary;
  const compressedMessageCount = reqField(
    v,
    'compressedMessageCount',
    checkNumber
  );
  if (!compressedMessageCount.ok) return compressedMessageCount;
  const keptMessageCount = reqField(v, 'keptMessageCount', checkNumber);
  if (!keptMessageCount.ok) return keptMessageCount;
  const tokensBefore = reqField(v, 'tokensBefore', checkNumber);
  if (!tokensBefore.ok) return tokensBefore;
  const tokensAfter = reqField(v, 'tokensAfter', checkNumber);
  if (!tokensAfter.ok) return tokensAfter;
  const thresholdTokens = reqField(v, 'thresholdTokens', checkNumber);
  if (!thresholdTokens.ok) return thresholdTokens;
  const firstKeptMessageId = optField(v, 'firstKeptMessageId', checkString);
  if (!firstKeptMessageId.ok) return firstKeptMessageId;
  const lastMessageId = optField(v, 'lastMessageId', checkString);
  if (!lastMessageId.ok) return lastMessageId;
  const lastUserMessageId = optField(v, 'lastUserMessageId', checkString);
  if (!lastUserMessageId.ok) return lastUserMessageId;
  const completedTaskSummaries = reqField(v, 'completedTaskSummaries', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!completedTaskSummaries.ok) return completedTaskSummaries;
  const pendingTasks = reqField(v, 'pendingTasks', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!pendingTasks.ok) return pendingTasks;
  const sessionEvents = reqField(v, 'sessionEvents', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!sessionEvents.ok) return sessionEvents;
  const fileSnapshotHints = reqField(v, 'fileSnapshotHints', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!fileSnapshotHints.ok) return fileSnapshotHints;
  const recentSuccessfulCommands = reqField(
    v,
    'recentSuccessfulCommands',
    (x) => parseArrayOf(x, checkString)
  );
  if (!recentSuccessfulCommands.ok) return recentSuccessfulCommands;
  const recentFailedDiagnostics = reqField(v, 'recentFailedDiagnostics', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!recentFailedDiagnostics.ok) return recentFailedDiagnostics;
  return parseOk({
    trigger: trigger.data,
    reason: reason.data,
    tier: tier.data,
    action: action.data,
    providerRetry: providerRetry.data,
    summary: summary.data,
    compressedMessageCount: compressedMessageCount.data,
    keptMessageCount: keptMessageCount.data,
    tokensBefore: tokensBefore.data,
    tokensAfter: tokensAfter.data,
    thresholdTokens: thresholdTokens.data,
    ...(firstKeptMessageId.data !== undefined
      ? { firstKeptMessageId: firstKeptMessageId.data }
      : {}),
    ...(lastMessageId.data !== undefined
      ? { lastMessageId: lastMessageId.data }
      : {}),
    ...(lastUserMessageId.data !== undefined
      ? { lastUserMessageId: lastUserMessageId.data }
      : {}),
    completedTaskSummaries: completedTaskSummaries.data,
    pendingTasks: pendingTasks.data,
    sessionEvents: sessionEvents.data,
    fileSnapshotHints: fileSnapshotHints.data,
    recentSuccessfulCommands: recentSuccessfulCommands.data,
    recentFailedDiagnostics: recentFailedDiagnostics.data,
  });
}

export function parseContextCompressionCacheBoundaryMetadata(
  v: unknown
): ParseResult<ContextCompressionCacheBoundaryMetadata> {
  if (!isRecord(v))
    return parseErr(
      'ContextCompressionCacheBoundaryMetadata: payload must be an object'
    );
  const kind = reqField(v, 'kind', checkString);
  if (!kind.ok) return kind;
  const version = reqField(v, 'version', checkNumber);
  if (!version.ok) return version;
  const stablePrefixHash = reqField(v, 'stablePrefixHash', checkString);
  if (!stablePrefixHash.ok) return stablePrefixHash;
  const cacheKey = reqField(v, 'cacheKey', checkString);
  if (!cacheKey.ok) return cacheKey;
  const structuredSummaryCacheKey = reqField(
    v,
    'structuredSummaryCacheKey',
    checkString
  );
  if (!structuredSummaryCacheKey.ok) return structuredSummaryCacheKey;
  const structuredSummaryStableHash = reqField(
    v,
    'structuredSummaryStableHash',
    checkString
  );
  if (!structuredSummaryStableHash.ok) return structuredSummaryStableHash;
  const invalidates = reqField(v, 'invalidates', (x) =>
    parseArrayOf(x, parseCompressionCacheInvalidation)
  );
  if (!invalidates.ok) return invalidates;
  const invalidationReason = reqField(
    v,
    'invalidationReason',
    parseContextCompressionReason
  );
  if (!invalidationReason.ok) return invalidationReason;
  const compressedMessageIds = reqField(v, 'compressedMessageIds', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!compressedMessageIds.ok) return compressedMessageIds;
  const keptMessageIds = reqField(v, 'keptMessageIds', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!keptMessageIds.ok) return keptMessageIds;
  const firstKeptMessageId = optField(v, 'firstKeptMessageId', checkString);
  if (!firstKeptMessageId.ok) return firstKeptMessageId;
  return parseOk({
    kind: kind.data,
    version: version.data,
    stablePrefixHash: stablePrefixHash.data,
    cacheKey: cacheKey.data,
    structuredSummaryCacheKey: structuredSummaryCacheKey.data,
    structuredSummaryStableHash: structuredSummaryStableHash.data,
    invalidates: invalidates.data,
    invalidationReason: invalidationReason.data,
    compressedMessageIds: compressedMessageIds.data,
    keptMessageIds: keptMessageIds.data,
    ...(firstKeptMessageId.data !== undefined
      ? { firstKeptMessageId: firstKeptMessageId.data }
      : {}),
  });
}

export function parseContextCompressionRecord(
  v: unknown
): ParseResult<ContextCompressionRecord> {
  if (!isRecord(v))
    return parseErr('ContextCompressionRecord: payload must be an object');
  const id = reqField(v, 'id', checkString);
  if (!id.ok) return id;
  const trigger = reqField(v, 'trigger', parseContextCompressionTrigger);
  if (!trigger.ok) return trigger;
  const reason = optField(v, 'reason', parseContextCompressionReason);
  if (!reason.ok) return reason;
  const policy = optField(v, 'policy', parseContextCompressionPolicyMetadata);
  if (!policy.ok) return policy;
  const summary = reqField(v, 'summary', checkString);
  if (!summary.ok) return summary;
  const firstKeptMessageId = optField(v, 'firstKeptMessageId', checkString);
  if (!firstKeptMessageId.ok) return firstKeptMessageId;
  const compressedMessageIds = reqField(v, 'compressedMessageIds', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!compressedMessageIds.ok) return compressedMessageIds;
  const keptMessageIds = reqField(v, 'keptMessageIds', (x) =>
    parseArrayOf(x, checkString)
  );
  if (!keptMessageIds.ok) return keptMessageIds;
  const tokensBefore = reqField(v, 'tokensBefore', checkNumber);
  if (!tokensBefore.ok) return tokensBefore;
  const tokensAfter = reqField(v, 'tokensAfter', checkNumber);
  if (!tokensAfter.ok) return tokensAfter;
  const thresholdTokens = optField(v, 'thresholdTokens', checkNumber);
  if (!thresholdTokens.ok) return thresholdTokens;
  const createdAt = reqField(v, 'createdAt', checkString);
  if (!createdAt.ok) return createdAt;
  const handoff = optField(
    v,
    'handoff',
    parseContextCompressionHandoffMetadata
  );
  if (!handoff.ok) return handoff;
  const cacheBoundary = optField(
    v,
    'cacheBoundary',
    parseContextCompressionCacheBoundaryMetadata
  );
  if (!cacheBoundary.ok) return cacheBoundary;
  const details = optField(v, 'details', checkJsonValue);
  if (!details.ok) return details;
  return parseOk({
    id: id.data,
    trigger: trigger.data,
    ...(reason.data !== undefined ? { reason: reason.data } : {}),
    ...(policy.data !== undefined ? { policy: policy.data } : {}),
    summary: summary.data,
    ...(firstKeptMessageId.data !== undefined
      ? { firstKeptMessageId: firstKeptMessageId.data }
      : {}),
    compressedMessageIds: compressedMessageIds.data,
    keptMessageIds: keptMessageIds.data,
    tokensBefore: tokensBefore.data,
    tokensAfter: tokensAfter.data,
    ...(thresholdTokens.data !== undefined
      ? { thresholdTokens: thresholdTokens.data }
      : {}),
    createdAt: createdAt.data,
    ...(handoff.data !== undefined ? { handoff: handoff.data } : {}),
    ...(cacheBoundary.data !== undefined
      ? { cacheBoundary: cacheBoundary.data }
      : {}),
    ...(details.data !== undefined ? { details: details.data } : {}),
  });
}

export function parseRunCacheStats(v: unknown): ParseResult<RunCacheStats> {
  if (!isRecord(v)) return parseErr('RunCacheStats: payload must be an object');
  const promptTokens = reqField(v, 'promptTokens', checkNumber);
  if (!promptTokens.ok) return promptTokens;
  const completionTokens = reqField(v, 'completionTokens', checkNumber);
  if (!completionTokens.ok) return completionTokens;
  const totalTokens = reqField(v, 'totalTokens', checkNumber);
  if (!totalTokens.ok) return totalTokens;
  const cacheReadTokens = reqField(v, 'cacheReadTokens', checkNumber);
  if (!cacheReadTokens.ok) return cacheReadTokens;
  const cacheWriteTokens = reqField(v, 'cacheWriteTokens', checkNumber);
  if (!cacheWriteTokens.ok) return cacheWriteTokens;
  const cacheMissTokens = reqField(v, 'cacheMissTokens', checkNumber);
  if (!cacheMissTokens.ok) return cacheMissTokens;
  const sampleCount = reqField(v, 'sampleCount', checkNumber);
  if (!sampleCount.ok) return sampleCount;
  const hitRatio = optField(v, 'hitRatio', checkNumber);
  if (!hitRatio.ok) return hitRatio;
  const writeRatio = optField(v, 'writeRatio', checkNumber);
  if (!writeRatio.ok) return writeRatio;
  const missedTokens = reqField(v, 'missedTokens', checkNumber);
  if (!missedTokens.ok) return missedTokens;
  const warmUntilMs = optField(v, 'warmUntilMs', checkNumber);
  if (!warmUntilMs.ok) return warmUntilMs;
  return parseOk({
    promptTokens: promptTokens.data,
    completionTokens: completionTokens.data,
    totalTokens: totalTokens.data,
    cacheReadTokens: cacheReadTokens.data,
    cacheWriteTokens: cacheWriteTokens.data,
    cacheMissTokens: cacheMissTokens.data,
    sampleCount: sampleCount.data,
    ...(hitRatio.data !== undefined ? { hitRatio: hitRatio.data } : {}),
    ...(writeRatio.data !== undefined ? { writeRatio: writeRatio.data } : {}),
    missedTokens: missedTokens.data,
    ...(warmUntilMs.data !== undefined
      ? { warmUntilMs: warmUntilMs.data }
      : {}),
  });
}

export function parseEngineAgentStartEvent(
  v: unknown
): ParseResult<EngineAgentStartEvent> {
  if (!isRecord(v))
    return parseErr('EngineAgentStartEvent: payload must be an object');
  if (v['type'] !== 'agent-start')
    return parseErr('EngineAgentStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'agent-start',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineAgentEndEvent(
  v: unknown
): ParseResult<EngineAgentEndEvent> {
  if (!isRecord(v))
    return parseErr('EngineAgentEndEvent: payload must be an object');
  if (v['type'] !== 'agent-end')
    return parseErr('EngineAgentEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const reason = reqField(v, 'reason', parseAgentEndReason);
  if (!reason.ok) return reason;
  const error = optField(v, 'error', checkString);
  if (!error.ok) return error;
  return parseOk({
    type: 'agent-end',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    reason: reason.data,
    ...(error.data !== undefined ? { error: error.data } : {}),
  });
}

export function parseEngineTurnStartEvent(
  v: unknown
): ParseResult<EngineTurnStartEvent> {
  if (!isRecord(v))
    return parseErr('EngineTurnStartEvent: payload must be an object');
  if (v['type'] !== 'turn-start')
    return parseErr('EngineTurnStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const turnIndex = reqField(v, 'turnIndex', checkNumber);
  if (!turnIndex.ok) return turnIndex;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'turn-start',
    sessionId: sessionId.data,
    turnIndex: turnIndex.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineTurnEndEvent(
  v: unknown
): ParseResult<EngineTurnEndEvent> {
  if (!isRecord(v))
    return parseErr('EngineTurnEndEvent: payload must be an object');
  if (v['type'] !== 'turn-end')
    return parseErr('EngineTurnEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const turnIndex = reqField(v, 'turnIndex', checkNumber);
  if (!turnIndex.ok) return turnIndex;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const toolCallCount = reqField(v, 'toolCallCount', checkNumber);
  if (!toolCallCount.ok) return toolCallCount;
  return parseOk({
    type: 'turn-end',
    sessionId: sessionId.data,
    turnIndex: turnIndex.data,
    timestamp: timestamp.data,
    toolCallCount: toolCallCount.data,
  });
}

export function parseEngineMessageStartEvent(
  v: unknown
): ParseResult<EngineMessageStartEvent> {
  if (!isRecord(v))
    return parseErr('EngineMessageStartEvent: payload must be an object');
  if (v['type'] !== 'message-start')
    return parseErr('EngineMessageStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const message = reqField(v, 'message', parseAgentMessage);
  if (!message.ok) return message;
  return parseOk({
    type: 'message-start',
    sessionId: sessionId.data,
    message: message.data,
  });
}

export function parseEngineMessageDeltaEvent(
  v: unknown
): ParseResult<EngineMessageDeltaEvent> {
  if (!isRecord(v))
    return parseErr('EngineMessageDeltaEvent: payload must be an object');
  if (v['type'] !== 'message-delta')
    return parseErr('EngineMessageDeltaEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const messageId = reqField(v, 'messageId', checkString);
  if (!messageId.ok) return messageId;
  const block = reqField(v, 'block', parseAgentMessageBlock);
  if (!block.ok) return block;
  return parseOk({
    type: 'message-delta',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    messageId: messageId.data,
    block: block.data,
  });
}

export function parseEngineMessageEndEvent(
  v: unknown
): ParseResult<EngineMessageEndEvent> {
  if (!isRecord(v))
    return parseErr('EngineMessageEndEvent: payload must be an object');
  if (v['type'] !== 'message-end')
    return parseErr('EngineMessageEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const message = reqField(v, 'message', parseAgentMessage);
  if (!message.ok) return message;
  return parseOk({
    type: 'message-end',
    sessionId: sessionId.data,
    message: message.data,
  });
}

export function parseEngineToolStartEvent(
  v: unknown
): ParseResult<EngineToolStartEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolStartEvent: payload must be an object');
  if (v['type'] !== 'tool-start')
    return parseErr('EngineToolStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const batchId = reqField(v, 'batchId', checkString);
  if (!batchId.ok) return batchId;
  const call = reqField(v, 'call', parseToolBatchCall);
  if (!call.ok) return call;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'tool-start',
    sessionId: sessionId.data,
    batchId: batchId.data,
    call: call.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineToolUpdateEvent(
  v: unknown
): ParseResult<EngineToolUpdateEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolUpdateEvent: payload must be an object');
  if (v['type'] !== 'tool-update')
    return parseErr('EngineToolUpdateEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const batchId = reqField(v, 'batchId', checkString);
  if (!batchId.ok) return batchId;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const update = reqField(v, 'update', parseToolProgressUpdate);
  if (!update.ok) return update;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'tool-update',
    sessionId: sessionId.data,
    batchId: batchId.data,
    toolCallId: toolCallId.data,
    update: update.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineToolEndEvent(
  v: unknown
): ParseResult<EngineToolEndEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolEndEvent: payload must be an object');
  if (v['type'] !== 'tool-end')
    return parseErr('EngineToolEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const batchId = reqField(v, 'batchId', checkString);
  if (!batchId.ok) return batchId;
  const result = reqField(v, 'result', parseToolBatchResult);
  if (!result.ok) return result;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'tool-end',
    sessionId: sessionId.data,
    batchId: batchId.data,
    result: result.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineToolBatchStartEvent(
  v: unknown
): ParseResult<EngineToolBatchStartEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolBatchStartEvent: payload must be an object');
  if (v['type'] !== 'tool-batch-start')
    return parseErr('EngineToolBatchStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const batchId = reqField(v, 'batchId', checkString);
  if (!batchId.ok) return batchId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const summary = reqField(v, 'summary', checkString);
  if (!summary.ok) return summary;
  const calls = reqField(v, 'calls', (x) =>
    parseArrayOf(x, parseToolBatchCall)
  );
  if (!calls.ok) return calls;
  return parseOk({
    type: 'tool-batch-start',
    sessionId: sessionId.data,
    batchId: batchId.data,
    timestamp: timestamp.data,
    summary: summary.data,
    calls: calls.data,
  });
}

export function parseEngineToolBatchEndEvent(
  v: unknown
): ParseResult<EngineToolBatchEndEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolBatchEndEvent: payload must be an object');
  if (v['type'] !== 'tool-batch-end')
    return parseErr('EngineToolBatchEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const batchId = reqField(v, 'batchId', checkString);
  if (!batchId.ok) return batchId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const calls = reqField(v, 'calls', (x) =>
    parseArrayOf(x, parseToolBatchResult)
  );
  if (!calls.ok) return calls;
  return parseOk({
    type: 'tool-batch-end',
    sessionId: sessionId.data,
    batchId: batchId.data,
    timestamp: timestamp.data,
    calls: calls.data,
  });
}

export function parseEngineToolInputRepairedEvent(
  v: unknown
): ParseResult<EngineToolInputRepairedEvent> {
  if (!isRecord(v))
    return parseErr('EngineToolInputRepairedEvent: payload must be an object');
  if (v['type'] !== 'tool-input-repaired')
    return parseErr('EngineToolInputRepairedEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const toolName = reqField(v, 'toolName', checkString);
  if (!toolName.ok) return toolName;
  const notes = reqField(v, 'notes', (x) => parseArrayOf(x, checkString));
  if (!notes.ok) return notes;
  return parseOk({
    type: 'tool-input-repaired',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    toolCallId: toolCallId.data,
    toolName: toolName.data,
    notes: notes.data,
  });
}

export function parseEngineContextCompressionStartEvent(
  v: unknown
): ParseResult<EngineContextCompressionStartEvent> {
  if (!isRecord(v))
    return parseErr(
      'EngineContextCompressionStartEvent: payload must be an object'
    );
  if (v['type'] !== 'context-compression-start')
    return parseErr('EngineContextCompressionStartEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const reason = reqField(v, 'reason', checkString);
  if (!reason.ok) return reason;
  const tokensBefore = reqField(v, 'tokensBefore', checkNumber);
  if (!tokensBefore.ok) return tokensBefore;
  return parseOk({
    type: 'context-compression-start',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    reason: reason.data,
    tokensBefore: tokensBefore.data,
  });
}

export function parseEngineContextCompressionEndEvent(
  v: unknown
): ParseResult<EngineContextCompressionEndEvent> {
  if (!isRecord(v))
    return parseErr(
      'EngineContextCompressionEndEvent: payload must be an object'
    );
  if (v['type'] !== 'context-compression-end')
    return parseErr('EngineContextCompressionEndEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const result = optField(v, 'result', parseContextCompressionRecord);
  if (!result.ok) return result;
  const aborted = reqField(v, 'aborted', checkBoolean);
  if (!aborted.ok) return aborted;
  const error = optField(v, 'error', checkString);
  if (!error.ok) return error;
  return parseOk({
    type: 'context-compression-end',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    ...(result.data !== undefined ? { result: result.data } : {}),
    aborted: aborted.data,
    ...(error.data !== undefined ? { error: error.data } : {}),
  });
}

export function parseEngineProviderDiagnosticEvent(
  v: unknown
): ParseResult<EngineProviderDiagnosticEvent> {
  if (!isRecord(v))
    return parseErr('EngineProviderDiagnosticEvent: payload must be an object');
  if (v['type'] !== 'provider-diagnostic')
    return parseErr('EngineProviderDiagnosticEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const diagnostic = reqField(v, 'diagnostic', parseProviderDiagnostic);
  if (!diagnostic.ok) return diagnostic;
  return parseOk({
    type: 'provider-diagnostic',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    diagnostic: diagnostic.data,
  });
}

export function parseEngineRuntimeErrorEvent(
  v: unknown
): ParseResult<EngineRuntimeErrorEvent> {
  if (!isRecord(v))
    return parseErr('EngineRuntimeErrorEvent: payload must be an object');
  if (v['type'] !== 'runtime-error')
    return parseErr('EngineRuntimeErrorEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const error = reqField(v, 'error', checkString);
  if (!error.ok) return error;
  const retryable = optField(v, 'retryable', checkBoolean);
  if (!retryable.ok) return retryable;
  return parseOk({
    type: 'runtime-error',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    error: error.data,
    ...(retryable.data !== undefined ? { retryable: retryable.data } : {}),
  });
}

export function parseEngineRuntimeSteeringEvent(
  v: unknown
): ParseResult<EngineRuntimeSteeringEvent> {
  if (!isRecord(v))
    return parseErr('EngineRuntimeSteeringEvent: payload must be an object');
  if (v['type'] !== 'runtime-steering')
    return parseErr('EngineRuntimeSteeringEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const reason = reqField(v, 'reason', checkString);
  if (!reason.ok) return reason;
  const message = reqField(v, 'message', parseAgentMessage);
  if (!message.ok) return message;
  return parseOk({
    type: 'runtime-steering',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    reason: reason.data,
    message: message.data,
  });
}

export function parseEngineRuntimeInterventionRequiredEvent(
  v: unknown
): ParseResult<EngineRuntimeInterventionRequiredEvent> {
  if (!isRecord(v))
    return parseErr(
      'EngineRuntimeInterventionRequiredEvent: payload must be an object'
    );
  if (v['type'] !== 'runtime-intervention-required')
    return parseErr('EngineRuntimeInterventionRequiredEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const reason = reqField(v, 'reason', checkString);
  if (!reason.ok) return reason;
  const choices = reqField(v, 'choices', (x) => parseArrayOf(x, checkString));
  if (!choices.ok) return choices;
  const message = reqField(v, 'message', checkString);
  if (!message.ok) return message;
  return parseOk({
    type: 'runtime-intervention-required',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    reason: reason.data,
    choices: choices.data,
    message: message.data,
  });
}

export function parseEngineApprovalRequestedEvent(
  v: unknown
): ParseResult<EngineApprovalRequestedEvent> {
  if (!isRecord(v))
    return parseErr('EngineApprovalRequestedEvent: payload must be an object');
  if (v['type'] !== 'approval-requested')
    return parseErr('EngineApprovalRequestedEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const request = reqField(v, 'request', parsePermissionRequest);
  if (!request.ok) return request;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'approval-requested',
    sessionId: sessionId.data,
    request: request.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineApprovalResolvedEvent(
  v: unknown
): ParseResult<EngineApprovalResolvedEvent> {
  if (!isRecord(v))
    return parseErr('EngineApprovalResolvedEvent: payload must be an object');
  if (v['type'] !== 'approval-resolved')
    return parseErr('EngineApprovalResolvedEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const toolCallId = reqField(v, 'toolCallId', checkString);
  if (!toolCallId.ok) return toolCallId;
  const requestId = optField(v, 'requestId', checkString);
  if (!requestId.ok) return requestId;
  const decision = reqField(v, 'decision', parseApprovalDecision);
  if (!decision.ok) return decision;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  return parseOk({
    type: 'approval-resolved',
    sessionId: sessionId.data,
    toolCallId: toolCallId.data,
    ...(requestId.data !== undefined ? { requestId: requestId.data } : {}),
    decision: decision.data,
    timestamp: timestamp.data,
  });
}

export function parseEngineCheckpointCreatedEvent(
  v: unknown
): ParseResult<EngineCheckpointCreatedEvent> {
  if (!isRecord(v))
    return parseErr('EngineCheckpointCreatedEvent: payload must be an object');
  if (v['type'] !== 'checkpoint-created')
    return parseErr('EngineCheckpointCreatedEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const checkpoint = reqField(v, 'checkpoint', parseRuntimeCheckpointRecord);
  if (!checkpoint.ok) return checkpoint;
  return parseOk({
    type: 'checkpoint-created',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    checkpoint: checkpoint.data,
  });
}

export function parseEngineCheckpointRestoredEvent(
  v: unknown
): ParseResult<EngineCheckpointRestoredEvent> {
  if (!isRecord(v))
    return parseErr('EngineCheckpointRestoredEvent: payload must be an object');
  if (v['type'] !== 'checkpoint-restored')
    return parseErr('EngineCheckpointRestoredEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const restore = reqField(v, 'restore', parseRuntimeCheckpointRestoreRecord);
  if (!restore.ok) return restore;
  return parseOk({
    type: 'checkpoint-restored',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    restore: restore.data,
  });
}

export function parseEngineRunTerminalEvent(
  v: unknown
): ParseResult<EngineRunTerminalEvent> {
  if (!isRecord(v))
    return parseErr('EngineRunTerminalEvent: payload must be an object');
  if (v['type'] !== 'run-terminal')
    return parseErr('EngineRunTerminalEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const runId = reqField(v, 'runId', checkString);
  if (!runId.ok) return runId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const terminal = reqField(v, 'terminal', parseRunTerminalStatus);
  if (!terminal.ok) return terminal;
  const error = optField(v, 'error', checkString);
  if (!error.ok) return error;
  return parseOk({
    type: 'run-terminal',
    sessionId: sessionId.data,
    runId: runId.data,
    timestamp: timestamp.data,
    terminal: terminal.data,
    ...(error.data !== undefined ? { error: error.data } : {}),
  });
}

export function parseEngineCacheStatsUpdatedEvent(
  v: unknown
): ParseResult<EngineCacheStatsUpdatedEvent> {
  if (!isRecord(v))
    return parseErr('EngineCacheStatsUpdatedEvent: payload must be an object');
  if (v['type'] !== 'cache-stats-updated')
    return parseErr('EngineCacheStatsUpdatedEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const stats = reqField(v, 'stats', parseRunCacheStats);
  if (!stats.ok) return stats;
  return parseOk({
    type: 'cache-stats-updated',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    stats: stats.data,
  });
}

export function parseEngineCacheWasteAlertEvent(
  v: unknown
): ParseResult<EngineCacheWasteAlertEvent> {
  if (!isRecord(v))
    return parseErr('EngineCacheWasteAlertEvent: payload must be an object');
  if (v['type'] !== 'cache-waste-alert')
    return parseErr('EngineCacheWasteAlertEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const attribution = reqField(v, 'attribution', parseMissAttribution);
  if (!attribution.ok) return attribution;
  const missedTokens = reqField(v, 'missedTokens', checkNumber);
  if (!missedTokens.ok) return missedTokens;
  const idleMs = reqField(v, 'idleMs', checkNumber);
  if (!idleMs.ok) return idleMs;
  const modelChanged = reqField(v, 'modelChanged', checkBoolean);
  if (!modelChanged.ok) return modelChanged;
  const missedCostUsd = optField(v, 'missedCostUsd', checkNumber);
  if (!missedCostUsd.ok) return missedCostUsd;
  return parseOk({
    type: 'cache-waste-alert',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    attribution: attribution.data,
    missedTokens: missedTokens.data,
    idleMs: idleMs.data,
    modelChanged: modelChanged.data,
    ...(missedCostUsd.data !== undefined
      ? { missedCostUsd: missedCostUsd.data }
      : {}),
  });
}

export function parseEngineColdCacheWarningEvent(
  v: unknown
): ParseResult<EngineColdCacheWarningEvent> {
  if (!isRecord(v))
    return parseErr('EngineColdCacheWarningEvent: payload must be an object');
  if (v['type'] !== 'cold-cache-warning')
    return parseErr('EngineColdCacheWarningEvent: type mismatch');
  const sessionId = reqField(v, 'sessionId', checkString);
  if (!sessionId.ok) return sessionId;
  const timestamp = reqField(v, 'timestamp', checkString);
  if (!timestamp.ok) return timestamp;
  const ttlSeconds = reqField(v, 'ttlSeconds', checkNumber);
  if (!ttlSeconds.ok) return ttlSeconds;
  const idleMs = reqField(v, 'idleMs', checkNumber);
  if (!idleMs.ok) return idleMs;
  const resendEstimateTokens = reqField(v, 'resendEstimateTokens', checkNumber);
  if (!resendEstimateTokens.ok) return resendEstimateTokens;
  return parseOk({
    type: 'cold-cache-warning',
    sessionId: sessionId.data,
    timestamp: timestamp.data,
    ttlSeconds: ttlSeconds.data,
    idleMs: idleMs.data,
    resendEstimateTokens: resendEstimateTokens.data,
  });
}

export function parseEngineEvent(v: unknown): ParseResult<EngineEvent> {
  if (!isRecord(v)) return parseErr('engine event must be an object');
  const t = v['type'];
  if (typeof t !== 'string') return parseErr('engine event missing type');
  switch (t) {
    case 'agent-start':
      return parseEngineAgentStartEvent(v);
    case 'agent-end':
      return parseEngineAgentEndEvent(v);
    case 'turn-start':
      return parseEngineTurnStartEvent(v);
    case 'turn-end':
      return parseEngineTurnEndEvent(v);
    case 'message-start':
      return parseEngineMessageStartEvent(v);
    case 'message-delta':
      return parseEngineMessageDeltaEvent(v);
    case 'message-end':
      return parseEngineMessageEndEvent(v);
    case 'tool-start':
      return parseEngineToolStartEvent(v);
    case 'tool-update':
      return parseEngineToolUpdateEvent(v);
    case 'tool-end':
      return parseEngineToolEndEvent(v);
    case 'tool-batch-start':
      return parseEngineToolBatchStartEvent(v);
    case 'tool-batch-end':
      return parseEngineToolBatchEndEvent(v);
    case 'tool-input-repaired':
      return parseEngineToolInputRepairedEvent(v);
    case 'context-compression-start':
      return parseEngineContextCompressionStartEvent(v);
    case 'context-compression-end':
      return parseEngineContextCompressionEndEvent(v);
    case 'provider-diagnostic':
      return parseEngineProviderDiagnosticEvent(v);
    case 'runtime-error':
      return parseEngineRuntimeErrorEvent(v);
    case 'runtime-steering':
      return parseEngineRuntimeSteeringEvent(v);
    case 'runtime-intervention-required':
      return parseEngineRuntimeInterventionRequiredEvent(v);
    case 'approval-requested':
      return parseEngineApprovalRequestedEvent(v);
    case 'approval-resolved':
      return parseEngineApprovalResolvedEvent(v);
    case 'checkpoint-created':
      return parseEngineCheckpointCreatedEvent(v);
    case 'checkpoint-restored':
      return parseEngineCheckpointRestoredEvent(v);
    case 'run-terminal':
      return parseEngineRunTerminalEvent(v);
    case 'cache-stats-updated':
      return parseEngineCacheStatsUpdatedEvent(v);
    case 'cache-waste-alert':
      return parseEngineCacheWasteAlertEvent(v);
    case 'cold-cache-warning':
      return parseEngineColdCacheWarningEvent(v);
    default:
      return parseErr("unknown engine event type '" + t + "'");
  }
}
