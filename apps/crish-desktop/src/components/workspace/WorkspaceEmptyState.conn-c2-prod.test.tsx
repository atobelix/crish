// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-C2′（C-prod）PaperList 产品默开
 *
 * - 新策略常量 `WORKSPACE_PRODUCT_ENABLE_PAPER_LIST = true`（workspaceProductPaperList.ts）
 * - 产品宿主 `WorkspaceProductEmptyHost` 显式传参 → 空态 Strict 挂 PaperList
 *   （产品默认 `presentationMode=paper-list`）
 * - EmptyState **组件默认仍 false**：`conn_c2_default_no_paper_list` 保留不回退
 * - presentationMode 互斥不回退：paper-list ⇄ content-row；debug-dual 仅显式
 *
 * ≠ W3-P（满窗 / 真 Diff / awareness）· ≠ EL-01
 * 默开 ≠ PaperList 完成；C2′ 新 ID ≠ C2 整包；
 * 产品默开是策略级决策（同 E2′ 形态），非组件语义变更
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceProductEmptyHost } from './workspaceProductMirrorDetect';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST } from './workspaceProductPaperList';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/components/workspace');

function readWorkspaceSrc(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

async function openStrictAndWait() {
  fireEvent.click(screen.getByTestId('open-note-paper-strict'));
  await waitFor(() => {
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
  });
}

describe('WorkspaceEmptyState · CONN-C2′ PaperList 产品默开', () => {
  // -------------------------------------------------------------------------
  // CONN-C2′：产品宿主默开 PaperList（组件默认仍 false 不回退）
  // - 策略常量 = true；宿主裸渲染 → data-product-paper-list=1
  // - 打开 Strict → host/panel data-paper-list=1 + presentationMode=paper-list
  // - ≠ EL-01；≠ W3-P 满窗；默开 ≠ PaperList 完成
  // -------------------------------------------------------------------------

  it('conn_c2_prod_default_paper_list_on', async () => {
    // 策略常量语义 = C2′ 产品默开
    expect(WORKSPACE_PRODUCT_ENABLE_PAPER_LIST).toBe(true);

    render(<WorkspaceProductEmptyHost wsId="ws-c2-prod" />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-product-paper-list', '1');
    expect(root).toHaveAttribute('data-el01', 'not-claimed');
    expect(root).toHaveAttribute('data-w3p-full', 'not-claimed');

    await openStrictAndWait();

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-product-paper-list', '1');
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
  });

  it('conn_c2_prod_paper_list_mutex_content_row', async () => {
    render(<WorkspaceProductEmptyHost wsId="ws-c2-prod-mutex" />);

    await openStrictAndWait();

    const panel = screen.getByTestId('note-paper-strict-panel');
    // 产品默开 → paper-list 内容槽挂载；与 content-row 互斥（非 debug-dual 双内容）
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    // chrome 分槽仍可同屏（不计入内容互斥）
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toHaveAttribute(
      'data-bp-chrome-mount',
      '1'
    );
  });

  it('conn_c2_prod_default_probe_data_paper_list_1', async () => {
    // 探针断言同步：root / strict host / panel 三处 data-paper-list 族 = 1
    render(<WorkspaceProductEmptyHost wsId="ws-c2-prod-probe" />);

    expect(screen.getByRole('status')).toHaveAttribute(
      'data-product-paper-list',
      '1'
    );

    await openStrictAndWait();

    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-product-paper-list',
      '1'
    );
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-paper-list',
      '1'
    );

    // 组件默认值仍 = false（未改组件语义）：src 级钉
    expect(readWorkspaceSrc('WorkspaceEmptyState.tsx')).toMatch(
      /enableProductPaperList\s*=\s*false/
    );

    // 产品宿主显式传参（策略常量在宿主侧被消费）：src 级钉
    expect(readWorkspaceSrc('workspaceProductMirrorDetect.tsx')).toMatch(
      /enableProductPaperList=\{WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\}/
    );

    // 策略常量文件语义 = true
    expect(readWorkspaceSrc('workspaceProductPaperList.ts')).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\s*=\s*true/
    );
  });
});
