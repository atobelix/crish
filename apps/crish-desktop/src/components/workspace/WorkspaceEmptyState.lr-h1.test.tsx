// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · LR-H1 产品打开绑定已 persist 文档
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
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockNoteHydrateIpc } from '../../api/noteHydrateIpc';
import { createProductStrictHydrateTransport } from '../note-paper/hydrateProjection';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  bindWorkspacePersistedStrictDoc,
  resetWorkspacePersistedStrictDocBindings,
  syntheticStrictDocId,
} from './workspaceEmptyStateStrictDoc';

const DIR =
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? dirname(fileURLToPath(import.meta.url))
    : join(process.cwd(), 'apps/crish-desktop/src/components/workspace');

function readWorkspaceSrc(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

describe('WorkspaceEmptyState · LR-H1 persist doc 绑定', () => {
  afterEach(() => {
    resetWorkspacePersistedStrictDocBindings();
  });

  it('lr_h1_bound_open_uses_persisted_doc_id_not_dead_synthetic', async () => {
    const wsId = 'ws-lr-h1-bound';
    const persistedId = 'doc-persisted-after-commit';
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
    const transport = createProductStrictHydrateTransport(persistedId, {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });

    render(
      <WorkspaceEmptyState
        wsId={wsId}
        productStrictDocId={persistedId}
        strictHydrateTransport={transport}
      />
    );

    const landing = screen.getByRole('status');
    expect(landing).toHaveAttribute('data-strict-doc-id', persistedId);
    expect(landing).toHaveAttribute('data-strict-doc-binding', 'explicit-prop');
    expect(landing).toHaveAttribute(
      'data-synthetic-strict-doc-id',
      syntheticStrictDocId(wsId)
    );
    expect(landing.getAttribute('data-strict-doc-id')).not.toBe(
      landing.getAttribute('data-synthetic-strict-doc-id')
    );
    expectHonestyNails(landing);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-strict-doc-id', persistedId);
    expect(host).toHaveAttribute('data-strict-doc-binding', 'explicit-prop');
    expectHonestyNails(host);

    const panel = screen.getByTestId('note-paper-strict-panel');
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
    bindWorkspacePersistedStrictDoc(wsId, boundId);

    render(<WorkspaceEmptyState wsId={wsId} />);

    const landing = screen.getByRole('status');
    expect(landing).toHaveAttribute('data-strict-doc-id', boundId);
    expect(landing).toHaveAttribute('data-strict-doc-binding', 'pre-open-bind');
    expect(landing.getAttribute('data-strict-doc-id')).not.toBe(
      syntheticStrictDocId(wsId)
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-doc-id', boundId);
    expect(panel).not.toHaveAttribute(
      'data-doc-id',
      syntheticStrictDocId(wsId)
    );
    // 无 Tauri：分轨仍 fixture，禁止改成 tauri-ipc
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expectHonestyNails(screen.getByTestId('note-paper-strict-host'));
  });

  it('lr_h1_unbound_tauri_empty_success_honest_track', async () => {
    const wsId = 'ws-lr-h1-empty';
    const synthetic = syntheticStrictDocId(wsId);
    const ipc = createMockNoteHydrateIpc();
    const transport = createProductStrictHydrateTransport(synthetic, {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });

    render(
      <WorkspaceEmptyState wsId={wsId} strictHydrateTransport={transport} />
    );

    const landing = screen.getByRole('status');
    expect(landing).toHaveAttribute('data-strict-doc-id', synthetic);
    expect(landing).toHaveAttribute(
      'data-strict-doc-binding',
      'synthetic-unbound'
    );
    expectHonestyNails(landing);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'empty'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-doc-id', synthetic);
    expect(panel).toHaveAttribute('data-hydrate-status', 'empty');
    expect(panel).toHaveAttribute('data-block-count', '0');
    expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
    expect(screen.getByTestId('note-paper-strict-empty')).toBeInTheDocument();
    expectHonestyNails(screen.getByTestId('note-paper-strict-host'));
  });

  it('lr_h1_unbound_no_tauri_still_fixture_not_tauri_ipc', async () => {
    const wsId = 'ws-lr-h1-fixture';
    render(<WorkspaceEmptyState wsId={wsId} />);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-doc-id', syntheticStrictDocId(wsId));
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-strict-doc-binding',
      'synthetic-unbound'
    );
    expectHonestyNails(screen.getByTestId('note-paper-strict-host'));
  });

  it('lr_h1_honesty_not_open_complete_not_el_01_04_08', () => {
    render(<WorkspaceEmptyState wsId="ws-lr-h1-honest" />);
    const landing = screen.getByRole('status');
    expectHonestyNails(landing);
    expect(landing).toHaveAttribute('data-product-paper-list', '0');

    const emptySrc = readWorkspaceSrc('WorkspaceEmptyState.tsx');
    expect(emptySrc).toMatch(/≠ 打开完成/);
    expect(emptySrc).toMatch(/≠ EL-01\/04\/08/);
    expect(emptySrc).toMatch(/enableProductPaperList\s*=\s*false/);
    // 无绑定回退不得删
    expect(emptySrc).toMatch(/strict-\$\{wsId\}/);

    const resolverSrc = readWorkspaceSrc('workspaceEmptyStateStrictDoc.ts');
    expect(resolverSrc).toMatch(/≠ 打开完成/);
    expect(resolverSrc).toMatch(/EL-01 \/ EL-04 \/ EL-08/);
    expect(resolverSrc).toMatch(/synthetic-unbound/);
  });

  it('lr_h1_c2_default_paper_list_still_false', async () => {
    render(
      <WorkspaceEmptyState
        wsId="ws-lr-h1-c2"
        productStrictDocId="doc-bound-c2"
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-product-paper-list',
      '0'
    );
    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-product-paper-list',
      '0'
    );
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-paper-list',
      '0'
    );
  });
});

function expectHonestyNails(el: HTMLElement): void {
  expect(el).toHaveAttribute('data-el01', 'not-claimed');
  expect(el).toHaveAttribute('data-el04', 'not-claimed');
  expect(el).toHaveAttribute('data-el08', 'not-claimed');
  expect(el).toHaveAttribute('data-open-complete', 'not-claimed');
}
