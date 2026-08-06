// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runTaskCommand,
  cancelRunCommand,
  approveToolCommand,
  denyToolCommand,
  normalizeCoreError,
} from './daemonClient';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('daemonClient IPC API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runTaskCommand invokes core_run_task directly', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ runId: 'run-1', sessionId: 'sess-1' });

    const res = await runTaskCommand({
      runId: 'run-1',
      sessionId: 'sess-1',
      prompt: 'hello world',
      permissionMode: 'auto',
    });

    expect(res).toEqual({ runId: 'run-1', sessionId: 'sess-1' });
    expect(invoke).toHaveBeenCalledWith('core_run_task', {
      options: expect.objectContaining({
        runId: 'run-1',
        sessionId: 'sess-1',
        prompt: 'hello world',
        permissionMode: 'auto',
      }),
    });
  });

  it('cancelRunCommand invokes core_cancel_run directly', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, runId: 'run-1' });

    const res = await cancelRunCommand('run-1', 'force');

    expect(res).toEqual({ ok: true, runId: 'run-1' });
    expect(invoke).toHaveBeenCalledWith('core_cancel_run', {
      runId: 'run-1',
      mode: 'force',
    });
  });

  it('approveToolCommand invokes core_approve_tool directly', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, toolCallId: 'tc-1', decision: 'approved' });

    const res = await approveToolCommand('run-1', 'tc-1');

    expect(res).toEqual({ ok: true, toolCallId: 'tc-1', decision: 'approved' });
    expect(invoke).toHaveBeenCalledWith('core_approve_tool', {
      runId: 'run-1',
      toolCallId: 'tc-1',
      decision: 'approved',
    });
  });

  it('denyToolCommand invokes core_deny_tool directly', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, toolCallId: 'tc-1', decision: 'denied' });

    const res = await denyToolCommand('run-1', 'tc-1', 'User rejected');

    expect(res).toEqual({ ok: true, toolCallId: 'tc-1', decision: 'denied' });
    expect(invoke).toHaveBeenCalledWith('core_deny_tool', {
      runId: 'run-1',
      toolCallId: 'tc-1',
      reason: 'User rejected',
    });
  });

  it('normalizeCoreError normalizes backend errors into CoreErrorPayload', () => {
    expect(normalizeCoreError({ kind: 'InvalidInput', detail: 'UserFacingError: LFI blocked' })).toEqual({
      kind: 'InvalidInput',
      detail: 'UserFacingError: LFI blocked',
    });
    expect(normalizeCoreError('Raw string error')).toEqual({
      kind: 'Internal',
      detail: 'Raw string error',
    });
    expect(normalizeCoreError(new Error('JS error'))).toEqual({
      kind: 'Internal',
      detail: 'JS error',
    });
  });

  it('runTaskCommand catches backend errors and throws normalized CoreErrorPayload', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({
      kind: 'InvalidInput',
      detail: 'UserFacingError: Local file inclusion (LFI) / path traversal attack blocked',
    });

    await expect(
      runTaskCommand({ runId: 'run-1', sessionId: 'sess-1', prompt: 'file:///etc/passwd' })
    ).rejects.toEqual({
      kind: 'InvalidInput',
      detail: 'UserFacingError: Local file inclusion (LFI) / path traversal attack blocked',
    });
  });

  it('runTaskCommand rejects empty or missing runId and sessionId pre-flight without invoking backend', async () => {
    await expect(
      runTaskCommand({ runId: '', sessionId: 'sess-1' })
    ).rejects.toEqual({
      kind: 'InvalidInput',
      detail: 'UserFacingError: Invalid runId: parameter must be a non-empty string',
    });

    await expect(
      runTaskCommand({ runId: '   ', sessionId: 'sess-1' })
    ).rejects.toEqual({
      kind: 'InvalidInput',
      detail: 'UserFacingError: Invalid runId: parameter must be a non-empty string',
    });

    await expect(
      runTaskCommand({ runId: 'run-1', sessionId: '' })
    ).rejects.toEqual({
      kind: 'InvalidInput',
      detail: 'UserFacingError: Invalid sessionId: parameter must be a non-empty string',
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
