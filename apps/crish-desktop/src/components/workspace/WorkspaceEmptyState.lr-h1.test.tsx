// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · LR-H1 persist 文档绑定
 *
 * 有价值的 H1 打开 id 断言改挂：`activateNotePaper()` 后渲
 * `<NoteLeafHost params.docId / panelId=note:… />`，钉打在
 * `[data-note-leaf-host]` / `note-paper-strict-panel`。
 * 改挂的 it ≠ 打开完成 ≠ G-HYD ≠ 关 EL。
 * 合成空 / fixture 源不是打开完成。
 * 本文件不证产品入口。禁止点 `open-note-paper-strict` 证产品 H1。
 *
 * EmptyState 直渲 = 夹具 landing 属性（夹具路径；≠ 产品入口 ≠ 打开完成）。
 * resolver 只在扩展家 productStrictDoc。
 *
 * 完成定义：
 * - 绑定后打开 docId ≠ 永远只有死合成 `strict-${wsId}`
 * - 未写 doc 仍空成功 + 分轨诚实（有 Tauri mock → tauri-ipc 空；无 Tauri → fixture）
 * - 无绑定仍可走 `strict-${wsId}` 诚实空
 *
 * 头/测钉：**≠ 打开完成** · **≠ EL-01/04/08**
 * 不改 fixture 字面 `source:'fixture'`；不改 C2′/E2′；组件 C2 默认仍 false。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createMockNoteHydrateIpc } from '../../api/noteHydrateIpc';
import * as projectStore from '../../api/projectStore';
import * as hydrateProduct from '../note-paper/hydrateProjection';
import { createProductStrictHydrateTransport } from '../note-paper/hydrateProjection';
import {
  activateNotePaper,
  deactivateNotePaper,
} from '../../extensions/note-paper/activate';
import { NoteLeafHost } from '../../extensions/note-paper/NoteLeafHost';
import * as leafBindings from '../../extensions/note-paper/productLeafBindings';
import type { ViewRenderContext } from '../../services/view-registry';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  bindWorkspacePersistedStrictDoc,
  resetWorkspacePersistedStrictDocBindings,
  syntheticStrictDocId,
} from '../../extensions/note-paper/productStrictDoc';

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

function leafCtx(partial: Partial<ViewRenderContext> = {}): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-lr-h1',
    sessionId: 'sess-lr-h1',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

/** 改挂到达面：激活后渲叶。≠ 点 CTA · ≠ 打开完成 · ≠ 本文件证产品入口 */
function renderH1NoteLeaf(partial: Partial<ViewRenderContext> = {}) {
  activateNotePaper();
  return render(<NoteLeafHost {...leafCtx(partial)} />);
}

function mockWorkspaceKey(wsId: string): void {
  vi.spyOn(projectStore, 'getActiveProjectId').mockReturnValue(wsId);
  vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('');
}

function stubTauriHydrateIpc(
  docId: string,
  ipc: ReturnType<typeof createMockNoteHydrateIpc>
): void {
  const transport = createProductStrictHydrateTransport(docId, {
    isTauriRuntime: true,
    hydrateIpc: ipc,
  });
  vi.spyOn(
    hydrateProduct,
    'createProductStrictHydrateTransport'
  ).mockReturnValue(transport);
}

function expectHonestyNails(el: HTMLElement): void {
  expect(el).toHaveAttribute('data-el01', 'not-claimed');
  expect(el).toHaveAttribute('data-el04', 'not-claimed');
  expect(el).toHaveAttribute('data-el08', 'not-claimed');
  expect(el).toHaveAttribute('data-open-complete', 'not-claimed');
}

function expectNoProductCtaClickSurface(): void {
  expect(screen.queryByTestId('open-note-paper-strict')).toBeNull();
}

