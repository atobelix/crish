/**
 * LR-H1 · 产品 Strict 打开 docId 解析（纯函数）
 *
 * ≠ 打开完成 · ≠ EL-01 / EL-04 / EL-08
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindWorkspacePersistedStrictDoc,
  buildStrictDocBindingDataAttrs,
  peekWorkspacePersistedStrictDoc,
  resetWorkspacePersistedStrictDocBindings,
  resolveProductStrictDocId,
  syntheticStrictDocId,
  unbindWorkspacePersistedStrictDoc,
} from './workspaceEmptyStateStrictDoc';

describe('workspaceEmptyStateStrictDoc · LR-H1', () => {
  afterEach(() => {
    resetWorkspacePersistedStrictDocBindings();
  });

  it('lr_h1_resolve_unbound_falls_back_to_synthetic_strict_ws', () => {
    const wsId = 'ws-unbound';
    const out = resolveProductStrictDocId({ wsId });
    expect(out.docId).toBe(`strict-${wsId}`);
    expect(out.docId).toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('synthetic-unbound');
    expect(out.syntheticFallback).toBe(`strict-${wsId}`);
  });

  it('lr_h1_resolve_product_strict_doc_id_overrides_synthetic', () => {
    const wsId = 'ws-bound-prop';
    const persisted = 'doc-persisted-note';
    const out = resolveProductStrictDocId({
      wsId,
      productStrictDocId: persisted,
    });
    expect(out.docId).toBe(persisted);
    expect(out.docId).not.toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('explicit-prop');
    expect(out.syntheticFallback).toBe(`strict-${wsId}`);
  });

  it('lr_h1_resolve_blank_prop_still_unbound', () => {
    const wsId = 'ws-blank';
    const out = resolveProductStrictDocId({
      wsId,
      productStrictDocId: '   ',
      recentPersistedDocId: '',
    });
    expect(out.docId).toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('synthetic-unbound');
  });

  it('lr_h1_resolve_recent_persisted_when_no_explicit', () => {
    const wsId = 'ws-recent';
    const recent = 'doc-recent-persisted';
    const out = resolveProductStrictDocId({
      wsId,
      recentPersistedDocId: recent,
    });
    expect(out.docId).toBe(recent);
    expect(out.docId).not.toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('recent-persisted');
  });

  it('lr_h1_resolve_explicit_wins_over_recent_and_pre_open', () => {
    const wsId = 'ws-priority';
    bindWorkspacePersistedStrictDoc(wsId, 'doc-pre-open');
    const out = resolveProductStrictDocId({
      wsId,
      productStrictDocId: 'doc-explicit',
      recentPersistedDocId: 'doc-recent',
    });
    expect(out.docId).toBe('doc-explicit');
    expect(out.binding).toBe('explicit-prop');
  });

  it('lr_h1_resolve_pre_open_bind_after_apply_commit', () => {
    const wsId = 'ws-pre-open';
    bindWorkspacePersistedStrictDoc(wsId, '  doc-after-commit  ');
    expect(peekWorkspacePersistedStrictDoc(wsId)).toBe('doc-after-commit');
    const out = resolveProductStrictDocId({ wsId });
    expect(out.docId).toBe('doc-after-commit');
    expect(out.docId).not.toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('pre-open-bind');
  });

  it('lr_h1_unbind_restores_synthetic_fallback', () => {
    const wsId = 'ws-unbind';
    bindWorkspacePersistedStrictDoc(wsId, 'doc-tmp');
    unbindWorkspacePersistedStrictDoc(wsId);
    const out = resolveProductStrictDocId({ wsId });
    expect(out.docId).toBe(syntheticStrictDocId(wsId));
    expect(out.binding).toBe('synthetic-unbound');
  });

  it('lr_h1_binding_data_attrs_are_observable', () => {
    const resolution = resolveProductStrictDocId({
      wsId: 'ws-attrs',
      productStrictDocId: 'doc-bound',
    });
    const attrs = buildStrictDocBindingDataAttrs(resolution);
    expect(attrs['data-strict-doc-id']).toBe('doc-bound');
    expect(attrs['data-strict-doc-binding']).toBe('explicit-prop');
    expect(attrs['data-synthetic-strict-doc-id']).toBe('strict-ws-attrs');
    expect(attrs['data-strict-doc-id']).not.toBe(
      attrs['data-synthetic-strict-doc-id']
    );
  });
});
