// @vitest-environment jsdom
/**
 * MirrorDriftStatusBar · A-INV-02 UI 方向可点测
 *
 * - 漂移状态可点名
 * - 三路入口可点（接受镜像 / 保留文档 / 标记冲突）
 * - X-05：unpushed 时禁静默 DropUnacked
 * - data-el03 / data-inotify-full = not-claimed
 * - **≠ EL-03**；**≠ inotify 产品满关**
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MirrorDriftStatusBar } from './MirrorDriftStatusBar';
import {
  A_INV_02_UI_DIRECTION_ID,
  makeMirrorDriftReportView,
  type ThreeWayDecision,
} from './mirrorDriftUi';

describe('MirrorDriftStatusBar · 状态展示', () => {
  it('无 report 时展示 idle / 未检测；诚实锚在位', () => {
    render(<MirrorDriftStatusBar report={null} watchSource="poll" />);
    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'idle');
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).toHaveAttribute(
      'data-package-direction',
      A_INV_02_UI_DIRECTION_ID
    );
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-class')).toHaveTextContent(
      '未检测'
    );
    expect(screen.getByTestId('mirror-drift-honesty')).toHaveTextContent(
      /EL-03|inotify/
    );
    expect(screen.queryByTestId('mirror-drift-three-way')).toBeNull();
    // LR-V2：src 悬停走 Tooltip，零原生 title=
    const src = screen.getByTestId('mirror-drift-watch-source');
    expect(src).not.toHaveAttribute('title');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(src);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/≠ EL-03|inotify/);
  });

  it('mirror_only：展示分类 + 三路按钮 + lag', () => {
    const report = makeMirrorDriftReportView({
      docId: 'doc-m',
      class: 'mirror_only',
      pendingLag: 3,
    });
    render(
      <MirrorDriftStatusBar
        report={report}
        watchSource="os_event"
        unpushedOpCount={0}
      />
    );
    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    expect(bar).toHaveAttribute('data-watch-source', 'os_event');
    expect(bar).toHaveAttribute('data-attention', 'true');
    expect(bar).toHaveAttribute('data-three-way', 'true');
    expect(screen.getByTestId('mirror-drift-class')).toHaveTextContent(
      '仅镜像变'
    );
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=3');
    expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    expect(screen.getByTestId('mirror-drift-keep-doc')).toBeInTheDocument();
    expect(
      screen.getByTestId('mirror-drift-mark-conflict')
    ).toBeInTheDocument();
  });
});

describe('MirrorDriftStatusBar · 三路可点 + X-05', () => {
  it('keep_doc 可点 → onAction ok 且不 import', () => {
    const seen: ThreeWayDecision[] = [];
    const report = makeMirrorDriftReportView({
      docId: 'd',
      class: 'mirror_only',
    });
    render(
      <MirrorDriftStatusBar
        report={report}
        watchSource="injected"
        onAction={(d) => {
          seen.push(d);
        }}
      />
    );
    fireEvent.click(screen.getByTestId('mirror-drift-keep-doc'));
    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(true);
    if (seen[0].ok) {
      expect(seen[0].action).toBe('keep_doc');
      expect(seen[0].callsImport).toBe(false);
      expect(seen[0].strategy).toBeNull();
    }
    const last = screen.getByTestId('mirror-drift-last-decision');
    expect(last).toHaveAttribute('data-calls-import', 'false');
  });

  it('accept_mirror unpushed=0 → retain_local_and_reimport', () => {
    const seen: ThreeWayDecision[] = [];
    const report = makeMirrorDriftReportView({
      docId: 'd',
      class: 'both',
    });
    render(
      <MirrorDriftStatusBar
        report={report}
        unpushedOpCount={0}
        onAction={(d) => {
          seen.push(d);
        }}
      />
    );
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(seen[0].ok).toBe(true);
    if (seen[0].ok) {
      expect(seen[0].strategy).toBe('retain_local_and_reimport');
      expect(seen[0].discardsUnpushed).toBe(false);
    }
  });

  it('X-05：unpushed>0 点接受镜像 → 门禁拒绝；勾选确认后才 DropUnacked', () => {
    const seen: ThreeWayDecision[] = [];
    const report = makeMirrorDriftReportView({
      docId: 'd',
      class: 'mirror_only',
    });
    render(
      <MirrorDriftStatusBar
        report={report}
        unpushedOpCount={2}
        watchSource="poll"
        onAction={(d) => {
          seen.push(d);
        }}
      />
    );
    expect(screen.getByTestId('mirror-drift-unpushed')).toHaveTextContent(
      'unpushed=2'
    );
    expect(
      screen.getByTestId('mirror-drift-confirm-discard')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(false);
    if (!seen[0].ok) {
      expect(seen[0].code).toBe('x05_silent_drop_blocked');
    }
    expect(screen.getByTestId('mirror-drift-gate')).toHaveTextContent(
      /unpushed|拒绝静默/
    );

    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(seen).toHaveLength(2);
    expect(seen[1].ok).toBe(true);
    if (seen[1].ok) {
      expect(seen[1].strategy).toBe('drop_unacked');
      expect(seen[1].discardsUnpushed).toBe(true);
    }
  });

  it('mark_conflict → conflict_blocks', () => {
    const onAction = vi.fn();
    const report = makeMirrorDriftReportView({
      docId: 'd',
      class: 'missing_file',
    });
    render(
      <MirrorDriftStatusBar
        report={report}
        unpushedOpCount={5}
        onAction={onAction}
      />
    );
    fireEvent.click(screen.getByTestId('mirror-drift-mark-conflict'));
    expect(onAction).toHaveBeenCalledTimes(1);
    const d = onAction.mock.calls[0][0] as ThreeWayDecision;
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.strategy).toBe('conflict_blocks');
    }
  });
});

describe('MirrorDriftStatusBar · Strict 面板接线（可选注入）', () => {
  it('NotePaperStrictPanel 注入 report 后可见状态条，不回退 hydrate 锚', async () => {
    const { createFixtureHydrateTransport, makeHydratedBlock } =
      await import('./hydrateProjection');
    const { NotePaperStrictPanel } = await import('./NotePaperStrictPanel');
    const transport = createFixtureHydrateTransport({
      'doc-m': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'b1',
            flavour: 'paragraph',
            text: 'body',
            index: 0,
          }),
        ],
      },
    });
    const { waitFor } = await import('@testing-library/react');
    render(
      <NotePaperStrictPanel
        docId="doc-m"
        hydrateTransport={transport}
        mirrorDriftReport={makeMirrorDriftReportView({
          docId: 'doc-m',
          class: 'mirror_only',
        })}
        mirrorWatchSource="poll"
        mirrorUnpushedOpCount={0}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    expect(screen.getByTestId('mirror-drift-status-bar')).toHaveAttribute(
      'data-drift-class',
      'mirror_only'
    );
    expect(screen.getByTestId('mirror-drift-watch-source')).toHaveTextContent(
      'src=poll'
    );
    // hydrate / footer 锚仍在
    expect(screen.getByTestId('note-paper-strict-footer')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
