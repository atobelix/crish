// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-D2 / CONN-D3 mdPrefix 写锥
 *
 * 夹具 ≠ 产品入口 ≠ 打开完成 ≠ A-BLK-08/09 e2e ≠ EL-01
 *
 * - 直渲 EmptyState landing：默认 `disabled` / `source=none` 会计留下
 * - 产品路径：activate 后渲 `NoteLeafHost`（不点 CTA）
 *   默认面板 mdPrefix 见 `conn_d2_leaf_*`
 *   slash 只读见 `NoteLeafHost.conn-ext.test.tsx` `conn_ext_slash_no_tauri_readonly`
 * - 注入 applyOps 可写：叶无 applyOps 注入 prop，不能改产品码改挂 → 留夹具
 * - D3 content-row 叶：产品叶默认 paper-list 互斥 content-row → 留夹具
 *
 * 夹具路径：直渲 EmptyState + 点 `open-note-paper-strict`（≠ 产品入口）。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ApplyOpsAdapter } from '@crish/block-paper';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper/activate';
import { NoteLeafHost } from '../../extensions/note-paper/NoteLeafHost';
import type { ViewRenderContext } from '../../services/view-registry';
import { viewRegistry } from '../../services/view-registry';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

function leafCtx(
  partial: Partial<ViewRenderContext> = {}
): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-conn-d2',
    sessionId: 'chat-session-99',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

/** 产品路径：activate 后渲叶（≠ 点夹具 CTA）。 */
async function activateAndRenderLeaf(
  partial: Partial<ViewRenderContext> = {}
) {
  activateNotePaper();
  expect(viewRegistry.getView('note')).toBeDefined();
  const view = render(<NoteLeafHost {...leafCtx(partial)} />);
  await waitFor(() => {
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
  });
  return view;
}

describe('WorkspaceEmptyState · CONN-D2 / CONN-D3 mdPrefix 写锥', () => {
  // -------------------------------------------------------------------------
  // CONN-D2：landing 会计（默认 disabled）+ 产品叶写锥
  // 桌面接线 ≠ 产品入口 ≠ 打开完成；≠ A-BLK-08/09 e2e；≠ EL-01
  // -------------------------------------------------------------------------

  beforeEach(() => {
    deactivateNotePaper();
  });

  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
  });

  it('conn_d2_product_empty_default_md_prefix_disabled', () => {
    render(<WorkspaceEmptyState wsId="ws-conn-d2-ro" />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-write-mode',
      'disabled'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-sink-source',
      'none'
    );
    // 不再点 CTA；产品面板见 conn_d2_leaf_default_md_prefix_disabled
  });

  it('conn_d2_leaf_default_md_prefix_disabled', async () => {
    const { container } = await activateAndRenderLeaf();

    expect(screen.queryByTestId('open-note-paper-strict')).toBeNull();
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(host?.contains(panel)).toBe(true);

    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(panel).toHaveAttribute('data-md-prefix-sink-source', 'none');
    expect(panel).toHaveAttribute('data-md-prefix-sink', '0');
    expect(panel).toHaveAttribute('data-md-prefix-leaf-path', 'product');
    expect(host).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(host).toHaveAttribute('data-md-prefix-sink-source', 'none');
  });

  it('conn_d2_product_empty_with_applyOps_md_prefix_writable_attrs', async () => {
    // 夹具：NoteLeafHost 无 applyOps 注入面，不能改产品码改挂。
    const applyOps: ApplyOpsAdapter = async () => ({ ok: true });
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-d2-wr"
        strict={{ strictApplyOps: applyOps }}
      />
    );

    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-write-mode',
      'writable'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-sink-source',
      'injected-applyOps'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'writable');
    expect(panel).toHaveAttribute(
      'data-md-prefix-sink-source',
      'injected-applyOps'
    );
    expect(panel).toHaveAttribute('data-md-prefix-sink', '1');
    // 与 slash 同 applyOps 可并行；≠ 关 EL / A-BLK-08
    expect(panel).toHaveAttribute('data-slash-write-mode', 'writable');
  });

  it('conn_d3_product_empty_leaf_writable_when_applyOps', async () => {
    // 夹具：产品叶默认 paper-list，无 content-row；叶无 applyOps 注入。
    // 叶键入见 StrictContentRowLeaf 测。≠ A-BLK-08 e2e / ≠ EL-01
    const applyOps: ApplyOpsAdapter = async () => ({ ok: true });
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-d3-leaf"
        strict={{ strictApplyOps: applyOps }}
      />
    );
    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-md-prefix-leaf-path', 'product');
    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'writable');
    const leaf = screen.getByTestId('note-strict-leaf-empty-strict-p1');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'writable');
    expect(leaf).toHaveAttribute('data-strict-leaf-input', '1');
    expect(
      screen.getByTestId('note-strict-block-empty-strict-p1')
    ).toHaveAttribute('data-flavour', 'paragraph');
  });
});
