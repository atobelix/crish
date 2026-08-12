/**
 * NoteMirrorIpc 契约测（detect / import · CONN-E · SD-33）
 *
 * 可点名：
 * - `note_mirror_ipc_wire_and_parse`
 * - `note_mirror_ipc_mock_detect_and_import_x05`
 * - `note_mirror_ipc_tauri_missing_is_structured_failure`
 *
 * ≠ EL-03；≠ inotify 满关；≠ poll 双开 debounce；≠ 重做 E2′ / E3。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeTyped } from './tauriInvoke';
import { isRegisteredCommand } from './transport/commandManifest';
import {
  NOTE_CMD_DETECT_MIRROR_DRIFT,
  NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
  createMockNoteMirrorIpc,
  createTauriNoteMirrorIpc,
  detectMirrorReqToWire,
  detectSuccessToReportView,
  importMirrorReqToWire,
  parseDetectMirrorOutcome,
  parseImportMirrorOutcome,
  wrapDetectMirrorInvokeArgs,
  wrapImportMirrorInvokeArgs,
} from './noteMirrorIpc';

vi.mock('./tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeTyped);

describe('NoteMirrorIpc · wire / parse', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('note_mirror_ipc_wire_and_parse', () => {
    expect(NOTE_CMD_DETECT_MIRROR_DRIFT).toBe('note_detect_mirror_drift');
    expect(NOTE_CMD_IMPORT_MIRROR_PROPOSAL).toBe('note_import_mirror_proposal');
    expect(isRegisteredCommand(NOTE_CMD_DETECT_MIRROR_DRIFT)).toBe(true);
    expect(isRegisteredCommand(NOTE_CMD_IMPORT_MIRROR_PROPOSAL)).toBe(true);

    expect(detectMirrorReqToWire({ docId: 'd1', authorityRev: 3 })).toEqual({
      doc_id: 'd1',
      authority_rev: 3,
    });
    expect(wrapDetectMirrorInvokeArgs({ docId: 'd1' })).toEqual({
      req: { doc_id: 'd1' },
    });
    expect(
      importMirrorReqToWire({
        docId: 'd1',
        strategy: 'retain_local_and_reimport',
        unpushedOpCount: 2,
      })
    ).toEqual({
      doc_id: 'd1',
      strategy: 'retain_local_and_reimport',
      unpushed_op_count: 2,
    });
    expect(
      wrapImportMirrorInvokeArgs({
        docId: 'd1',
        strategy: 'drop_unacked',
      })
    ).toEqual({
      req: { doc_id: 'd1', strategy: 'drop_unacked' },
    });

    const det = parseDetectMirrorOutcome({
      ok: true,
      doc_id: 'd1',
      class: 'mirror_only',
      path: '/tmp/d1.md',
      last_export_rev: 1,
      authority_rev: 1,
      pending_lag: 0,
      mirror_changed: true,
      authority_changed: false,
      file_exists: true,
    });
    expect(det.ok).toBe(true);
    if (!det.ok) return;
    expect(det.source).toBe('tauri-ipc');
    expect(det.class).toBe('mirror_only');
    expect(detectSuccessToReportView(det).docId).toBe('d1');

    const imp = parseImportMirrorOutcome({
      ok: true,
      kind: 'conflict',
      report: {
        doc_id: 'd1',
        class: 'mirror_only',
        last_export_rev: 1,
        authority_rev: 1,
      },
      silent_overwrite_blocked: true,
      unpushed_op_count: 3,
      applied: false,
    });
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    expect(imp.kind).toBe('conflict');
    expect(imp.silentOverwriteBlocked).toBe(true);
    expect(imp.applied).toBe(false);
    expect(imp.source).toBe('tauri-ipc');

    const fail = parseDetectMirrorOutcome({
      ok: false,
      code: 'note.unwired',
      reason: 'missing',
    });
    expect(fail).toEqual({
      ok: false,
      code: 'note.unwired',
      reason: 'missing',
    });
  });

  it('note_mirror_ipc_mock_detect_and_import_x05', async () => {
    const ipc = createMockNoteMirrorIpc({
      'doc-m': { class: 'mirror_only', opsCount: 2 },
    });

    const det = await ipc.detectMirrorDrift({ docId: 'doc-m' });
    expect(det.ok).toBe(true);
    if (det.ok) {
      expect(det.class).toBe('mirror_only');
      expect(det.source).toBe('tauri-ipc');
    }

    // X-05：unpushed + retain → silent blocked
    const blocked = await ipc.importMirrorProposal({
      docId: 'doc-m',
      strategy: 'retain_local_and_reimport',
      unpushedOpCount: 4,
    });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.kind).toBe('conflict');
      expect(blocked.silentOverwriteBlocked).toBe(true);
      expect(blocked.applied).toBe(false);
    }

    // 显式 drop → op_batch
    const drop = await ipc.importMirrorProposal({
      docId: 'doc-m',
      strategy: 'drop_unacked',
      unpushedOpCount: 4,
    });
    expect(drop.ok).toBe(true);
    if (drop.ok) {
      expect(drop.kind).toBe('op_batch');
      expect(drop.discardsUnpushed).toBe(true);
      expect(drop.isBlockLevelDiff).toBe(true);
    }

    expect(ipc.importCalls).toHaveLength(2);
  });

  it('note_mirror_ipc_tauri_missing_is_structured_failure', async () => {
    mockInvoke.mockResolvedValue({
      status: 'missing',
      command: NOTE_CMD_DETECT_MIRROR_DRIFT,
    } as never);
    const ipc = createTauriNoteMirrorIpc();
    const det = await ipc.detectMirrorDrift({ docId: 'x' });
    expect(det.ok).toBe(false);
    if (!det.ok) {
      expect(det.code).toBe('note.command_missing');
    }
  });
});

const MIRROR_IPC_DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'src/api');

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-33 · noteMirrorIpc 行数与头钉', () => {
  it('noteMirrorIpc.ts 物理行数 <400；头钉 SD-33 / ≠ EL-03 / E2 默认关', () => {
    const src = readFileSync(join(MIRROR_IPC_DIR, 'noteMirrorIpc.ts'), 'utf8');
    expect(physicalLineCount(src)).toBeLessThan(400);
    expect(src).toMatch(/SD-33/);
    expect(src).toMatch(/≠\s*EL-03/);
    expect(src).toMatch(/CONN-E2 默认策略/);
    expect(src).toMatch(/默认关/);
    expect(src).toMatch(/CONN-E3/);
    expect(src).toMatch(/noteMirrorIpc\.types/);
    expect(src).toMatch(/noteMirrorIpc\.wire/);
    expect(src).toMatch(/noteMirrorIpc\.parse/);
    expect(src).toMatch(/noteMirrorIpc\.mock/);
    expect(src).toMatch(/noteMirrorIpc\.tauri/);
    expect(src).not.toMatch(/EL-03\s*[已关关闭完成]/);
    expect(src).not.toMatch(/inotify[^\n]*已关/);
  });

  it('分模文件存在（防半拆）', () => {
    const required = [
      'noteMirrorIpc.types.ts',
      'noteMirrorIpc.wire.ts',
      'noteMirrorIpc.parse.ts',
      'noteMirrorIpc.mock.ts',
      'noteMirrorIpc.tauri.ts',
    ];
    for (const name of required) {
      const src = readFileSync(join(MIRROR_IPC_DIR, name), 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 ≠ EL-03`).toMatch(/≠\s*EL-03|EL-03/);
    }
  });
});
