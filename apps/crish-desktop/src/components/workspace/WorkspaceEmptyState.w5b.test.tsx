// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · W5-B Strict 产品默认入口（可挂 Strict 面板）
 *
 * 完成定义（产品向至少 1 条）：
 * - 空态可点 Strict → NotePaperStrictPanel（fixture hydrate）
 * - DOM 诚实：package-id=W5-B / track=strict / source=hydrate / hydrate-source=fixture
 * - 默认倾向 strict（W5B_PRODUCT_DEFAULT_EMPTY_TRACK）
 * - preferredNotePaperTrack 可切 skeleton 为主 CTA
 * - **可演示 ≠ EL**；**≠ 打开完成**；fixture ≠ DocSession IPC
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
    // 诚实：空态默认 fixture，非伪装 tauri-ipc
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-doc-id', 'strict-ws-strict-1');
    expect(panel).toHaveAttribute('data-block-count', '3');
    // 不得冒充 Skeleton
    expect(panel).not.toHaveAttribute(
      'data-package-id',
      W5B_SKELETON_PACKAGE_ID
    );
    expect(panel.querySelector('[data-lines]')).toBeNull();

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
