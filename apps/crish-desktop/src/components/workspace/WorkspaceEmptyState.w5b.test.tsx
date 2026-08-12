// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · W5-B Strict 产品默认入口（可挂 Strict 面板）
 *
 * 完成定义（产品向至少 1 条）：
 * - 空态可点 Strict → NotePaperStrictPanel
 * - 无 Tauri（vitest/jsdom）默认 hydrate-source=fixture（**≠ 伪装 tauri-ipc**）
 * - 产品选型见 `createProductStrictHydrateTransport`（可检测 Tauri → tauri-ipc）
 * - DOM 诚实：package-id=W5-B / track=strict / source=hydrate
 * - 默认倾向 strict（W5B_PRODUCT_DEFAULT_EMPTY_TRACK）；Skeleton 双轨保留
 * - preferredNotePaperTrack 可切 skeleton 为主 CTA
 * - **CONN-A1**：mock/IPC 成功体可透传 `data-hydrate-path=doc-session`；
 *   **禁止** 该属性/文案宣称关 EL / 打开完成；fixture 不得伪装 tauri-ipc
 * - **可演示 ≠ EL**；**≠ 打开完成**；fixture ≠ 生产权威；
 *   后端默认 `hydrate_path=doc-session` 仍 **≠ EL-01/04/08**
 * - **≠ EL-01**；**≠ A-BLK-02/08 e2e 满关**；桌面接线 ≠ 打开完成
 *
 * SD-35 按 CONN 域拆分（断言语义不变；测名仍可 rg）：
 * - 本文件：产品默认入口 / CONN-A1 hydrate path 诚实
 * - WorkspaceEmptyState.conn-b3.test.tsx：CONN-B / CONN-B3 slash + applyOps IPC
 * - WorkspaceEmptyState.conn-d2.test.tsx：CONN-D2 / CONN-D3 mdPrefix
 * - WorkspaceEmptyState.conn-e2.test.tsx：CONN-E2 / CONN-E3 mirror
 * - WorkspaceEmptyState.conn-c2.test.tsx：CONN-C2 PaperList
 *
 * Skeleton 入口/测见 WorkspaceEmptyState.w5bs.test.tsx（必须仍绿）。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from '../note-paper/hydrateProjection';
