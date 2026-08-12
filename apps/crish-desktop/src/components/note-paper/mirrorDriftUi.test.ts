/**
 * A-INV-02 镜像漂移 UI 纯逻辑测（X-05 + 三路映射）
 *
 * - unpushed>0 禁静默 DropUnacked
 * - 显式确认后才允许 drop_unacked
 * - keep_doc 不 callsImport
 * - **≠ EL-03**；**≠ inotify 满关**
 */
import { describe, expect, it } from 'vitest';
import {
  A_INV_02_UI_DIRECTION_ID,
  isDriftAttention,
  makeMirrorDriftReportView,
  MIRROR_DRIFT_UI_HONESTY,
  resolveThreeWayAction,
  shouldShowThreeWayActions,
} from './mirrorDriftUi';

describe('mirrorDriftUi · resolveThreeWayAction · X-05', () => {
  it('keep_doc：不调用 import，无 strategy', () => {
    const d = resolveThreeWayAction('keep_doc', {
      unpushedOpCount: 3,
      driftClass: 'mirror_only',
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.strategy).toBeNull();
      expect(d.callsImport).toBe(false);
      expect(d.discardsUnpushed).toBe(false);
    }
  });

  it('mark_conflict → conflict_blocks（有 unpushed 亦可）', () => {
    const d = resolveThreeWayAction('mark_conflict', {
      unpushedOpCount: 2,
      driftClass: 'both',
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.strategy).toBe('conflict_blocks');
      expect(d.callsImport).toBe(true);
      expect(d.discardsUnpushed).toBe(false);
    }
  });

  it('accept_mirror + unpushed=0 → retain_local_and_reimport', () => {
    const d = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 0,
      driftClass: 'mirror_only',
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.strategy).toBe('retain_local_and_reimport');
      expect(d.callsImport).toBe(true);
      expect(d.discardsUnpushed).toBe(false);
    }
  });

  it('X-05：accept_mirror + unpushed>0 且未确认 → 拒绝静默 DropUnacked', () => {
    const d = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 4,
      driftClass: 'mirror_only',
      confirmDiscardUnpushed: false,
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe('x05_silent_drop_blocked');
      expect(d.reason).toMatch(/unpushed|拒绝静默/i);
    }
  });

  it('X-05：accept_mirror + unpushed>0 + 显式确认 → drop_unacked', () => {
    const d = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 1,
      driftClass: 'both',
      confirmDiscardUnpushed: true,
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.strategy).toBe('drop_unacked');
      expect(d.discardsUnpushed).toBe(true);
      expect(d.callsImport).toBe(true);
    }
  });

  it('accept_mirror 在 none 类 → no_drift', () => {
    const d = resolveThreeWayAction('accept_mirror', {
      unpushedOpCount: 0,
      driftClass: 'none',
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe('no_drift');
    }
  });
});

describe('mirrorDriftUi · 展示辅助与诚实锚', () => {
  it('shouldShowThreeWayActions：仅 mirror_only / both / missing_file', () => {
    expect(shouldShowThreeWayActions('mirror_only')).toBe(true);
    expect(shouldShowThreeWayActions('both')).toBe(true);
    expect(shouldShowThreeWayActions('missing_file')).toBe(true);
    expect(shouldShowThreeWayActions('none')).toBe(false);
    expect(shouldShowThreeWayActions('authority_only')).toBe(false);
    expect(shouldShowThreeWayActions('no_meta')).toBe(false);
  });

  it('isDriftAttention：none/authority_only 不强调', () => {
    expect(isDriftAttention('mirror_only')).toBe(true);
    expect(isDriftAttention('none')).toBe(false);
    expect(isDriftAttention('authority_only')).toBe(false);
  });

  it('诚实脚注钉 EL-03 / inotify 非关', () => {
    expect(MIRROR_DRIFT_UI_HONESTY).toMatch(/poll|OS/);
    expect(MIRROR_DRIFT_UI_HONESTY).toMatch(/≠ EL-03|EL-03/);
    expect(MIRROR_DRIFT_UI_HONESTY).toMatch(/inotify/);
    expect(A_INV_02_UI_DIRECTION_ID).toBe('A-INV-02-UI');
  });

  it('makeMirrorDriftReportView 填充可测默认', () => {
    const r = makeMirrorDriftReportView({
      docId: 'd1',
      class: 'mirror_only',
      pendingLag: 2,
    });
    expect(r.docId).toBe('d1');
    expect(r.mirrorChanged).toBe(true);
    expect(r.fileExists).toBe(true);
    expect(r.pendingLag).toBe(2);
  });
});
