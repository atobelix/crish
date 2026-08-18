// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-D2 / CONN-D3 mdPrefix 写锥
 *
 * 自 WorkspaceEmptyState.strict.test.tsx 按域拆出（SD-35）；断言语义不变。
 *
 * - **CONN-D2/D3**：无 applyOps 默认 mdPrefix disabled；注入后 `data-md-prefix-write-mode=writable`
 *   + content-row 叶 `data-md-prefix-leaf-mode=writable`（叶键入见 StrictContentRowLeaf 测）；
 *   **≠ A-BLK-08/09 e2e**
 *
 * 薄入口见 WorkspaceEmptyState.strict.test.tsx。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ApplyOpsAdapter } from '@crish/block-paper';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

describe('WorkspaceEmptyState · CONN-D2 / CONN-D3 mdPrefix 写锥', () => {
  // -------------------------------------------------------------------------
  // CONN-D2：产品空态 mdPrefix 写锥（默认 disabled / 注入可写）
  // 桌面接线 ≠ 打开完成；≠ A-BLK-08/09 e2e；≠ EL-01
  // -------------------------------------------------------------------------

  it('conn_d2_product_empty_default_md_prefix_disabled', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-d2-ro" />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-write-mode',
      'disabled'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-sink-source',
      'none'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(panel).toHaveAttribute('data-md-prefix-sink-source', 'none');
    expect(panel).toHaveAttribute('data-md-prefix-sink', '0');
    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-md-prefix-write-mode',
      'disabled'
    );
  });

  it('conn_d2_product_empty_with_applyOps_md_prefix_writable_attrs', async () => {
    const applyOps: ApplyOpsAdapter = async () => ({ ok: true });
    render(
      <WorkspaceEmptyState wsId="ws-conn-d2-wr" strict={{ strictApplyOps: applyOps }} />
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
    // CONN-D3：注入 applyOps 后 content-row 叶可写；**≠ A-BLK-08 e2e / ≠ EL-01**
    const applyOps: ApplyOpsAdapter = async () => ({ ok: true });
    render(
      <WorkspaceEmptyState wsId="ws-conn-d3-leaf" strict={{ strictApplyOps: applyOps }} />
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
    // 演示 fixture 有 paragraph 叶
    const leaf = screen.getByTestId('note-strict-leaf-empty-strict-p1');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'writable');
    expect(leaf).toHaveAttribute('data-strict-leaf-input', '1');
    // 行 flavour 仍来自投影
    expect(
      screen.getByTestId('note-strict-block-empty-strict-p1')
    ).toHaveAttribute('data-flavour', 'paragraph');
  });
});