import {
  W5B_PRODUCT_DEFAULT_EMPTY_TRACK,
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from '../note-paper/w5bStrict';
import {
  W5B_SKELETON_PACKAGE_ID,
  W5B_SKELETON_TRACK,
} from '../note-paper/w5bSkeleton';

describe('WorkspaceEmptyState · W5-B Strict 产品默认入口', () => {
  it('w5b_product_empty_opens_strict_panel_with_fixture_hydrate', async () => {
    render(<WorkspaceEmptyState wsId="ws-strict-1" />);

    // 产品默认倾向 Strict
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute(
      'data-preferred-note-paper-track',
      W5B_PRODUCT_DEFAULT_EMPTY_TRACK
    );
    expect(root).toHaveAttribute(
      'data-product-default-track',
      W5B_STRICT_TRACK
    );

    const openBtn = screen.getByTestId('open-note-paper-strict');
    expect(openBtn).toHaveAttribute('data-package-id', W5B_STRICT_PACKAGE_ID);
    expect(openBtn).toHaveAttribute('data-track', W5B_STRICT_TRACK);
    expect(openBtn.getAttribute('aria-label') ?? '').toMatch(
      /W5-B|Strict|可演示≠EL|≠打开完成/i
    );

    // Skeleton 入口仍在（双轨）
    expect(screen.getByTestId('open-note-paper-preview')).toBeInTheDocument();
    expect(screen.getByTestId('open-note-paper-preview')).toHaveAttribute(
      'data-package-id',
      W5B_SKELETON_PACKAGE_ID
    );

    fireEvent.click(openBtn);

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-note-paper-strict', 'true');
    expect(host).toHaveAttribute('data-package-id', W5B_STRICT_PACKAGE_ID);
    expect(host).toHaveAttribute('data-track', W5B_STRICT_TRACK);

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-package-id', W5B_STRICT_PACKAGE_ID);
    expect(panel).toHaveAttribute('data-track', W5B_STRICT_TRACK);
    expect(panel).toHaveAttribute('data-source', 'hydrate');
    // 诚实：vitest 无 Tauri → 产品默认回退 fixture，禁止伪装 tauri-ipc
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    // CONN-A1：fixture 无后端 path 标签，不得冒充 doc-session 数据面
    expect(panel).not.toHaveAttribute('data-hydrate-path');
    expect(panel).toHaveAttribute('data-doc-id', 'strict-ws-strict-1');
    expect(panel).toHaveAttribute('data-block-count', '3');
    // 不得冒充 Skeleton
    expect(panel).not.toHaveAttribute(
      'data-package-id',
      W5B_SKELETON_PACKAGE_ID
    );
    expect(panel.querySelector('[data-lines]')).toBeNull();

    // CONN-C · C-X2 / CONN-C2：空态产品默认 **不** 传 paperList → data-paper-list=0 钉死
    // （enableProductPaperList 默认 false；防默默改默认 true；≠ EL-01 / ≠ W3-P）
    expect(panel).toHaveAttribute('data-paper-list', '0');
    expect(panel).toHaveAttribute('data-presentation-mode', 'react-rows');
    expect(screen.queryByTestId('note-paper-strict-paper-list')).toBeNull();
    expect(panel.querySelector('[data-bp-paper-list-mount]')).toBeNull();

    const footer = screen.getByTestId('note-paper-strict-footer');
    expect(footer.textContent).toMatch(/可演示≠EL-01|≠EL-01/);
    expect(footer.textContent).toMatch(/W5-B/);
  });

  it('w5b_product_empty_strict_close_returns_to_empty', async () => {
    render(<WorkspaceEmptyState wsId="ws-close-strict" />);
    fireEvent.click(screen.getByTestId('open-note-paper-strict'));

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('note-paper-strict-close'));
    expect(screen.queryByTestId('note-paper-strict-panel')).toBeNull();
    expect(screen.getByTestId('open-note-paper-strict')).toBeInTheDocument();
    expect(screen.getByTestId('open-note-paper-preview')).toBeInTheDocument();
  });

  it('w5b_product_empty_accepts_injected_hydrate_transport', async () => {
    const transport = createFixtureHydrateTransport({
      'strict-ws-inject': {
        rev: 7,
        blocks: [
          makeHydratedBlock({
            id: 'inj-1',
            flavour: 'paragraph',
            text: 'injected hydrate',
            index: 0,
          }),
        ],
      },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-inject"
        strictHydrateTransport={transport}
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
    expect(panel).toHaveAttribute('data-rev', '7');
    expect(panel).toHaveAttribute('data-block-count', '1');
    expect(screen.getByText('injected hydrate')).toBeInTheDocument();
  });

  it('w5b_product_empty_accepts_tauri_ipc_product_transport_when_injected', async () => {
    // 模拟「可检测 Tauri」产品默认：source=tauri-ipc；≠ fixture 伪装
    // CONN-A1：mock 默认 hydrate_path=doc-session → DOM data-hydrate-path 可观测
    // **本测绿 ≠ 打开完成 / ≠ 关 EL-01/04/08**（仅分轨诚实）
    const { createMockNoteHydrateIpc } =
      await import('../../api/noteHydrateIpc');
    const { createProductStrictHydrateTransport } =
      await import('../note-paper/hydrateProjection');
    const ipc = createMockNoteHydrateIpc({
      'strict-ws-ipc': {
        rev: 3,
        blocks: [
          {
            id: 'ipc-b1',
            flavour: 'paragraph',
            index: 0,
            text: 'product tauri-ipc hydrate',
          },
        ],
      },
    });
    const transport = createProductStrictHydrateTransport('strict-ws-ipc', {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });

    render(
      <WorkspaceEmptyState wsId="ws-ipc" strictHydrateTransport={transport} />
    );
    fireEvent.click(screen.getByTestId('open-note-paper-strict'));

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-package-id', W5B_STRICT_PACKAGE_ID);
    // CONN-A1：path 可观测；禁止把本属性当 EL/打开完成证据
    expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
    expect(screen.getByText('product tauri-ipc hydrate')).toBeInTheDocument();
  });

  it('w5b_product_empty_preferred_skeleton_still_keeps_strict_entry', () => {
    render(
      <WorkspaceEmptyState
        wsId="ws-pref-skel"
        preferredNotePaperTrack="skeleton"
      />
    );
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute(
      'data-preferred-note-paper-track',
      W5B_SKELETON_TRACK
    );
    // 常量产品默认仍是 strict（prop 只改倾向，不改常量）
    expect(root).toHaveAttribute(
      'data-product-default-track',
      W5B_PRODUCT_DEFAULT_EMPTY_TRACK
    );
    expect(screen.getByTestId('open-note-paper-strict')).toBeInTheDocument();
    expect(screen.getByTestId('open-note-paper-preview')).toBeInTheDocument();
  });
});
