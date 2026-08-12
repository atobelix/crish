/**
 * NoteApplyOpsIpc 契约测（CONN-B3 · note_apply_ops 产品写锥）
 *
 * 可点名：
 * - `note_apply_ops_ipc_wire_and_parse_tauri_ipc_source`
 * - `note_apply_ops_ipc_mock_success_and_error_contract`
 * - `note_apply_ops_ipc_adapt_as_applyOps_ok_and_fail`
 * - `note_apply_ops_ipc_tauri_missing_is_structured_failure`
 * - `conn_b3_resolve_product_strict_apply_ops_default_none_without_tauri`
 * - `conn_b3_resolve_product_strict_apply_ops_product_ipc_with_mock`
 * - `conn_b3_resolve_product_strict_apply_ops_tauri_product_ipc`
 * - `conn_b3_resolve_product_strict_apply_ops_injected_preferred`
 *
 * 诚实：本文件测 IPC 契约 + 产品默认解析；**≠ EL-01**；
 * 禁止 mock 当生产默认（无 Tauri → source=none）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTyped } from './tauriInvoke';
import { isRegisteredCommand } from './transport/commandManifest';
import {
  NOTE_CMD_APPLY_OPS,
  adaptNoteApplyOpsIpcAsApplyOps,
  applyOpsReqToWire,
  createMockNoteApplyOpsIpc,
  createTauriNoteApplyOpsIpc,
  parseApplyOpsIpcOutcome,
  resolveProductStrictApplyOps,
  wrapApplyOpsInvokeArgs,
} from './noteApplyOpsIpc';

vi.mock('./tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeTyped);

describe('NoteApplyOpsIpc · note_apply_ops 契约', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('note_apply_ops_ipc_wire_and_parse_tauri_ipc_source', () => {
    expect(NOTE_CMD_APPLY_OPS).toBe('note_apply_ops');
    expect(isRegisteredCommand(NOTE_CMD_APPLY_OPS)).toBe(true);

    const wire = applyOpsReqToWire({
      docId: 'doc-a1',
      opsJson: '[{"op":"insert"}]',
      intentId: 'i-1',
      origin: 'user',
    });
    expect(wire).toEqual({
      doc_id: 'doc-a1',
      ops_json: '[{"op":"insert"}]',
      intent_id: 'i-1',
      origin: 'user',
    });
    expect(
      wrapApplyOpsInvokeArgs({
        docId: 'doc-a1',
        opsJson: '[]',
      })
    ).toEqual({
      req: { doc_id: 'doc-a1', ops_json: '[]' },
    });

    const parsed = parseApplyOpsIpcOutcome({
      ok: true,
      doc_id: 'doc-a1',
      rev: 3,
      applied: 2,
      intent_id: 'i-1',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source).toBe('tauri-ipc');
    expect(parsed.docId).toBe('doc-a1');
    expect(parsed.rev).toBe(3);
    expect(parsed.applied).toBe(2);
    expect(parsed.intentId).toBe('i-1');

    const fail = parseApplyOpsIpcOutcome({
      ok: false,
      code: 'note.unwired',
      reason: 'backend missing',
    });
    expect(fail).toEqual({
      ok: false,
      code: 'note.unwired',
      reason: 'backend missing',
    });
  });

  it('note_apply_ops_ipc_mock_success_and_error_contract', async () => {
    const ipc = createMockNoteApplyOpsIpc();
    const ok = await ipc.applyOps({
      docId: 'mock-doc',
      opsJson: JSON.stringify([
        { op: 'insert', id: 'a', kind: 'paragraph' },
        { op: 'text_edit', id: 'a', start: 0, end: 0, insert: 'x' },
      ]),
      intentId: 'mock-1',
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.source).toBe('tauri-ipc');
    expect(ok.applied).toBe(2);
    expect(ok.rev).toBe(1);
    expect(ok.intentId).toBe('mock-1');
    expect(ipc.calls).toHaveLength(1);

    ipc.setNextError({ code: 'note.apply_failed', reason: 'boom' });
    const err = await ipc.applyOps({
      docId: 'mock-doc',
      opsJson: '[{"op":"delete","id":"a"}]',
    });
    expect(err).toEqual({
      ok: false,
      code: 'note.apply_failed',
      reason: 'boom',
    });

    const bad = await ipc.applyOps({
      docId: '',
      opsJson: '[]',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe('note.invalid');
  });

  it('note_apply_ops_ipc_adapt_as_applyOps_ok_and_fail', async () => {
    const ipc = createMockNoteApplyOpsIpc();
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'adapt-doc');

    const r1 = await applyOps('[{"op":"insert","id":"b1"}]', {
      intentId: 'adapt-1',
    });
    expect(r1.ok).toBe(true);
    expect(ipc.calls[0]?.docId).toBe('adapt-doc');
    expect(ipc.calls[0]?.intentId).toBe('adapt-1');
    expect(ipc.calls[0]?.opsJson).toContain('"op":"insert"');

    ipc.setNextError({ code: 'note.id_conflict', reason: 'dup' });
    const r2 = await applyOps('[{"op":"insert","id":"b1"}]', {
      intentId: 'adapt-2',
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('note.id_conflict');
    expect(r2.reason).toContain('dup');
  });

  it('note_apply_ops_ipc_tauri_missing_is_structured_failure', async () => {
    mockInvoke.mockResolvedValue({ status: 'missing' });
    const ipc = createTauriNoteApplyOpsIpc();
    const out = await ipc.applyOps({
      docId: 't',
      opsJson: '[]',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('note.command_missing');
    expect(mockInvoke).toHaveBeenCalledWith(
      NOTE_CMD_APPLY_OPS,
      expect.objectContaining({
        req: expect.objectContaining({ doc_id: 't' }),
      })
    );
  });
});

describe('resolveProductStrictApplyOps · CONN-B3', () => {
  it('conn_b3_resolve_product_strict_apply_ops_default_none_without_tauri', () => {
    const r = resolveProductStrictApplyOps({
      docId: 'd1',
      isTauriRuntime: false,
    });
    expect(r.source).toBe('none');
    expect(r.applyOps).toBeUndefined();
    // 会计门：无后端只读直至 IPC；禁止 mock 生产默认
  });

  it('conn_b3_resolve_product_strict_apply_ops_product_ipc_with_mock', async () => {
    const mock = createMockNoteApplyOpsIpc();
    const r = resolveProductStrictApplyOps({
      docId: 'd-mock',
      applyOpsIpc: mock,
      isTauriRuntime: false, // 显式 mock IPC 可在无 Tauri 测写路径
    });
    expect(r.source).toBe('product-ipc');
    expect(r.applyOps).toBeTypeOf('function');

    const out = await r.applyOps!('[{"op":"insert"}]', { intentId: 'p-1' });
    expect(out.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.docId).toBe('d-mock');
  });

  it('conn_b3_resolve_product_strict_apply_ops_tauri_product_ipc', async () => {
    mockInvoke.mockResolvedValue({
      status: 'ok',
      data: {
        ok: true,
        doc_id: 'd-tauri',
        rev: 1,
        applied: 1,
        source: 'tauri-ipc',
      },
    });
    const r = resolveProductStrictApplyOps({
      docId: 'd-tauri',
      isTauriRuntime: true,
    });
    expect(r.source).toBe('product-ipc');
    expect(r.applyOps).toBeTypeOf('function');
    const out = await r.applyOps!('[{"op":"insert"}]', { intentId: 't-1' });
    expect(out.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalled();
  });

  it('conn_b3_resolve_product_strict_apply_ops_injected_preferred', async () => {
    const applied: string[] = [];
    const r = resolveProductStrictApplyOps({
      docId: 'd-inj',
      applyOps: async (opsJson) => {
        applied.push(opsJson);
        return { ok: true };
      },
      applyOpsIpc: createMockNoteApplyOpsIpc(),
      isTauriRuntime: true,
    });
    expect(r.source).toBe('injected-applyOps');
    await r.applyOps!('[{"op":"delete"}]', { intentId: 'x' });
    expect(applied).toEqual(['[{"op":"delete"}]']);
  });
});