describe('WorkspaceEmptyState · LR-H1 persist doc 绑定', () => {
  beforeEach(() => {
    deactivateNotePaper();
    resetWorkspacePersistedStrictDocBindings();
    vi.spyOn(projectStore, 'getActiveProjectId').mockReturnValue(null);
    vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('');
    vi.spyOn(leafBindings, 'loadRecentPersistedDocId').mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
    vi.restoreAllMocks();
    resetWorkspacePersistedStrictDocBindings();
  });

  it('lr_h1_bound_open_uses_persisted_doc_id_not_dead_synthetic', async () => {
    const wsId = 'ws-lr-h1-bound';
    const persistedId = 'doc-persisted-after-commit';
    mockWorkspaceKey(wsId);
    const ipc = createMockNoteHydrateIpc({
      [persistedId]: {
        rev: 5,
        blocks: [
          {
            id: 'real-persist-1',
            flavour: 'paragraph',
            index: 0,
            text: 'already persisted body',
          },
        ],
      },
    });
    stubTauriHydrateIpc(persistedId, ipc);

    const { container } = renderH1NoteLeaf({
      panelId: `note:${persistedId}`,
      params: { docId: persistedId },
    });

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    expectNoProductCtaClickSurface();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-strict-doc-id', persistedId);
    expect(host).toHaveAttribute('data-strict-doc-binding', 'explicit-prop');
    expect(host).toHaveAttribute(
      'data-synthetic-strict-doc-id',
      syntheticStrictDocId(wsId)
    );
    expect(host?.getAttribute('data-strict-doc-id')).not.toBe(
      host?.getAttribute('data-synthetic-strict-doc-id')
    );
    expectHonestyNails(host as HTMLElement);

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(host?.contains(panel)).toBe(true);
    expect(panel).toHaveAttribute('data-doc-id', persistedId);
    expect(panel).not.toHaveAttribute(
      'data-doc-id',
      syntheticStrictDocId(wsId)
    );
    expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
    expect(panel).toHaveAttribute('data-block-count', '1');
    expect(screen.getByText('already persisted body')).toBeInTheDocument();
    expect(panel.querySelector('[data-block-id="empty-strict-h1"]')).toBeNull();
  });

  it('lr_h1_pre_open_bind_open_uses_bound_doc_id', async () => {
    const wsId = 'ws-lr-h1-preopen';
    const boundId = 'doc-apply-then-open';
    mockWorkspaceKey(wsId);
    bindWorkspacePersistedStrictDoc(wsId, boundId);

    const { container } = renderH1NoteLeaf({
      panelId: 'note',
      params: {},
    });

    const panel = await screen.findByTestId('note-paper-strict-panel');
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-hydrate-status', 'ready');
    });
    expectNoProductCtaClickSurface();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-strict-doc-id', boundId);
    expect(host).toHaveAttribute('data-strict-doc-binding', 'pre-open-bind');
    expect(host?.getAttribute('data-strict-doc-id')).not.toBe(
      syntheticStrictDocId(wsId)
    );
    expectHonestyNails(host as HTMLElement);

    expect(panel).toHaveAttribute('data-doc-id', boundId);
    expect(panel).not.toHaveAttribute(
      'data-doc-id',
      syntheticStrictDocId(wsId)
    );
    // 无 Tauri：分轨仍 fixture，禁止改成 tauri-ipc。fixture 源 ≠ 打开完成
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'tauri-ipc');
  });

  it('lr_h1_unbound_tauri_empty_success_honest_track', async () => {
    const wsId = 'ws-lr-h1-empty';
    const synthetic = syntheticStrictDocId(wsId);
    mockWorkspaceKey(wsId);
    const ipc = createMockNoteHydrateIpc();
    stubTauriHydrateIpc(synthetic, ipc);

    const { container } = renderH1NoteLeaf({ panelId: 'note', params: {} });

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'empty'
      );
    });
    expectNoProductCtaClickSurface();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute('data-strict-doc-id', synthetic);
    expect(host).toHaveAttribute('data-strict-doc-binding', 'synthetic-unbound');
    expectHonestyNails(host as HTMLElement);

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-doc-id', synthetic);
    expect(panel).toHaveAttribute('data-hydrate-status', 'empty');
    expect(panel).toHaveAttribute('data-block-count', '0');
    expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
    expect(screen.getByTestId('note-paper-strict-empty')).toBeInTheDocument();
  });

  it('lr_h1_unbound_no_tauri_still_fixture_not_tauri_ipc', async () => {
    const wsId = 'ws-lr-h1-fixture';
    mockWorkspaceKey(wsId);

    const { container } = renderH1NoteLeaf({ panelId: 'note', params: {} });
    const panel = await screen.findByTestId('note-paper-strict-panel');
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-hydrate-status', 'ready');
    });
    expectNoProductCtaClickSurface();

    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(host).toHaveAttribute(
      'data-strict-doc-id',
      syntheticStrictDocId(wsId)
    );
    expect(host).toHaveAttribute('data-strict-doc-binding', 'synthetic-unbound');
    expectHonestyNails(host as HTMLElement);

    expect(panel).toHaveAttribute('data-doc-id', syntheticStrictDocId(wsId));
    // 无 Tauri 仍 fixture，禁止伪装 ipc。fixture 源 ≠ 打开完成
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'tauri-ipc');
  });

  it('lr_h1_honesty_not_open_complete_not_el_01_04_08', () => {
    render(<WorkspaceEmptyState wsId="ws-lr-h1-honest" />);
    const landing = screen.getByRole('status');
    expectHonestyNails(landing);
    expect(landing).toHaveAttribute('data-product-paper-list', '0');
    expect(landing).toHaveAttribute(
      'data-strict-doc-binding',
      'synthetic-unbound'
    );

    const emptySrc = readWorkspaceSrc('WorkspaceEmptyState.tsx');
    expect(emptySrc).toMatch(/≠ 打开完成/);
    expect(emptySrc).toMatch(/≠ EL-01\/04\/08/);
    expect(emptySrc).toMatch(/enableProductPaperList\s*=\s*false/);
    // 无绑定回退不得删
    expect(emptySrc).toMatch(/strict-\$\{wsId\}/);

    const resolverSrc = readExt('productStrictDoc.ts');
    expect(resolverSrc).toMatch(/≠ 打开完成/);
    expect(resolverSrc).toMatch(/EL-01 \/ EL-04 \/ EL-08/);
    expect(resolverSrc).toMatch(/synthetic-unbound/);
  });

  it('lr_h1_c2_default_paper_list_still_false', () => {
    render(
      <WorkspaceEmptyState
        wsId="ws-lr-h1-c2"
        productStrictDocId="doc-bound-c2"
      />
    );
    const landing = screen.getByRole('status');
    expect(landing).toHaveAttribute('data-product-paper-list', '0');
    expect(landing).toHaveAttribute('data-strict-doc-id', 'doc-bound-c2');
    expect(screen.queryByTestId('note-paper-strict-panel')).toBeNull();
  });
});
