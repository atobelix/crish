// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-C2 PaperList 产品默认策略
 *
 * 自 WorkspaceEmptyState.strict.test.tsx 按域拆出（SD-35）；断言语义不变。
 *
 * - **CONN-C2**：PaperList 产品默认 **关**（`enableProductPaperList` 默认 false →
 *   `data-product-paper-list=0` / panel `data-paper-list=0` / `react-rows`）；
 *   opt-in true → 挂 PaperList + `paper-list` 互斥 content-row；
 *   测钉 `conn_c2_default_no_paper_list` / `conn_c2_opt_in_paper_list_mutex`；
 *   **≠ EL-01**；**≠ W3-P 满窗**；禁默认真双内容
 *
 * 薄入口见 WorkspaceEmptyState.strict.test.tsx。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

describe('WorkspaceEmptyState · CONN-C2 PaperList 产品默认策略', () => {
  // -------------------------------------------------------------------------
  // CONN-C2：PaperList 产品默认策略可审计（默认关 + opt-in 互斥）
  // - 默认：不传 paperList → data-paper-list=0 / react-rows
  // - opt-in：enableProductPaperList → paper-list 挂载且 content-row 互斥
  // - ≠ EL-01；≠ W3-P 满窗；presentationMode 互斥不回退
  // -------------------------------------------------------------------------

  it('conn_c2_default_no_paper_list', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-c2-off" />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-product-paper-list', '0');
    expect(root).toHaveAttribute('data-el01', 'not-claimed');
    expect(root).toHaveAttribute('data-w3p-full', 'not-claimed');

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-product-paper-list', '0');
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');

    const panel = screen.getByTestId('note-paper-strict-panel');
    // 产品默认会计钉：不挂 PaperList
    expect(panel).toHaveAttribute('data-paper-list', '0');
    expect(panel).toHaveAttribute('data-presentation-mode', 'react-rows');
    expect(screen.queryByTestId('note-paper-strict-paper-list')).toBeNull();
    expect(panel.querySelector('[data-bp-paper-list-mount]')).toBeNull();
    // content-row 仍为默认内容宿主（非双内容）
    expect(
      panel.querySelectorAll('[data-content-row="1"]').length
    ).toBeGreaterThan(0);
  });

  it('conn_c2_opt_in_paper_list_mutex', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-c2-on" enableProductPaperList />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-product-paper-list', '1');
    expect(root).toHaveAttribute('data-el01', 'not-claimed');
    expect(root).toHaveAttribute('data-w3p-full', 'not-claimed');

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-product-paper-list', '1');

    const panel = screen.getByTestId('note-paper-strict-panel');
    // opt-in：presentationMode 产品默认 paper-list（互斥 content-row）
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
    // 内容互斥：不得同屏全量 content-row（presentationMode 不回退 debug-dual）
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
    // chrome 分槽仍可同屏（不计入内容互斥）
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toHaveAttribute(
      'data-bp-chrome-mount',
      '1'
    );
    // 诚实：≠ EL-01 / ≠ W3-P
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');
  });
});
