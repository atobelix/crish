/**
 * runtime-helpers — AgentRuntime 使用的独立辅助函数
 *
 * 从 runtime.ts 中提取的纯函数，减少 runtime.ts 的代码量。
 * 这些函数不依赖 AgentRuntime 实例，可独立测试。
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentMessageBlock,
  JsonObject,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
  ToolBatchResult,
  ToolOutput,
  ToolResultBlock,
  PermissionDecision,
} from '@crish/shared-types';
import type { AgentTool, RuntimeRecoveryReason } from './types';
import { errorMessage as sharedErrorMessage } from '@crish/shared-utils';
import { createId, type SessionMessageEntry } from './session';
import { stringifyToolOutput } from './tool-output-budget';

// ─── 事件辅助 ──────────────────────────────────────────────

export function* flushEvents(events: AgentEvent[]): Generator<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

// ─── 消息辅助 ──────────────────────────────────────────────

export function withSessionEntryMetadata(
  message: AgentMessage,
  entry: SessionMessageEntry
): AgentMessage {
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      runtimeSessionEntryId: entry.id,
      runtimeLeafIdBefore: entry.parentId,
      runtimeLeafIdAfter: entry.id,
    },
  };
}

// ─── 错误检测 ──────────────────────────────────────────────

export function detectRecentToolErrorLoop(
  messages: AgentMessage[],
  minErrors: number
): RuntimeRecoveryReason | undefined {
  let errors = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'system' || message.role === 'assistant') continue;
    if (message.role === 'user') break;
    if (message.role !== 'tool') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool-result') continue;
      if (!isToolResultFailure(block)) return undefined;
      errors += 1;
      if (errors >= minErrors) return 'tool-errors';
    }
  }
  return undefined;
}

function isToolResultFailure(block: ToolResultBlock): boolean {
  if (block.isError) return true;
  const exitCode = exitCodeFromToolOutput(block.output);
  return exitCode !== undefined && exitCode !== 0;
}

function exitCodeFromToolOutput(output: ToolOutput): number | undefined {
  const json = output.json;
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    const exitCode =
      numberFromUnknown(record.exitCode) ?? numberFromUnknown(record.exit_code);
    if (exitCode !== undefined) return exitCode;
  }
  const match = stringifyToolOutput(output).match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function detectRepeatedToolCallLoop(
  messages: AgentMessage[],
  minRepeats: number
): RuntimeRecoveryReason | undefined {
  const counts = new Map<string, number>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue;
      const signature = `${block.toolName}:${JSON.stringify(block.input)}`;
      const next = (counts.get(signature) ?? 0) + 1;
      if (next >= minRepeats) return 'tool-loop';
      counts.set(signature, next);
    }
  }
  return undefined;
}

export function isNoProgressAssistant(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false;
  return !message.blocks.some((block: AgentMessageBlock) => {
    if (block.type === 'text') return block.text.trim().length > 0;
    if (block.type === 'tool-call') return true;
    if (block.type === 'tool-result') return true;
    return false;
  });
}

// ─── Steering 文本生成 ────────────────────────────────────

export function runtimeSteeringText(reason: RuntimeRecoveryReason): string {
  if (reason === 'tool-errors') {
    return [
      'Runtime steering: recent tool calls failed repeatedly.',
      'Do not repeat the same call. Diagnose the failure briefly, change the arguments or strategy, and continue only with a materially different next action.',
      'If the blocker cannot be resolved with the available tools, stop and explain the blocker.',
    ].join('\n');
  }
  if (reason === 'empty-response') {
    return [
      'Runtime steering: the previous assistant turn produced no visible text and no tool call.',
      'Do not stop silently. Either call the next required tool or explain the blocker in one concise message.',
      'If the user requested file creation or inspection, use the available filesystem tools before answering.',
    ].join('\n');
  }
  return [
    'Runtime steering: the same tool call appears to be repeating.',
    'Stop the loop, summarize what is already known, and choose a different strategy or ask for user guidance instead of issuing the same call again.',
  ].join('\n');
}

// ─── Checkpoint 辅助 ──────────────────────────────────────

export function checkpointRecordsFromToolResult(
  result: ToolBatchResult
): RuntimeCheckpointRecord[] {
  const records: RuntimeCheckpointRecord[] = [];
  for (const artifact of result.output.artifacts ?? []) {
    const metadata = artifact.metadata ?? {};
    const checkpointId = stringValue(metadata.checkpointId);
    const manifestPath = stringValue(metadata.manifestPath);
    if (checkpointId && manifestPath) {
      records.push({
        id: checkpointId,
        kind: 'workspace-checkpoint',
        label: stringValue(metadata.label) ?? artifact.title,
        toolCallId: result.id,
        toolName: result.toolName,
        artifactUri: artifact.uri,
        manifestPath,
        metadata,
      });
      continue;
    }

    const refName = stringValue(metadata.refName);
    if (checkpointId && refName && metadata.artifactKind === 'git-checkpoint') {
      records.push({
        id: checkpointId,
        kind: 'git-checkpoint',
        label: stringValue(metadata.label) ?? artifact.title,
        toolCallId: result.id,
        toolName: result.toolName,
        artifactUri: artifact.uri,
        manifestPath: refName,
        metadata,
      });
      continue;
    }

    const snapshotPath = stringValue(metadata.snapshotPath);
    if (snapshotPath) {
      records.push({
        id: createId('snapshot'),
        kind: 'file-snapshot',
        label: artifact.title,
        toolCallId: result.id,
        toolName: result.toolName,
        artifactUri: artifact.uri,
        snapshotPath,
        sourcePath: stringValue(metadata.sourcePath),
        metadata,
      });
    }
  }
  return records;
}

export function checkpointRestoreRecordFromToolResult(
  result: ToolBatchResult
): RuntimeCheckpointRestoreRecord | null {
  const json = result.output.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const checkpointId = stringValue(record.checkpointId);
  if (!checkpointId) return null;
  const restored = stringArrayValue(record.restored);
  const deleted = stringArrayValue(record.deleted);
  const skipped = stringArrayValue(record.skipped);
  if (restored.length === 0 && deleted.length === 0 && skipped.length === 0)
    return null;
  return {
    checkpointId,
    toolCallId: result.id,
    toolName: result.toolName,
    restored,
    deleted,
    skipped,
    metadata: json as JsonObject,
  };
}

// ─── 工具输入验证建议 ──────────────────────────────────────

export function validationAdviceForToolInput(
  tool: AgentTool,
  input: JsonObject,
  errors: string[]
): string[] {
  const hasParseError =
    typeof input.__parseError === 'string' ||
    errors.some((error) => /JSON parse failed/i.test(error));
  if (!hasParseError) return [];

  const rawArguments =
    typeof input.__rawArguments === 'string' ? input.__rawArguments : '';
  const rawNote = rawArguments
    ? `- Raw argument preview: ${rawArguments.slice(0, 240).replace(/\s+/g, ' ')}${rawArguments.length > 240 ? '...' : ''}`
    : '';
  const common = [
    '- Repair hint: send one valid JSON object only; do not include prose, markdown fences, comments, or trailing text in tool arguments.',
  ];

  if (tool.name === 'write_file') {
    return [
      ...common,
      '- For long content, do not retry write_file with a huge content string.',
      '- Use edit instead, in small chunks: {"path":"target/file.ext","edits":[{"op":"insert_tail","content":"...short chunk..."}]}.',
      '- Keep each edit chunk small enough to escape safely; after writing, read the file or rely on the edit result preview before continuing.',
      ...(rawNote ? [rawNote] : []),
    ];
  }

  if (tool.name === 'edit') {
    return [
      ...common,
      '- Prefer small edits: {"path":"target/file.ext","edits":[{"op":"insert_tail","content":"...short chunk..."}]}.',
      '- If replacing existing content, read first, use numbered lines with the returned snapshotTag, and apply small line edits.',
      ...(rawNote ? [rawNote] : []),
    ];
  }

  if (tool.name === 'shell_command') {
    return [
      ...common,
      '- Use the minimal shape {"command":"..."} for commands.',
      '- Do not embed long generated file content in shell_command; use edit insert_tail chunks for file writes.',
      ...(rawNote ? [rawNote] : []),
    ];
  }

  return [...common, ...(rawNote ? [rawNote] : [])];
}

// ─── 工具函数 ──────────────────────────────────────────────

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'artifact';
}

export function summarizeToolCall(
  tool: AgentTool | undefined,
  input: JsonObject,
  fallback: string
): string {
  if (!tool) return fallback;
  try {
    const summary = tool.summarize(input);
    return summary.trim() || fallback;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `${tool.name} (invalid input: ${reason})`;
  }
}

export function isExpiredApprovalDecision(
  decision: PermissionDecision
): boolean {
  const approval = decision.metadata?.approval;
  return Boolean(
    approval &&
    typeof approval === 'object' &&
    !Array.isArray(approval) &&
    (approval as Record<string, unknown>).status === 'expired'
  );
}

/** Bare / weak denial reasons that should be expanded for the model. */
export function isBareUserDeniedReason(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  const trimmed = reason.trim();
  return (
    trimmed === 'user-denied' || trimmed === 'Denied' || trimmed === 'denied'
  );
}

