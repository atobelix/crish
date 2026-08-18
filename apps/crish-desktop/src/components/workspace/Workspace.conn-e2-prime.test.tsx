// @vitest-environment jsdom
/**
 * CONN-E2′ · 产品默开 detect（到达面：02 叶；WorkspaceProductEmptyHost 已删）
 *
 * 测头自钉：Host 已删 ≠ 打开完成 ≠ 关 EL。
 * - WorkspaceProductEmptyHost 已删，不得再当入口 / 不得再当活夹具
 * - EmptyState + CTA 仍是夹具；直渲默认仍关（CONN-E2 会计不回退）
 * - 产品默开 detect 在 NoteLeafHost：activate 扩展后渲叶 / 已注册 factory
 * - 无 Tauri / 无 ipc 不造假 drift report
 * 策略/IPC 从扩展家 import，旧路径只 re-export。
 *
 * ≠ EL-03 · ≠ inotify 满关 · ≠ 重做 E3 · ≠ 默认双开 poll+OS
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper/activate';
import { NoteLeafHost } from '../../extensions/note-paper/NoteLeafHost';
import type { ViewRenderContext } from '../../services/view-registry';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE,
  createProductNoteMirrorIpc,
  resolveWorkspaceProductEmptyMirrorProps,
} from '../../extensions/note-paper/productMirrorPolicy';

function leafCtx(
  partial: Partial<ViewRenderContext> = {}
): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-e2p',
    sessionId: 'sess-e2p',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

/** 产品默开到达面：先激活扩展再渲 NoteLeafHost（Host 已删；EmptyState+CTA 仍是夹具；≠ 打开完成 ≠ 关 EL） */
function renderProductDetectLeaf() {
  activateNotePaper();
  return render(<NoteLeafHost {...leafCtx()} />);
}

describe('CONN-E2′ · 产品默开 detect（叶；Host 已删 ≠ 入口 ≠ 打开完成 ≠ 关 EL）', () => {
  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
  });

  it('conn_e2p_workspace_product_host_enables_detect_schedule', async () => {
    expect(WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE).toBe(true);

    const assembled = resolveWorkspaceProductEmptyMirrorProps({
      isTauriRuntime: false,
    });
    expect(assembled.enableMirrorDetectSchedule).toBe(true);
    expect(assembled.mirrorIpc).toBeUndefined();

    const { container } = renderProductDetectLeaf();
    await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(host).toHaveAttribute('data-el03', 'not-claimed');
    expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
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

    const { container } = renderProductDetectLeaf();
    const panel = await screen.findByTestId('note-paper-strict-panel');
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-hydrate-status', 'ready');
    });

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(host).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(host).toHaveAttribute('data-el03', 'not-claimed');
    expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
  });
});
