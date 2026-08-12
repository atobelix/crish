// @vitest-environment jsdom
/**
 * CONN-E2′ · Workspace 产品宿主 detect 默装
 *
 * - 产品宿主写死默传 enableMirrorDetectSchedule + 产品 mirrorIpc
 * - EmptyState 直接渲染默认仍关（CONN-E2 会计不回退）
 * - 无 Tauri / 无 ipc 不造假 drift report
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 重做 E3 · ≠ 默认双开 poll+OS
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
  WorkspaceProductEmptyHost,
  createProductNoteMirrorIpc,
  resolveWorkspaceProductEmptyMirrorProps,
} from './workspaceProductMirrorDetect';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/components/workspace');

function readWorkspaceHostSrc(): string {
  return readFileSync(join(DIR, 'Workspace.tsx'), 'utf8');
}

describe('CONN-E2′ · Workspace 产品宿主 detect 策略', () => {
  it('conn_e2p_workspace_product_host_enables_detect_schedule', () => {
    expect(WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE).toBe(true);

    const assembled = resolveWorkspaceProductEmptyMirrorProps({
      isTauriRuntime: false,
    });
    expect(assembled.enableMirrorDetectSchedule).toBe(true);
    expect(assembled.mirrorIpc).toBeUndefined();

    render(<WorkspaceProductEmptyHost wsId="ws-e2p-host" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    const src = readWorkspaceHostSrc();
    expect(src).toMatch(/WorkspaceProductEmptyHost/);
    expect(src).toMatch(/CONN-E2′|CONN-E2'/);
    expect(src).not.toMatch(
      /<WorkspaceEmptyState\s+wsId=\{ws\.id\}\s+onActivate=\{focusThisWorkspace\}\s*\/>/
    );
  });

  it('conn_e2p_empty_state_direct_still_defaults_off', () => {
    render(<WorkspaceEmptyState wsId="ws-e2p-direct" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
  });

  it('conn_e2p_no_tauri_does_not_fabricate_report', async () => {
    expect(
      createProductNoteMirrorIpc({ isTauriRuntime: false })
    ).toBeUndefined();
    const assembled = resolveWorkspaceProductEmptyMirrorProps({
      isTauriRuntime: false,
    });
    expect(assembled.mirrorIpc).toBeUndefined();
    expect(assembled.enableMirrorDetectSchedule).toBe(true);

    // 有 Tauri 标记时才装配 tauri-ipc 面；不得带回 mock 的 detectCalls
    const tauriIpc = createProductNoteMirrorIpc({ isTauriRuntime: true });
    expect(tauriIpc).toBeDefined();
    expect(typeof tauriIpc?.detectMirrorDrift).toBe('function');
    expect(tauriIpc).not.toHaveProperty('detectCalls');

    render(<WorkspaceProductEmptyHost wsId="ws-e2p-notauri" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(host).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'fixture'
    );
    expect(host).toHaveAttribute('data-el03', 'not-claimed');
    expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
  });
});