const APPROVAL_EXPIRED_DENY_TEXT =
  '审批超时，工具未执行；请重试审批或改用其他方案。Approval timed out — tool was not executed; retry approval or choose another approach.';

const USER_DENIED_DENY_TEXT =
  '用户拒绝了该工具调用，工具未执行；请勿假设已执行成功。User denied this tool call — do not assume it succeeded.';

/**
 * Human-readable permission deny text for tool-result feedback.
 * Expands weak reasons (`user-denied`) and default expired copy so the model can replan.
 */
export function formatPermissionDenyReason(
  decision: PermissionDecision
): string {
  if (isExpiredApprovalDecision(decision)) {
    const reason = decision.reason?.trim();
    // Keep daemon (or other) already-actionable timeout copy when present.
    if (
      reason &&
      /timed?\s*out|超时|expired|skip/i.test(reason) &&
      reason.length > 12
    ) {
      return reason;
    }
    return APPROVAL_EXPIRED_DENY_TEXT;
  }

  const reason = decision.reason?.trim();
  // Weak reasons (`user-denied`) → actionable bilingual copy for the model.
  if (isBareUserDeniedReason(reason)) {
    return USER_DENIED_DENY_TEXT;
  }
  return reason || 'Tool execution denied';
}

/**
 * Build soft-denial tool output for permission deny / approval timeout.
 * Never aborts the run — caller should return this as isError tool-result.
 */
