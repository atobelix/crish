// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-C2′（C-prod）PaperList 产品默开
 *
 * 夹具 ≠ 产品入口 ≠ 打开完成。
 * WorkspaceProductEmptyHost 已删，不得再当入口。EmptyState + CTA 仍是夹具。
 * 产品到达面是 `activateNotePaper` 后的 `NoteLeafHost` 叶。
 *
 * - 策略常量 `WORKSPACE_PRODUCT_ENABLE_PAPER_LIST = true`
 * - 产品叶消费常量 → Strict `data-paper-list=1` / `presentationMode=paper-list`
 * - EmptyState **组件默认仍 false**：src 钉不回退
 * - presentationMode 互斥不回退：paper-list ⇄ content-row
 * 策略常量从扩展家 import，旧路径只 re-export。
 *
 * ≠ W3-P · ≠ EL-01 · 默开 ≠ PaperList 完成 · jsdom 绿 ≠ 打开完成
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { viewRegistry } from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper/activate';
import { NoteLeafHost } from '../../extensions/note-paper/NoteLeafHost';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST } from '../../extensions/note-paper/productPaperListPolicy';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/components/workspace');

const EXT_DIR = join(DIR, '../../extensions/note-paper');

function readWorkspaceSrc(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

function readExt(name: string): string {
  return readFileSync(join(EXT_DIR, name), 'utf8');
}

function ctx(partial: Partial<ViewRenderContext> = {}): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-c2-prod',
    sessionId: 'chat-session-99',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

/** 产品入口：activate 后渲叶（≠ 点夹具 CTA）。 */
async function activateAndRenderLeaf(
  partial: Partial<ViewRenderContext> = {}
) {
  activateNotePaper();
  expect(viewRegistry.getView('note')).toBeDefined();
  const view = render(<NoteLeafHost {...ctx(partial)} />);
  await waitFor(() => {
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
  });
  return view;
}

describe('WorkspaceEmptyState · CONN-C2′ PaperList 产品默开', () => {
  // -------------------------------------------------------------------------
  // CONN-C2′：产品叶默开 PaperList（夹具 Host / EmptyState 默认仍 false）
  // - 策略常量 = true；activate → NoteLeafHost → data-paper-list=1
  // - ≠ EL-01；≠ W3-P 满窗；夹具 ≠ 产品入口 ≠ 打开完成
  // -------------------------------------------------------------------------

  beforeEach(() => {
    deactivateNotePaper();
  });

  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
  });

  it('conn_c2_prod_default_paper_list_on', async () => {
    expect(WORKSPACE_PRODUCT_ENABLE_PAPER_LIST).toBe(true);

    const { container } = await activateAndRenderLeaf();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-product-paper-list', '1');
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');
    expect(host).toHaveAttribute('data-open-complete', 'not-claimed');

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(host?.contains(panel)).toBe(true);
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
  });

  it('conn_c2_prod_paper_list_mutex_content_row', async () => {
    const { container } = await activateAndRenderLeaf();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(host?.contains(panel)).toBe(true);
    expect(screen.getByTestId('note-paper-strict-paper-list')).toHaveAttribute(
      'data-bp-paper-list-mount',
      '1'
    );
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(screen.getByTestId('note-paper-strict-chrome-dom')).toHaveAttribute(
      'data-bp-chrome-mount',
      '1'
    );
  });

  it('conn_c2_prod_default_probe_data_paper_list_1', async () => {
    const { container } = await activateAndRenderLeaf();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toHaveAttribute('data-product-paper-list', '1');
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-paper-list',
      '1'
    );

    // 组件默认值仍 = false（未改组件语义）：src 级钉
    expect(readWorkspaceSrc('WorkspaceEmptyState.tsx')).toMatch(
      /enableProductPaperList\s*=\s*false/
    );

    // 产品叶消费策略常量（到达面已改挂 NoteLeafHost）
    expect(readExt('NoteLeafHost.tsx')).toMatch(
      /paperList=\{WORKSPACE_PRODUCT_ENABLE_PAPER_LIST/
    );

    // 策略常量文件语义 = true（实现在扩展；workspace 只 re-export）
    expect(readExt('productPaperListPolicy.ts')).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\s*=\s*true/
    );
    expect(readWorkspaceSrc('workspaceProductPaperList.ts')).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_PAPER_LIST\s*=\s*true/
    );
  });
});
