// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-E3 detect→report 调度
 *
 * 夹具 ≠ 产品入口 ≠ 打开完成 ≠ EL-03 ≠ inotify 满关。
 *
 * 直渲 EmptyState 着陆：`data-mirror-detect-schedule=0` / 零 detect
 * 会计留下（夹具默认关；仅有 mirrorIpc、未 enable 亦不调度）。
 *
 * 「点 CTA 再证未 enable 则面板也不调度」产品叶等价见
 * `NoteLeafHost.conn-ext.test.tsx` `conn_ext_e2_prime_policy_on_no_tauri`
 * / `Workspace.conn-e2-prime.test.tsx` `conn_e2p_no_tauri_does_not_fabricate_report`
 * （本文件已删该重复 CTA 段）。
 *
 * `enableMirrorDetectSchedule` + mock ipc 才调度：夹具 opt-in。
 * 产品叶走策略常量 true + 产品 IPC（无 Tauri 为 undefined）。
 * 禁止给叶加 EmptyState 同款 prop。X-05 it 留夹具（叶不传 unpushed）。
 *
 * 自 WorkspaceEmptyState.conn-e2.test.tsx 按域拆出（SD-42）。
 * CONN-E2 StatusBar 见 WorkspaceEmptyState.conn-e2.test.tsx。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockNoteMirrorIpc } from '../../api/noteMirrorIpc';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

describe('WorkspaceEmptyState · CONN-E3 detect 调度', () => {
  // -------------------------------------------------------------------------
  // CONN-E3：landing 会计（默认不调度）+ 夹具 opt-in
  // enable + mock ipc 才调度；产品叶走策略常量 + 产品 IPC
  // ≠ 产品入口 ≠ 打开完成；≠ EL-03；≠ inotify 满关
  // -------------------------------------------------------------------------

  it('conn_e3_product_empty_default_no_detect_schedule', () => {
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e3-off': { class: 'mirror_only' },
    });

    render(<WorkspaceEmptyState wsId="ws-conn-e3-off" mirror={{ mirrorIpc: ipc }} />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // 仅有 mirrorIpc、未 enable 调度 → 零 detect
    expect(ipc.detectCalls).toHaveLength(0);
    // 不再点 CTA；未 enable 则面板也不调度见 conn-ext / e2-prime
  });

  it('conn_e3_product_empty_opt_in_detect_fills_report_and_bar', async () => {
    // 夹具 opt-in：enable + mock ipc。产品叶走策略常量 + 产品 IPC，无 EmptyState 同款 prop。
    const docId = 'strict-ws-conn-e3-on';
    const ipc = createMockNoteMirrorIpc({
      [docId]: {
        class: 'mirror_only',
        path: '/tmp/e3.md',
        pendingLag: 3,
      },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e3-on"
        mirror={{
          mirrorIpc: ipc,
          enableMirrorDetectSchedule: true,
          mirrorUnpushedOpCount: 0,
        }}
      />
    );

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '1');
    // 调度激活 → 条可挂（idle 或 report）
    expect(root).toHaveAttribute('data-mirror-drift-bar', '1');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // 夹具 opt-in → mock detect 被调（≠ 产品入口 / 打开完成）
    await waitFor(() => {
      expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(ipc.detectCalls[0]?.docId).toBe(docId);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-status-bar')).toBeInTheDocument();
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '1');
    expect(host).toHaveAttribute('data-mirror-drift-bar', '1');

    const bar = screen.getByTestId('mirror-drift-status-bar');
    await waitFor(() => {
      expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    });
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).toHaveAttribute('data-three-way', 'true');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=3');

    // accept → import（E2 桥不回退；X-05 unpushed=0）
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('retain_local_and_reimport');
    expect(ipc.importCalls[0]?.docId).toBe(docId);
    expect(ipc.importCalls[0]?.unpushedOpCount).toBe(0);
  });

  it('conn_e3_product_empty_enable_without_ipc_no_detect', () => {
    // 夹具：enable 但无 ipc → scheduleActive=false；不假装已调度
    // 产品叶无 Tauri 时 IPC 为 undefined，见 e2-prime / conn-ext
    render(
      <WorkspaceEmptyState wsId="ws-conn-e3-noipc" mirror={{ enableMirrorDetectSchedule: true }} />
    );
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
  });

  it('conn_e3_product_empty_opt_in_x05_still_blocks_silent_drop', async () => {
    // 夹具 X-05：须注入 unpushed；产品叶不传该 prop。夹具 ≠ 产品入口。
    const docId = 'strict-ws-conn-e3-x05';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'both' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e3-x05"
        mirror={{
          mirrorIpc: ipc,
          enableMirrorDetectSchedule: true,
          mirrorUnpushedOpCount: 2,
        }}
      />
    );

    await waitFor(() => {
      expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    });

    // X-05：unpushed>0 无确认 → 不 import
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-gate')).toBeInTheDocument();
    });
    expect(ipc.importCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('drop_unacked');
  });
});
