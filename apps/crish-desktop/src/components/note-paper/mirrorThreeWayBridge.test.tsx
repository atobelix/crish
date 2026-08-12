// @vitest-environment jsdom
/**
 * 三路 UI resolve + mock IPC 串联（CONN-E · E-X2 方向）
 *
 * - StatusBar 点「接受镜像」+ unpushed>0 无确认 → 不调 import（X-05）
 * - 勾选确认后 → drop_unacked 调用 mock IPC
 * - keep_doc → 不 import
 *
 * ≠ EL-03；≠ inotify 满关。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockNoteMirrorIpc } from '../../api/noteMirrorIpc';
import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
import {
  createMirrorThreeWayOnAction,
  submitThreeWayViaMirrorIpc,
} from './mirrorThreeWayBridge';
import {
  makeMirrorDriftReportView,
  resolveThreeWayAction,
  type ThreeWayDecision,
} from './mirrorDriftUi';

describe('mirrorThreeWayBridge · resolve + mock IPC', () => {
  it('X-05：blocked decision 不调用 import', async () => {
    const ipc = createMockNoteMirrorIpc({
      d: { class: 'mirror_only' },
    });
    const blocked = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 2,
      confirmDiscardUnpushed: false,
      driftClass: 'mirror_only',
    });
    expect(blocked.ok).toBe(false);

    const r = await submitThreeWayViaMirrorIpc(blocked, {
      docId: 'd',
      unpushedOpCount: 2,
      ipc,
    });
    expect(r.submitted).toBe(false);
    if (!r.submitted) {
      expect(r.reason).toBe('decision_blocked');
      expect(r.code).toBe('x05_silent_drop_blocked');
    }
    expect(ipc.importCalls).toHaveLength(0);
  });

  it('accept + unpushed=0 → retain_local_and_reimport 调 IPC', async () => {
    const ipc = createMockNoteMirrorIpc({
      d: { class: 'mirror_only', opsCount: 1 },
    });
    const d = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 0,
      driftClass: 'mirror_only',
    });
    const r = await submitThreeWayViaMirrorIpc(d, {
      docId: 'd',
      unpushedOpCount: 0,
      ipc,
    });
    expect(r.submitted).toBe(true);
    if (r.submitted) {
      expect(r.outcome.ok).toBe(true);
      if (r.outcome.ok) {
        expect(r.outcome.kind).toBe('op_batch');
        expect(r.outcome.applied).toBe(false);
      }
    }
    expect(ipc.importCalls[0]?.strategy).toBe('retain_local_and_reimport');
  });

  it('keep_doc 不 import', async () => {
    const ipc = createMockNoteMirrorIpc();
    const d = resolveThreeWayAction('keep_doc', {
      unpushedOpCount: 5,
      driftClass: 'both',
    });
    const r = await submitThreeWayViaMirrorIpc(d, {
      docId: 'd',
      unpushedOpCount: 5,
      ipc,
    });
    expect(r.submitted).toBe(false);
    if (!r.submitted) expect(r.reason).toBe('keep_doc_no_import');
    expect(ipc.importCalls).toHaveLength(0);
  });

  it('StatusBar 串联：unpushed 先挡后 drop 才 import（E-X2）', async () => {
    const ipc = createMockNoteMirrorIpc({
      'doc-e': { class: 'mirror_only' },
    });
    const results: Awaited<ReturnType<typeof submitThreeWayViaMirrorIpc>>[] =
      [];
    const onAction = createMirrorThreeWayOnAction(
      { docId: 'doc-e', unpushedOpCount: 2, ipc },
      (r) => {
        results.push(r);
      }
    );

    render(
      <MirrorDriftStatusBar
        report={makeMirrorDriftReportView({
          docId: 'doc-e',
          class: 'mirror_only',
        })}
        unpushedOpCount={2}
        watchSource="injected"
        onAction={onAction}
      />
    );

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
    expect(results[0]?.submitted).toBe(false);
    expect(ipc.importCalls).toHaveLength(0);
    expect(screen.getByTestId('mirror-drift-gate')).toHaveTextContent(
      /unpushed|拒绝静默/
    );

    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
    expect(results[1]?.submitted).toBe(true);
    if (results[1]?.submitted && results[1].outcome.ok) {
      expect(results[1].outcome.kind).toBe('op_batch');
      expect(results[1].decision.ok && results[1].decision.strategy).toBe(
        'drop_unacked'
      );
    }
    expect(ipc.importCalls).toHaveLength(1);
    expect(ipc.importCalls[0]?.strategy).toBe('drop_unacked');
    expect(ipc.importCalls[0]?.unpushedOpCount).toBe(2);
  });

  it('mark_conflict → conflict_blocks import（仍 applied=false）', async () => {
    const ipc = createMockNoteMirrorIpc({
      d: { class: 'both' },
    });
    const seen: ThreeWayDecision[] = [];
    const onAction = vi.fn(async (d: ThreeWayDecision) => {
      seen.push(d);
      await submitThreeWayViaMirrorIpc(d, {
        docId: 'd',
        unpushedOpCount: 1,
        ipc,
      });
    });

    render(
      <MirrorDriftStatusBar
        report={makeMirrorDriftReportView({ docId: 'd', class: 'both' })}
        unpushedOpCount={1}
        onAction={(d) => {
          void onAction(d);
        }}
      />
    );
    fireEvent.click(screen.getByTestId('mirror-drift-mark-conflict'));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('conflict_blocks');
  });
});
