// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-E2 mirror StatusBar
 *
 * 夹具 ≠ 产品入口 ≠ 打开完成 ≠ EL-03。jsdom 绿 ≠ 真壳。
 *
 * 直渲 EmptyState 着陆：`data-mirror-drift-bar=0` / 无 StatusBar / 诚实锚
 * 会计留下（夹具默认关）。
 *
 * 「点 CTA 再证面板默认无 StatusBar」产品叶等价见
 * `NoteLeafHost.conn-ext.test.tsx` `conn_ext_e2_prime_policy_on_no_tauri`
 * 与 `Workspace.conn-e2-prime.test.tsx`
 * `conn_e2p_empty_state_direct_still_defaults_off` /
 * `conn_e2p_no_tauri_does_not_fabricate_report`
 * （本文件已删该重复 CTA 段）。
 * 产品默开 detect 见 e2-prime / conn-ext。
 *
 * `showMirrorDriftBar` / `mirrorDriftReport` / `mirrorIpc` / X-05 unpushed
 * 是夹具注入面：叶不吃这些 EmptyState prop；禁止给叶加测试专用 prop。
 *
 * 自 WorkspaceEmptyState.strict.test.tsx 按域拆出（SD-35）；CONN-E3 再拆至
 * WorkspaceEmptyState.conn-e3.test.tsx（SD-42）。断言语义不变。
 *
 * 夹具测头见 WorkspaceEmptyState.strict.test.tsx。
 * CONN-E3 detect 调度见 WorkspaceEmptyState.conn-e3.test.tsx。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockNoteMirrorIpc } from '../../api/noteMirrorIpc';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  makeMirrorDriftReportView,
  type ThreeWayDecision,
} from '../note-paper/mirrorDriftUi';

describe('WorkspaceEmptyState · CONN-E2 mirror StatusBar', () => {
  // -------------------------------------------------------------------------
  // CONN-E2：夹具着陆会计（默认关）+ opt-in 注入（叶不吃这些 EmptyState prop）
  // ≠ 产品入口 ≠ 打开完成；≠ EL-03；≠ inotify 满关；无 report 不造假
  // 产品默开 detect 见 e2-prime / conn-ext
  // -------------------------------------------------------------------------

  it('conn_e2_product_empty_default_no_mirror_status_bar', () => {
    render(<WorkspaceEmptyState wsId="ws-conn-e2-off" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    // 不再点 CTA；面板默认无条见 conn-ext / e2-prime
  });

  it('conn_e2_product_empty_showMirrorDriftBar_idle_no_fake_report', async () => {
    // 夹具注入面（showMirrorDriftBar）；叶不吃该 EmptyState prop
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-idle"
        mirror={{
          showMirrorDriftBar: true,
          mirrorWatchSource: 'poll',
        }}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-mirror-drift-bar',
      '1'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'idle');
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-class')).toHaveTextContent(
      '未检测'
    );
    // 无 report → 无三路（不假装已 detect）
    expect(screen.queryByTestId('mirror-drift-three-way')).toBeNull();
  });

  it('conn_e2_product_empty_injected_report_shows_bar_and_three_way', async () => {
    // 夹具注入面（mirrorDriftReport）；叶不吃该 EmptyState prop
    const seen: ThreeWayDecision[] = [];
    const docId = 'strict-ws-conn-e2-rpt';
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-rpt"
        mirror={{
          mirrorDriftReport: makeMirrorDriftReportView({
            docId,
            class: 'mirror_only',
            pendingLag: 2,
          }),
          mirrorWatchSource: 'injected',
          mirrorUnpushedOpCount: 0,
          onMirrorThreeWay: (d) => {
            seen.push(d);
          },
        }}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-mirror-drift-bar',
      '1'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    expect(bar).toHaveAttribute('data-watch-source', 'injected');
    expect(bar).toHaveAttribute('data-three-way', 'true');
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=2');

    fireEvent.click(screen.getByTestId('mirror-drift-keep-doc'));
    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(true);
    if (seen[0].ok) {
      expect(seen[0].action).toBe('keep_doc');
      expect(seen[0].callsImport).toBe(false);
    }

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(seen).toHaveLength(2);
    expect(seen[1].ok).toBe(true);
    if (seen[1].ok) {
      expect(seen[1].strategy).toBe('retain_local_and_reimport');
      expect(seen[1].discardsUnpushed).toBe(false);
    }

    fireEvent.click(screen.getByTestId('mirror-drift-mark-conflict'));
    expect(seen).toHaveLength(3);
    expect(seen[2].ok).toBe(true);
    if (seen[2].ok) {
      expect(seen[2].strategy).toBe('conflict_blocks');
    }
  });

  it('conn_e2_product_empty_mirrorIpc_accept_imports_and_x05_blocks', async () => {
    // 夹具注入面（mirrorIpc + X-05 unpushed）；叶不吃这些 EmptyState prop
    const docId = 'strict-ws-conn-e2-ipc';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'mirror_only' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ipc"
        mirror={{
          mirrorDriftReport: makeMirrorDriftReportView({
            docId,
            class: 'mirror_only',
          }),
          mirrorWatchSource: 'injected',
          mirrorUnpushedOpCount: 2,
          mirrorIpc: ipc,
        }}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-status-bar')).toBeInTheDocument();
    });

    // X-05：unpushed>0 无确认 → 不 import
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-gate')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mirror-drift-gate')).toHaveTextContent(
      /unpushed|拒绝静默/
    );
    expect(ipc.importCalls).toHaveLength(0);

    // 勾选确认后 → drop_unacked 调 mock IPC
    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('drop_unacked');
    expect(ipc.importCalls[0]?.docId).toBe(docId);
    expect(ipc.importCalls[0]?.unpushedOpCount).toBe(2);

    // 诚实锚仍在
    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
  });

  it('conn_e2_product_empty_onMirrorThreeWay_overrides_mirrorIpc', async () => {
    // 夹具注入面（onMirrorThreeWay 优先 mirrorIpc）；叶不吃这些 EmptyState prop
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e2-ov': { class: 'both' },
    });
    const onAction = vi.fn();

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ov"
        mirror={{
          mirrorDriftReport: makeMirrorDriftReportView({
            docId: 'strict-ws-conn-e2-ov',
            class: 'both',
          }),
          mirrorUnpushedOpCount: 0,
          mirrorIpc: ipc,
          onMirrorThreeWay: onAction,
        }}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(onAction).toHaveBeenCalledTimes(1);
    // 显式 onMirrorThreeWay 优先 → 不经 bridge 调 IPC
    expect(ipc.importCalls).toHaveLength(0);
  });
});
