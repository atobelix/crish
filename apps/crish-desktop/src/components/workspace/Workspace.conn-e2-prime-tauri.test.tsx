// @vitest-environment jsdom
/**
 * CONN-E2′-tauri · Host + 可信 invoke detect 一次（StatusBar）
 *
 * 走 `createTauriNoteMirrorIpc` / `createProductNoteMirrorIpc({ isTauriRuntime:true })`
 * + test-setup `mockTauriCommand`，线格式对齐 `note_commands.rs` `report_to_json`。
 *
 * IPC 层（无 DOM）见 `noteMirrorIpc.conn-e2p-tauri.test.ts`。
 *
 * **禁改** EmptyState `enableMirrorDetectSchedule` 默认 false
 * **禁改** Host `WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE = true`
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 默认双开 poll+OS · ≠ 重做 E2′ 策略
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import {
  NOTE_CMD_DETECT_MIRROR_DRIFT,
  NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
  createTauriNoteMirrorIpc,
} from '../../api/noteMirrorIpc';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
  WorkspaceProductEmptyHost,
  createProductNoteMirrorIpc,
} from './workspaceProductMirrorDetect';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/components/workspace');

const REPO = process.cwd();

/** 动态加载 RTL：hoisted react/react-dom 版本漂移时 collect 仍可通过。 */
const rtl = await import('@testing-library/react').catch(() => null);

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

function asReq(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const rec = args as Record<string, unknown>;
  const inner = rec.req;
  return inner && typeof inner === 'object'
    ? (inner as Record<string, unknown>)
    : rec;
}

describe('CONN-E2′-tauri · 默认与无 Tauri 不回退', () => {
  it('conn_e2p_tauri_defaults_unmoved_and_no_tauri_unregressed', () => {
    expect(WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE).toBe(true);
    expect(
      createProductNoteMirrorIpc({ isTauriRuntime: false })
    ).toBeUndefined();

    const tauriIpc = createProductNoteMirrorIpc({ isTauriRuntime: true });
    expect(tauriIpc).toBeDefined();
    expect(typeof tauriIpc?.detectMirrorDrift).toBe('function');
    expect(tauriIpc).not.toHaveProperty('detectCalls');

    const emptySrc = readFileSync(join(DIR, 'WorkspaceEmptyState.tsx'), 'utf8');
    expect(emptySrc).toMatch(/enableMirrorDetectSchedule = false,/);
    expect(emptySrc).not.toMatch(/enableMirrorDetectSchedule = true,/);

    const hostSrc = readFileSync(
      join(DIR, 'workspaceProductMirrorDetect.tsx'),
      'utf8'
    );
    expect(hostSrc).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE\s*=\s*true/
    );
    expect(hostSrc).toMatch(/createTauriNoteMirrorIpc/);
    expect(hostSrc).not.toMatch(/return\s+createMockNoteMirrorIpc/);

    const e2p = readFileSync(
      join(DIR, 'Workspace.conn-e2-prime.test.tsx'),
      'utf8'
    );
    expect(e2p).toMatch(/conn_e2p_no_tauri_does_not_fabricate_report/);
  });
});

