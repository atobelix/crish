/**
 * CONN-E2′-tauri · 可信 invoke detect 一次（无 DOM）
 *
 * `createTauriNoteMirrorIpc` + test-setup `mockTauriCommand`，线格式对齐
 * `note_commands.rs` `report_to_json`。填 report 形状真；空壳/失败不造假。
 *
 * StatusBar / Host 装配见 `Workspace.conn-e2-prime-tauri.test.tsx`。
 * 产品 IPC 从扩展家 import；workspace 旧 re-export 已删。
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS · ≠ 重做 E2′ 策略
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../test-setup';
import { runMirrorDetectOnce } from './mirrorDetectSchedule';
import {
  NOTE_CMD_DETECT_MIRROR_DRIFT,
  NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
  createTauriNoteMirrorIpc,
} from './noteMirrorIpc';
import { createProductNoteMirrorIpc } from '../extensions/note-paper/productMirrorPolicy';
import { submitThreeWayViaMirrorIpc } from '../components/note-paper/mirrorThreeWayBridge';
import { resolveThreeWayAction } from '../components/note-paper/mirrorDriftUi';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/api');

const REPO = process.cwd();

function backendDetectWire(docId: string): Record<string, unknown> {
  return {
    ok: true,
    source: 'tauri-ipc',
    doc_id: docId,
    class: 'mirror_only',
    path: 'C:/tmp/e2pt-mirror.md',
    last_export_rev: 2,
    authority_rev: 2,
    pending_lag: 4,
    mirror_changed: true,
    authority_changed: false,
    file_exists: true,
    stored_hash: 'sha256:e2pt-stored',
    file_hash: 'sha256:e2pt-file',
  };
}

describe('CONN-E2′-tauri · invoke detect 一次（IPC）', () => {
  it('conn_e2p_tauri_ipc_detect_once_fills_real_report', async () => {
    const docId = 'strict-ws-e2pt-ipc';
    const detectInvokes: unknown[] = [];
    mockTauriCommand(NOTE_CMD_DETECT_MIRROR_DRIFT, (args) => {
      detectInvokes.push(args);
      return backendDetectWire(docId);
    });

    expect(
      createProductNoteMirrorIpc({ isTauriRuntime: false })
    ).toBeUndefined();
    const ipc = createProductNoteMirrorIpc({ isTauriRuntime: true });
    expect(ipc).toBeDefined();
    expect(ipc).not.toHaveProperty('detectCalls');

    const once = await runMirrorDetectOnce(ipc!, { docId });
    expect(detectInvokes).toHaveLength(1);
    const args = detectInvokes[0] as { req?: { doc_id?: string } };
    expect(args.req?.doc_id).toBe(docId);

    expect(once.outcome.ok).toBe(true);
    expect(once.report).not.toBeNull();
    expect(once.report).toMatchObject({
      docId,
      class: 'mirror_only',
      path: 'C:/tmp/e2pt-mirror.md',
      lastExportRev: 2,
      authorityRev: 2,
      pendingLag: 4,
      mirrorChanged: true,
      authorityChanged: false,
      fileExists: true,
    });
    if (once.outcome.ok) {
      expect(once.outcome.source).toBe('tauri-ipc');
      expect(once.outcome.storedHash).toBe('sha256:e2pt-stored');
      expect(once.outcome.fileHash).toBe('sha256:e2pt-file');
    }
  });

  it('conn_e2p_tauri_ipc_failure_and_hollow_no_fake_report', async () => {
    mockTauriError(
      NOTE_CMD_DETECT_MIRROR_DRIFT,
      new Error('store backend unwired')
    );
    const ipc = createTauriNoteMirrorIpc();
    const fail = await runMirrorDetectOnce(ipc, {
      docId: 'strict-ws-e2pt-fail',
    });
    expect(fail.outcome.ok).toBe(false);
    expect(fail.report).toBeNull();

    mockTauriCommand(NOTE_CMD_DETECT_MIRROR_DRIFT, () => ({
      ok: true,
      source: 'tauri-ipc',
    }));
    const hollow = await runMirrorDetectOnce(ipc, {
      docId: 'strict-ws-e2pt-hollow',
    });
    expect(hollow.outcome.ok).toBe(false);
    expect(hollow.report).toBeNull();
  });

  it('conn_e2p_tauri_ipc_x05_unpushed_blocks_silent_overwrite', async () => {
    const importInvokes: unknown[] = [];
    mockTauriCommand(NOTE_CMD_IMPORT_MIRROR_PROPOSAL, (args) => {
      importInvokes.push(args);
      throw new Error('X-05 前端门禁应挡住，不得发 import');
    });

    const blockedDecision = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 3,
      confirmDiscardUnpushed: false,
      driftClass: 'mirror_only',
    });
    expect(blockedDecision.ok).toBe(false);
    if (!blockedDecision.ok) {
      expect(blockedDecision.code).toBe('x05_silent_drop_blocked');
    }

    const ipc = createTauriNoteMirrorIpc();
    const r = await submitThreeWayViaMirrorIpc(blockedDecision, {
      docId: 'strict-ws-e2pt-x05',
      unpushedOpCount: 3,
      ipc,
    });
    expect(r.submitted).toBe(false);
    if (!r.submitted) {
      expect(r.reason).toBe('decision_blocked');
    }
    expect(importInvokes).toHaveLength(0);

    const bridge = readFileSync(
      join(DIR, '../components/note-paper/mirrorThreeWayBridge.ts'),
      'utf8'
    );
    expect(bridge).toMatch(/if\s*\(\s*!decision\.ok\s*\)/);
    expect(bridge).toMatch(/decision_blocked/);

    const mirrorBackend = readFileSync(
      join(REPO, 'apps/agent-workbench/src-tauri/src/note_commands_mirror.rs'),
      'utf8'
    );
    expect(mirrorBackend).toMatch(/silent_overwrite_blocked/);

    const facadeBackend = readFileSync(
      join(REPO, 'apps/agent-workbench/src-tauri/src/note_commands.rs'),
      'utf8'
    );
    expect(facadeBackend).toMatch(/note_commands_mirror/);
    expect(facadeBackend).toMatch(/note_import_mirror_proposal/);

    const testBackend = readFileSync(
      join(REPO, 'apps/agent-workbench/src-tauri/src/note_commands_tests.rs'),
      'utf8'
    );
    expect(testBackend).toMatch(
      /note_import_mirror_proposal_ipc_blocks_silent_overwrite/
    );

    mockTauriCommand(NOTE_CMD_IMPORT_MIRROR_PROPOSAL, () => ({
      ok: true,
      kind: 'conflict',
      report: {
        doc_id: 'strict-ws-e2pt-x05',
        class: 'mirror_only',
        last_export_rev: 2,
        authority_rev: 2,
      },
      reason: '存在 3 条 unpushed op；拒绝静默覆盖',
      unpushed_op_count: 3,
      silent_overwrite_blocked: true,
      applied: false,
      source: 'tauri-ipc',
    }));
    const parsed = await ipc.importMirrorProposal({
      docId: 'strict-ws-e2pt-x05',
      strategy: 'retain_local_and_reimport',
      unpushedOpCount: 3,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('conflict');
      expect(parsed.silentOverwriteBlocked).toBe(true);
      expect(parsed.applied).toBe(false);
    }
  });
});
