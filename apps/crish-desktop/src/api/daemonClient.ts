/**
 * apps/crish-desktop/src/api/daemonClient.ts
 * IPC Command Invocation Bridge to Rust Engine (src-tauri/src/core_run_commands.rs)
 * Direct strongly typed wrappers over Tauri invoke without secondary HashMap routers.
 */

import { invoke } from '@tauri-apps/api/core';

export type PermissionMode = 'auto' | 'manual' | 'plan';

export interface ChatAttachmentPayload {
  id: string;
  name: string;
  mime: string;
  size?: number;
  dataUrl?: string; // Base64 encoded data URI
  text?: string;    // Plain text content for text attachments
}

export interface CoreRunTaskRequest {
  runId: string;
  sessionId: string;
  prompt?: string;
  mode?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  clientMessageId?: string;
  assistantClientMessageId?: string;
  systemPrompt?: string;
  history?: Array<{
    id: string;
    sender: string;
    text?: string;
    thinking?: string;
    timestamp: number;
    blocks_json?: string;
  }>;
  contextWindow?: number;
  attachments?: ChatAttachmentPayload[];
}

export interface RunTaskResponse {
  runId: string;
  sessionId: string;
}

export interface CancelRunResponse {
  ok: boolean;
  runId: string;
}

export interface ApproveResponse {
  ok: boolean;
  toolCallId: string;
  decision: 'approved' | 'denied';
}

export interface CoreErrorPayload {
  kind: 'InvalidInput' | 'Encoding' | 'Io' | 'NotFound' | 'Cancelled' | 'Internal';
  detail: string;
}

/**
 * Normalizes backend error responses into a standardized CoreErrorPayload shape.
 */
export function normalizeCoreError(err: unknown): CoreErrorPayload {
  if (typeof err === 'object' && err !== null && 'kind' in err && 'detail' in err) {
    return err as CoreErrorPayload;
  }
  if (typeof err === 'string') {
    return { kind: 'Internal', detail: err };
  }
  if (err instanceof Error) {
    return { kind: 'Internal', detail: err.message };
  }
  return { kind: 'Internal', detail: String(err) };
}

function assertNonEmptyString(val: unknown, paramName: string): asserts val is string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw {
      kind: 'InvalidInput',
      detail: `UserFacingError: Invalid ${paramName}: parameter must be a non-empty string`,
    } as CoreErrorPayload;
  }
}

/**
 * Triggers task execution on the Rust engine.
 */
export async function runTaskCommand(payload: CoreRunTaskRequest): Promise<RunTaskResponse> {
  try {
    assertNonEmptyString(payload?.runId, 'runId');
    assertNonEmptyString(payload?.sessionId, 'sessionId');
    return await invoke<RunTaskResponse>('core_run_task', {
      options: {
        runId: payload.runId.trim(),
        sessionId: payload.sessionId.trim(),
        prompt: payload.prompt ?? null,
        mode: payload.mode ?? 'task',
        cwd: payload.cwd ?? null,
        permissionMode: payload.permissionMode ?? 'auto',
        clientMessageId: payload.clientMessageId ?? null,
        assistantClientMessageId: payload.assistantClientMessageId ?? null,
        systemPrompt: payload.systemPrompt ?? null,
        history: payload.history ?? null,
        contextWindow: payload.contextWindow ?? null,
        attachments: payload.attachments ?? null,
      },
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Cancels an ongoing task execution.
 */
export async function cancelRunCommand(
  runId: string,
  mode: 'cooperative' | 'force' = 'force'
): Promise<CancelRunResponse> {
  try {
    assertNonEmptyString(runId, 'runId');
    return await invoke<CancelRunResponse>('core_cancel_run', {
      runId: runId.trim(),
      mode,
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Approves a pending tool execution request.
 */
export async function approveToolCommand(
  runId: string,
  toolCallId: string
): Promise<ApproveResponse> {
  try {
    assertNonEmptyString(runId, 'runId');
    assertNonEmptyString(toolCallId, 'toolCallId');
    return await invoke<ApproveResponse>('core_approve_tool', {
      runId: runId.trim(),
      toolCallId: toolCallId.trim(),
      decision: 'approved',
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}

/**
 * Denies a pending tool execution request.
 */
export async function denyToolCommand(
  runId: string,
  toolCallId: string,
  reason?: string
): Promise<ApproveResponse> {
  try {
    assertNonEmptyString(runId, 'runId');
    assertNonEmptyString(toolCallId, 'toolCallId');
    return await invoke<ApproveResponse>('core_deny_tool', {
      runId: runId.trim(),
      toolCallId: toolCallId.trim(),
      reason: reason || 'User denied tool execution',
    });
  } catch (error) {
    throw normalizeCoreError(error);
  }
}
