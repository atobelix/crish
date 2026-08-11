/**
 * NoteHydrateIpc 契约测（真 hydrate / note IPC 方向）
 *
 * 可点名：
 * - `note_hydrate_ipc_wire_and_parse_tauri_ipc_source`
 * - `note_hydrate_ipc_mock_success_and_error_contract`
 * - `note_hydrate_ipc_adapt_as_transport_source_tauri_ipc`
 * - `note_hydrate_ipc_tauri_missing_is_structured_failure`
 *
 * 诚实：产品空态默认仍 fixture（本测不切换 WorkspaceEmptyState）。
 * ≠ 打开完成 / ≠ EL。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTyped } from './tauriInvoke';
import { isRegisteredCommand } from './transport/commandManifest';
import {
  NOTE_CMD_DOCUMENT_HYDRATE,
  createMockNoteHydrateIpc,
  createTauriNoteHydrateIpc,
  hydrateReqToWire,
  parseHydrateIpcOutcome,
  wrapHydrateInvokeArgs,
} from './noteHydrateIpc';
import { adaptNoteHydrateIpcAsTransport } from '../components/note-paper/hydrateProjection';

vi.mock('./tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeTyped);

describe('NoteHydrateIpc · note_document_hydrate 契约', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('note_hydrate_ipc_wire_and_parse_tauri_ipc_source', () => {
    expect(NOTE_CMD_DOCUMENT_HYDRATE).toBe('note_document_hydrate');
    expect(isRegisteredCommand(NOTE_CMD_DOCUMENT_HYDRATE)).toBe(true);

    const wire = hydrateReqToWire({ docId: 'doc-h1', limit: 50 });
    expect(wire).toEqual({ doc_id: 'doc-h1', limit: 50 });
    expect(wrapHydrateInvokeArgs({ docId: 'doc-h1' })).toEqual({
      req: { doc_id: 'doc-h1' },
    });

    // snake_case 成功线格式 → 强制 source=tauri-ipc
    const parsed = parseHydrateIpcOutcome({
      ok: true,
      doc_id: 'doc-h1',
      rev: 4,
      blocks: [
        {
          id: 'b1',
          flavour: 'heading',
          index: 0,
          text: 'Hydrated via IPC',
          props: { level: 1 },
        },
        {
          id: 'b2',
          kind: 'paragraph', // 兼容 kind → flavour
          index: 1,
          snippet: 'body',
        },
      ],
      truncated: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source).toBe('tauri-ipc');
    expect(parsed.docId).toBe('doc-h1');
    expect(parsed.rev).toBe(4);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.flavour).toBe('heading');
    expect(parsed.blocks[1]?.flavour).toBe('paragraph');
    expect(parsed.blocks[1]?.text).toBe('body');

    // 失败线格式
    const fail = parseHydrateIpcOutcome({
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

  it('note_hydrate_ipc_mock_success_and_error_contract', async () => {
    const ipc = createMockNoteHydrateIpc({
      'doc-mock': {
        rev: 2,
        blocks: [
          {
            id: 'm1',
            flavour: 'paragraph',
            index: 0,
            text: 'from mock hydrate ipc',
          },
        ],
      },
    });

    const ok = await ipc.hydrateDocument({ docId: 'doc-mock' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.source).toBe('tauri-ipc');
    expect(ok.blocks[0]?.text).toMatch(/mock hydrate ipc/);

    // 空 doc = 成功空投影（可测 empty）
    const empty = await ipc.hydrateDocument({ docId: 'never-seeded' });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.blocks).toEqual([]);
    expect(empty.source).toBe('tauri-ipc');

    ipc.setNextError({
      code: 'note.hydrate_failed',
      reason: 'blob missing',
    });
    const err = await ipc.hydrateDocument({ docId: 'doc-mock' });
    expect(err.ok).toBe(false);
    if (err.ok) return;
    expect(err.code).toBe('note.hydrate_failed');
    expect(err.reason).toMatch(/blob missing/);
  });

  it('note_hydrate_ipc_adapt_as_transport_source_tauri_ipc', async () => {
    const ipc = createMockNoteHydrateIpc({
      'doc-adapt': {
        rev: 9,
        blocks: [
          {
            id: 'a1',
            flavour: 'heading',
            index: 0,
            text: 'IPC adapted',
            props: { level: 2 },
          },
        ],
      },
    });
    const transport = adaptNoteHydrateIpcAsTransport(ipc);
    const out = await transport.hydrate('doc-adapt');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 与 note-transport / fixture 分轨
    expect(out.projection.source).toBe('tauri-ipc');
    expect(out.projection.source).not.toBe('fixture');
    expect(out.projection.source).not.toBe('note-transport');
    expect(out.projection.rev).toBe(9);
    expect(out.projection.blocks[0]?.text).toBe('IPC adapted');
    expect(out.projection.blocks[0]?.index).toBe(0);
  });

  it('note_hydrate_ipc_tauri_missing_is_structured_failure', async () => {
    mockInvoke.mockResolvedValue({
      status: 'missing',
      command: NOTE_CMD_DOCUMENT_HYDRATE,
    } as never);

    const ipc = createTauriNoteHydrateIpc();
    const out = await ipc.hydrateDocument({ docId: 'any' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('note.command_missing');
    expect(out.reason).toMatch(/note_document_hydrate/);

    expect(mockInvoke).toHaveBeenCalledWith(
      NOTE_CMD_DOCUMENT_HYDRATE,
      wrapHydrateInvokeArgs({ docId: 'any' })
    );
  });
});
