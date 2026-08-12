// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-E2 / CONN-E3 mirror StatusBar + detect 调度
 *
 * 自 WorkspaceEmptyState.w5b.test.tsx 按域拆出（SD-35）；断言语义不变。
 *
 * - **CONN-E2**：mirror StatusBar 默认关；`showMirrorDriftBar` / `mirrorDriftReport`
 *   opt-in 才挂；注入 report → 三路可测；`mirrorIpc` → accept 走 import（X-05）；
 *   **≠ EL-03**；**≠ inotify 满关**；无 report 不造假
 * - **CONN-E3**：detect→report 调度默认关；`enableMirrorDetectSchedule` + `mirrorIpc`
 *   → mock/Tauri detect → report 喂 StatusBar；`data-mirror-detect-schedule=0|1`；
 *   关时无 detect 定时器；X-05 / import 不回退；**≠ EL-03**；**≠ inotify 满关**
 *
 * 薄入口见 WorkspaceEmptyState.w5b.test.tsx。
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

describe('WorkspaceEmptyState · CONN-E2 / CONN-E3 mirror', () => {
  // -------------------------------------------------------------------------
  // CONN-E2：产品空态 mirror StatusBar opt-in 装配
  // 默认关；注入 report → 可见 + 三路可测；mirrorIpc → import；X-05 不回退
  // ≠ EL-03；≠ inotify 满关；无 report 不造假
  // -------------------------------------------------------------------------

  it('conn_e2_product_empty_default_no_mirror_status_bar', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-e2-off" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-mirror-drift-bar',
      '0'
    );
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    // hydrate 锚不回退
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'fixture'
    );
  });

  it('conn_e2_product_empty_showMirrorDriftBar_idle_no_fake_report', async () => {
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-idle"
        showMirrorDriftBar
        mirrorWatchSource="poll"
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
    const seen: ThreeWayDecision[] = [];
    const docId = 'strict-ws-conn-e2-rpt';
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-rpt"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId,
          class: 'mirror_only',
          pendingLag: 2,
        })}
        mirrorWatchSource="injected"
        mirrorUnpushedOpCount={0}
        onMirrorThreeWay={(d) => {
          seen.push(d);
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
    const docId = 'strict-ws-conn-e2-ipc';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'mirror_only' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ipc"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId,
          class: 'mirror_only',
        })}
        mirrorWatchSource="injected"
        mirrorUnpushedOpCount={2}
        mirrorIpc={ipc}
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
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e2-ov': { class: 'both' },
    });
    const onAction = vi.fn();

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ov"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId: 'strict-ws-conn-e2-ov',
          class: 'both',
        })}
        mirrorUnpushedOpCount={0}
        mirrorIpc={ipc}
        onMirrorThreeWay={onAction}
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

  // -------------------------------------------------------------------------
  // CONN-E3：产品 detect→report 调度（opt-in）
  // 默认不调度；enable + mirrorIpc → detect → report 可达 StatusBar
  // ≠ EL-03；≠ inotify 满关；X-05 / import 不回退
  // -------------------------------------------------------------------------

  it('conn_e3_product_empty_default_no_detect_schedule', async () => {
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e3-off': { class: 'mirror_only' },
    });

    render(<WorkspaceEmptyState wsId="ws-conn-e3-off" mirrorIpc={ipc} />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // 仅有 mirrorIpc、未 enable 调度 → 零 detect
    expect(ipc.detectCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-mirror-detect-schedule',
      '0'
    );
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    expect(ipc.detectCalls).toHaveLength(0);
  });

  it('conn_e3_product_empty_opt_in_detect_fills_report_and_bar', async () => {
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
        mirrorIpc={ipc}
        enableMirrorDetectSchedule
        mirrorUnpushedOpCount={0}
      />
    );

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '1');
    // 调度激活 → 条可挂（idle 或 report）
    expect(root).toHaveAttribute('data-mirror-drift-bar', '1');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // opt-in → mock detect 被调
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

  it('conn_e3_product_empty_enable_without_ipc_no_detect', async () => {
    // enable 但无 ipc → scheduleActive=false；不假装已调度
    render(
      <WorkspaceEmptyState wsId="ws-conn-e3-noipc" enableMirrorDetectSchedule />
    );
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
  });

  it('conn_e3_product_empty_opt_in_x05_still_blocks_silent_drop', async () => {
    const docId = 'strict-ws-conn-e3-x05';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'both' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e3-x05"
        mirrorIpc={ipc}
        enableMirrorDetectSchedule
        mirrorUnpushedOpCount={2}
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