describe.skipIf(!rtl)('CONN-E2′-tauri · Host invoke 填 StatusBar', () => {
  it('conn_e2p_tauri_host_no_tauri_schedule_stays_off', () => {
    const { render, screen } = rtl!;
    render(<WorkspaceProductEmptyHost wsId="ws-e2pt-notauri" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
  });

  it('conn_e2p_tauri_invoke_detect_once_fills_real_report', async () => {
    const { render, screen, fireEvent, waitFor } = rtl!;
    const wsId = 'ws-e2pt-ok';
    const docId = `strict-${wsId}`;
    const detectInvokes: unknown[] = [];
    mockTauriCommand(NOTE_CMD_DETECT_MIRROR_DRIFT, (args) => {
      detectInvokes.push(args);
      return backendDetectWire(docId);
    });

    const ipc = createProductNoteMirrorIpc({ isTauriRuntime: true });
    expect(ipc).toBeDefined();

    render(
      <WorkspaceEmptyState
        wsId={wsId}
        enableMirrorDetectSchedule={
          WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE
        }
        mirrorIpc={ipc}
      />
    );

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '1');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    await waitFor(() => {
      expect(detectInvokes.length).toBeGreaterThanOrEqual(1);
    });
    const wire = asReq(detectInvokes[0]);
    expect(wire?.doc_id).toBe(docId);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    const bar = await screen.findByTestId('mirror-drift-status-bar');
    await waitFor(() => {
      expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    });
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).not.toHaveAttribute('data-watch-source', 'os_event');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=4');

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '1');
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'fixture'
    );
  });

  it('conn_e2p_tauri_invoke_failure_no_fake_report_no_hydrate_fallback', async () => {
    const { render, screen, fireEvent, waitFor } = rtl!;
    mockTauriError(
      NOTE_CMD_DETECT_MIRROR_DRIFT,
      new Error('store backend unwired')
    );
    const ipc = createTauriNoteMirrorIpc();

    render(
      <WorkspaceEmptyState
        wsId="ws-e2pt-fail"
        enableMirrorDetectSchedule={
          WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE
        }
        mirrorIpc={ipc}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const bar = screen.queryByTestId('mirror-drift-status-bar');
    if (bar) {
      expect(bar).toHaveAttribute('data-drift-class', 'idle');
      expect(bar).not.toHaveAttribute('data-drift-class', 'mirror_only');
    }
    expect(screen.queryByTestId('mirror-drift-lag')).toBeNull();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'fixture'
    );
  });

  it('conn_e2p_tauri_hollow_detect_does_not_fabricate_drift', async () => {
    const { render, screen, fireEvent, waitFor } = rtl!;
    mockTauriCommand(NOTE_CMD_DETECT_MIRROR_DRIFT, () => ({
      ok: true,
      source: 'tauri-ipc',
    }));
    const ipc = createTauriNoteMirrorIpc();

    render(
      <WorkspaceEmptyState
        wsId="ws-e2pt-hollow"
        enableMirrorDetectSchedule
        mirrorIpc={ipc}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toBeInTheDocument();
    });

    const bar = screen.queryByTestId('mirror-drift-status-bar');
    if (bar) {
      expect(bar).toHaveAttribute('data-drift-class', 'idle');
    }
    expect(screen.queryByTestId('mirror-drift-lag')).toBeNull();
  });

  it('conn_e2p_tauri_x05_unpushed_blocks_silent_overwrite', async () => {
    const { render, screen, fireEvent, waitFor } = rtl!;
    const wsId = 'ws-e2pt-x05';
    const docId = `strict-${wsId}`;
    const importInvokes: unknown[] = [];
    mockTauriCommand(NOTE_CMD_DETECT_MIRROR_DRIFT, () =>
      backendDetectWire(docId)
    );
    mockTauriCommand(NOTE_CMD_IMPORT_MIRROR_PROPOSAL, (args) => {
      importInvokes.push(args);
      throw new Error('X-05 前端门禁应挡住，不得发 import');
    });

    const ipc = createTauriNoteMirrorIpc();
    render(
      <WorkspaceEmptyState
        wsId={wsId}
        enableMirrorDetectSchedule={
          WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE
        }
        mirrorIpc={ipc}
        mirrorUnpushedOpCount={3}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-gate')).toBeInTheDocument();
    });
    expect(importInvokes).toHaveLength(0);

    const bridge = readFileSync(
      join(DIR, '../note-paper/mirrorThreeWayBridge.ts'),
      'utf8'
    );
    expect(bridge).toMatch(/if\s*\(\s*!decision\.ok\s*\)/);
    expect(bridge).toMatch(/decision_blocked/);

    const mirrorPath = join(
      REPO,
      'apps/agent-workbench/src-tauri/src/note_commands_mirror.rs'
    );
    const applyPath = join(
      REPO,
      'apps/agent-workbench/src-tauri/src/note_commands_apply.rs'
    );
    const legacyPath = join(
      REPO,
      'apps/agent-workbench/src-tauri/src/note_commands.rs'
    );
    const backendPath = existsSync(mirrorPath)
      ? mirrorPath
      : existsSync(applyPath)
        ? applyPath
        : legacyPath;
    const backend = readFileSync(backendPath, 'utf8');
    expect(backend).toMatch(/silent_overwrite_blocked/);
    expect(backend).toMatch(/unpushed_op_count\s*>\s*0/);
  });
});