export function buildPermissionDenyToolOutput(
  decision: PermissionDecision
): ToolOutput {
  const expired = isExpiredApprovalDecision(decision);
  const text = formatPermissionDenyReason(decision);
  const bareUserDenied = isBareUserDeniedReason(decision.reason);
  const softDeny =
    expired || bareUserDenied || decision.metadata?.softDeny === true;
  const code = expired
    ? 'approval_expired'
    : bareUserDenied
      ? 'user_denied'
      : typeof decision.metadata?.code === 'string'
        ? decision.metadata.code
        : 'permission_denied';

  const json: JsonObject = {
    ...(decision.metadata ?? {}),
    softDeny,
    code,
    reason: text,
  };

  return { text, json };
}

export function isAbortLikeCause(cause: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const message = sharedErrorMessage(cause) ?? '';
  return /aborted|abort|cancelled|canceled/i.test(message);
}

export function isToolTimeoutCause(cause: unknown): boolean {
  const message = sharedErrorMessage(cause) ?? '';
  return /timed[-\s]?out|timeout/i.test(message);
}

export function abortReason(signal: AbortSignal): unknown {
  return 'reason' in signal ? signal.reason : new Error('aborted');
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === 'object' &&
    timer &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref();
  }
}

export function positiveInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function isToolBatchResult(value: unknown): value is ToolBatchResult {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).toolName === 'string' &&
    'isError' in value
  );
}

export function createToolBatchCancelReason(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  if (isToolBatchResult(cause))
    return new Error(`Sibling tool failed: ${cause.toolName}`);
  return new Error('Sibling tool failed');
}
