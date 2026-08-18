// @vitest-environment jsdom
/**
 * WorkspaceEmptyState · CONN-B / CONN-B3 slash 写锥
 *
 * 直渲 EmptyState + 点 `open-note-paper-strict` = **夹具路径**
 * （≠ 产品入口 ≠ G-HYD ≠ 打开完成）。
 * 产品默开在扩展叶（NoteLeafHost），见 conn_ext / c2-prod / e2-prime。
 *
 * 自 WorkspaceEmptyState.strict.test.tsx 按域拆出（SD-35）；断言语义不变。
 *
 * - **CONN-B**：无 applyOps 默认 slash 只读；注入 applyOps 后点 slash → wire/submit
 * - **CONN-B3**：显式 `strictApplyOpsIpc` mock → source=product-ipc + 点 slash 可写；
 *   无 Tauri 仍默认 readonly（禁止 mock 生产默认）；**≠ EL-01**
 *
 * 夹具测头见 WorkspaceEmptyState.strict.test.tsx。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BP_SLASH_ITEM, type ApplyOpsAdapter } from '@crish/block-paper';
import { createMockNoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

describe('WorkspaceEmptyState · CONN-B / CONN-B3 slash 写锥', () => {
  // -------------------------------------------------------------------------
  // CONN-B：夹具路径 slash 写锥（默认只读 / 注入可写）
  // -------------------------------------------------------------------------

  it('conn_b_product_empty_default_slash_readonly_no_silent_write', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-b-ro" />);
    // 空态根：无 apply → 只读诚实标注
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-write-mode',
      'readonly'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-sink-source',
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
    expect(panel).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(panel).toHaveAttribute('data-slash-sink-source', 'none');
    expect(panel).toHaveAttribute('data-slash-sink', '0');
    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-slash-write-mode',
      'readonly'
    );

    // 夹具面板打开 slash（/ 按钮）
    fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
    const overlay = await screen.findByTestId(
      'note-paper-strict-slash-overlay'
    );
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(
      screen.getByTestId('note-paper-strict-slash-overlay-readonly-banner')
    ).toBeInTheDocument();

    const item = overlay.querySelector(
      `[${BP_SLASH_ITEM}][data-item-id="paragraph"]`
    );
    expect(item).toBeTruthy();
    expect(item).toBeDisabled();
    fireEvent.click(item!);
    // 只读：菜单仍开、未假装 apply（无 sink 可录；断言项仍 disabled + overlay 仍在）
    expect(
      screen.getByTestId('note-paper-strict-slash-overlay')
    ).toBeInTheDocument();
    expect(item).toBeDisabled();
  });

  it('conn_b_product_empty_with_applyOps_slash_click_submits_intent', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-b-wr"
        strict={{
          strictApplyOps: applyOps,
          strictSlashWireOptions={{
            allocateId: () => 'empty-slash-new-blk',
            resolveOrder: () => 'a0',
          },
        }}
      />
    );

    // 空态根：有 apply → 可写标注
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-write-mode',
      'writable'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-sink-source',
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
    expect(panel).toHaveAttribute('data-slash-write-mode', 'writable');
    expect(panel).toHaveAttribute(
      'data-slash-sink-source',
      'injected-applyOps'
    );
    expect(panel).toHaveAttribute('data-slash-sink', '1');
    // hydrate 默认仍 fixture（未回退）
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');

    fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
    const overlay = await screen.findByTestId(
      'note-paper-strict-slash-overlay'
    );
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'writable');

    fireEvent.click(
      overlay.querySelector(`[${BP_SLASH_ITEM}][data-item-id="paragraph"]`)!
    );

    await waitFor(() => {
      expect(applied.length).toBeGreaterThanOrEqual(1);
    });
    expect(applied[0]).toContain('"op":"insert"');
    expect(applied[0]).toContain('empty-slash-new-blk');
    // 选中后关闭（submit 成功）
    await waitFor(() => {
      expect(
        screen.queryByTestId('note-paper-strict-slash-overlay')
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CONN-B3：note_apply_ops IPC 产品装配（mock 可测；无 Tauri 默认只读）
  // ≠ EL-01；禁止 mock 当生产默认
  // -------------------------------------------------------------------------

  it('conn_b3_product_empty_default_no_tauri_readonly_via_resolve', () => {
    // CONN-B3′：夹具 EmptyState 默认仍走 resolveProductStrictApplyOps({docId})；
    // ≠ 产品入口 / ≠ 打开完成。vitest/jsdom 无 Tauri → source=none → slash/mdPrefix 只读；禁止 mock 生产默认
    render(<WorkspaceEmptyState wsId="ws-conn-b3-ro" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(root).toHaveAttribute('data-slash-sink-source', 'none');
    expect(root).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(root).toHaveAttribute('data-md-prefix-sink-source', 'none');
    // 会计门：mirror 默认仍关（CONN-E2 不回潮）
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
  });

  it('conn_b3_product_empty_with_applyOpsIpc_slash_click_product_ipc', async () => {
    const mockIpc = createMockNoteApplyOpsIpc();
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-b3-ipc"
        strict={{
          strictApplyOpsIpc: mockIpc,
          strictSlashWireOptions={{
            allocateId: () => 'b3-slash-new-blk',
            resolveOrder: () => 'a0',
          }},
        }}
      />
    );

    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-write-mode',
      'writable'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-slash-sink-source',
      'product-ipc'
    );
    // 同 apply 驱动 mdPrefix
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-write-mode',
      'writable'
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-md-prefix-sink-source',
      'product-ipc'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-slash-write-mode', 'writable');
    expect(panel).toHaveAttribute('data-slash-sink-source', 'product-ipc');
    expect(panel).toHaveAttribute('data-slash-sink', '1');
    expect(panel).toHaveAttribute('data-md-prefix-sink-source', 'product-ipc');
    // hydrate 仍 fixture（未回退 / 未假关 EL）
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');

    fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
    const overlay = await screen.findByTestId(
      'note-paper-strict-slash-overlay'
    );
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'writable');

    fireEvent.click(
      overlay.querySelector(`[${BP_SLASH_ITEM}][data-item-id="paragraph"]`)!
    );

    await waitFor(() => {
      expect(mockIpc.calls.length).toBeGreaterThanOrEqual(1);
    });
    expect(mockIpc.calls[0]?.opsJson).toContain('"op":"insert"');
    expect(mockIpc.calls[0]?.opsJson).toContain('b3-slash-new-blk');
    expect(mockIpc.calls[0]?.docId).toBe('strict-ws-conn-b3-ipc');

    await waitFor(() => {
      expect(
        screen.queryByTestId('note-paper-strict-slash-overlay')
      ).toBeNull();
    });
  });
});
