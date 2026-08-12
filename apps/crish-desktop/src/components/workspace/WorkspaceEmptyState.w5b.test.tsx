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
 * - **CONN-B**：无 applyOps 默认 slash 只读；注入 applyOps 后点 slash → wire/submit
 * - **CONN-B3**：显式 `strictApplyOpsIpc` mock → source=product-ipc + 点 slash 可写；
 *   无 Tauri 仍默认 readonly（禁止 mock 生产默认）；**≠ EL-01**
 * - **CONN-D2/D3**：无 applyOps 默认 mdPrefix disabled；注入后 `data-md-prefix-write-mode=writable`
 *   + content-row 叶 `data-md-prefix-leaf-mode=writable`（叶键入见 StrictContentRowLeaf 测）；
 *   **≠ A-BLK-08/09 e2e**
 * - **CONN-A1**：mock/IPC 成功体可透传 `data-hydrate-path=doc-session`；
 *   **禁止** 该属性/文案宣称关 EL / 打开完成；fixture 不得伪装 tauri-ipc
 * - **CONN-E2**：mirror StatusBar 默认关；`showMirrorDriftBar` / `mirrorDriftReport`
 *   opt-in 才挂；注入 report → 三路可测；`mirrorIpc` → accept 走 import（X-05）；
 *   **≠ EL-03**；**≠ inotify 满关**；无 report 不造假
 * - **CONN-E3**：detect→report 调度默认关；`enableMirrorDetectSchedule` + `mirrorIpc`
 *   → mock/Tauri detect → report 喂 StatusBar；`data-mirror-detect-schedule=0|1`；
 *   关时无 detect 定时器；X-05 / import 不回退；**≠ EL-03**；**≠ inotify 满关**
 * - **CONN-C2**：PaperList 产品默认 **关**（`enableProductPaperList` 默认 false →
 *   `data-product-paper-list=0` / panel `data-paper-list=0` / `react-rows`）；
 *   opt-in true → 挂 PaperList + `paper-list` 互斥 content-row；
 *   测钉 `conn_c2_default_no_paper_list` / `conn_c2_opt_in_paper_list_mutex`；
 *   **≠ EL-01**；**≠ W3-P 满窗**；禁默认真双内容
 * - **可演示 ≠ EL**；**≠ 打开完成**；fixture ≠ 生产权威；
 *   后端默认 `hydrate_path=doc-session` 仍 **≠ EL-01/04/08**
 * - **≠ EL-01**；**≠ A-BLK-02/08 e2e 满关**；桌面接线 ≠ 打开完成
 *
 * Skeleton 入口/测见 WorkspaceEmptyState.w5bs.test.tsx（必须仍绿）。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BP_SLASH_ITEM, type ApplyOpsAdapter } from '@crish/block-paper';
import { createMockNoteApplyOpsIpc } from '../../api/noteApplyOpsIpc';
import { createMockNoteMirrorIpc } from '../../api/noteMirrorIpc';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from '../note-paper/hydrateProjection';
import {
  makeMirrorDriftReportView,
  type ThreeWayDecision,
} from '../note-paper/mirrorDriftUi';
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

  // -------------------------------------------------------------------------
  // CONN-B：产品空态 slash 写锥（默认只读 / 注入可写）
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

    // 产品路径打开 slash（/ 按钮）
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
        strictApplyOps={applyOps}
        strictSlashWireOptions={{
          allocateId: () => 'empty-slash-new-blk',
          resolveOrder: () => 'a0',
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
    // CONN-B3′：产品入口默认 resolveProductStrictApplyOps({docId})；
    // vitest/jsdom 无 Tauri → source=none → slash/mdPrefix 只读；禁止 mock 生产默认
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
        strictApplyOpsIpc={mockIpc}
        strictSlashWireOptions={{
          allocateId: () => 'b3-slash-new-blk',
          resolveOrder: () => 'a0',
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
      <WorkspaceEmptyState wsId="ws-conn-d2-wr" strictApplyOps={applyOps} />
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
      <WorkspaceEmptyState wsId="ws-conn-d3-leaf" strictApplyOps={applyOps} />
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

  // -------------------------------------------------------------------------
  // CONN-E2：产品空态 mirror StatusBar opt-in 装配
  // 默认关；注入 report → 可见 + 三路可测；mirrorIpc → import；X-05 不回退
  // ≠ EL-03；≠ inotify 满关；无 report 不造假
  // -------------------------------------------------------------------------

  it('conn_e2_product_empty_default_no_mirror_status_bar', async () => {
    render(<WorkspaceEmptyState wsId="ws-conn-e2-off" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-mirror-drift-bar',
      '0'
    );
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    // hydrate 锚不回退
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'fixture'
    );
  });

  it('conn_e2_product_empty_showMirrorDriftBar_idle_no_fake_report', async () => {
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-idle"
        showMirrorDriftBar
        mirrorWatchSource="poll"
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-mirror-drift-bar',
      '1'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'idle');
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-class')).toHaveTextContent(
      '未检测'
    );
    // 无 report → 无三路（不假装已 detect）
    expect(screen.queryByTestId('mirror-drift-three-way')).toBeNull();
  });

  it('conn_e2_product_empty_injected_report_shows_bar_and_three_way', async () => {
    const seen: ThreeWayDecision[] = [];
    const docId = 'strict-ws-conn-e2-rpt';
    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-rpt"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId,
          class: 'mirror_only',
          pendingLag: 2,
        })}
        mirrorWatchSource="injected"
        mirrorUnpushedOpCount={0}
        onMirrorThreeWay={(d) => {
          seen.push(d);
        }}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-mirror-drift-bar',
      '1'
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    expect(bar).toHaveAttribute('data-watch-source', 'injected');
    expect(bar).toHaveAttribute('data-three-way', 'true');
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=2');

    fireEvent.click(screen.getByTestId('mirror-drift-keep-doc'));
    expect(seen).toHaveLength(1);
    expect(seen[0].ok).toBe(true);
    if (seen[0].ok) {
      expect(seen[0].action).toBe('keep_doc');
      expect(seen[0].callsImport).toBe(false);
    }

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(seen).toHaveLength(2);
    expect(seen[1].ok).toBe(true);
    if (seen[1].ok) {
      expect(seen[1].strategy).toBe('retain_local_and_reimport');
      expect(seen[1].discardsUnpushed).toBe(false);
    }

    fireEvent.click(screen.getByTestId('mirror-drift-mark-conflict'));
    expect(seen).toHaveLength(3);
    expect(seen[2].ok).toBe(true);
    if (seen[2].ok) {
      expect(seen[2].strategy).toBe('conflict_blocks');
    }
  });

  it('conn_e2_product_empty_mirrorIpc_accept_imports_and_x05_blocks', async () => {
    const docId = 'strict-ws-conn-e2-ipc';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'mirror_only' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ipc"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId,
          class: 'mirror_only',
        })}
        mirrorWatchSource="injected"
        mirrorUnpushedOpCount={2}
        mirrorIpc={ipc}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-status-bar')).toBeInTheDocument();
    });

    // X-05：unpushed>0 无确认 → 不 import
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-gate')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mirror-drift-gate')).toHaveTextContent(
      /unpushed|拒绝静默/
    );
    expect(ipc.importCalls).toHaveLength(0);

    // 勾选确认后 → drop_unacked 调 mock IPC
    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('drop_unacked');
    expect(ipc.importCalls[0]?.docId).toBe(docId);
    expect(ipc.importCalls[0]?.unpushedOpCount).toBe(2);

    // 诚实锚仍在
    const bar = screen.getByTestId('mirror-drift-status-bar');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
  });

  it('conn_e2_product_empty_onMirrorThreeWay_overrides_mirrorIpc', async () => {
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e2-ov': { class: 'both' },
    });
    const onAction = vi.fn();

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e2-ov"
        mirrorDriftReport={makeMirrorDriftReportView({
          docId: 'strict-ws-conn-e2-ov',
          class: 'both',
        })}
        mirrorUnpushedOpCount={0}
        mirrorIpc={ipc}
        onMirrorThreeWay={onAction}
      />
    );

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    expect(onAction).toHaveBeenCalledTimes(1);
    // 显式 onMirrorThreeWay 优先 → 不经 bridge 调 IPC
    expect(ipc.importCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // CONN-E3：产品 detect→report 调度（opt-in）
  // 默认不调度；enable + mirrorIpc → detect → report 可达 StatusBar
  // ≠ EL-03；≠ inotify 满关；X-05 / import 不回退
  // -------------------------------------------------------------------------

  it('conn_e3_product_empty_default_no_detect_schedule', async () => {
    const ipc = createMockNoteMirrorIpc({
      'strict-ws-conn-e3-off': { class: 'mirror_only' },
    });

    render(<WorkspaceEmptyState wsId="ws-conn-e3-off" mirrorIpc={ipc} />);

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // 仅有 mirrorIpc、未 enable 调度 → 零 detect
    expect(ipc.detectCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    expect(screen.getByTestId('note-paper-strict-host')).toHaveAttribute(
      'data-mirror-detect-schedule',
      '0'
    );
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
    expect(ipc.detectCalls).toHaveLength(0);
  });

  it('conn_e3_product_empty_opt_in_detect_fills_report_and_bar', async () => {
    const docId = 'strict-ws-conn-e3-on';
    const ipc = createMockNoteMirrorIpc({
      [docId]: {
        class: 'mirror_only',
        path: '/tmp/e3.md',
        pendingLag: 3,
      },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e3-on"
        mirrorIpc={ipc}
        enableMirrorDetectSchedule
        mirrorUnpushedOpCount={0}
      />
    );

    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '1');
    // 调度激活 → 条可挂（idle 或 report）
    expect(root).toHaveAttribute('data-mirror-drift-bar', '1');
    expect(root).toHaveAttribute('data-el03', 'not-claimed');
    expect(root).toHaveAttribute('data-inotify-full', 'not-claimed');

    // opt-in → mock detect 被调
    await waitFor(() => {
      expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(ipc.detectCalls[0]?.docId).toBe(docId);

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-status-bar')).toBeInTheDocument();
    });

    const host = screen.getByTestId('note-paper-strict-host');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '1');
    expect(host).toHaveAttribute('data-mirror-drift-bar', '1');

    const bar = screen.getByTestId('mirror-drift-status-bar');
    await waitFor(() => {
      expect(bar).toHaveAttribute('data-drift-class', 'mirror_only');
    });
    expect(bar).toHaveAttribute('data-watch-source', 'poll');
    expect(bar).toHaveAttribute('data-three-way', 'true');
    expect(bar).toHaveAttribute('data-el03', 'not-claimed');
    expect(bar).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.getByTestId('mirror-drift-lag')).toHaveTextContent('lag=3');

    // accept → import（E2 桥不回退；X-05 unpushed=0）
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('retain_local_and_reimport');
    expect(ipc.importCalls[0]?.docId).toBe(docId);
    expect(ipc.importCalls[0]?.unpushedOpCount).toBe(0);
  });

  it('conn_e3_product_empty_enable_without_ipc_no_detect', async () => {
    // enable 但无 ipc → scheduleActive=false；不假装已调度
    render(
      <WorkspaceEmptyState wsId="ws-conn-e3-noipc" enableMirrorDetectSchedule />
    );
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-drift-bar', '0');
  });

  it('conn_e3_product_empty_opt_in_x05_still_blocks_silent_drop', async () => {
    const docId = 'strict-ws-conn-e3-x05';
    const ipc = createMockNoteMirrorIpc({
      [docId]: { class: 'both' },
    });

    render(
      <WorkspaceEmptyState
        wsId="ws-conn-e3-x05"
        mirrorIpc={ipc}
        enableMirrorDetectSchedule
        mirrorUnpushedOpCount={2}
      />
    );

    await waitFor(() => {
      expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-accept')).toBeInTheDocument();
    });

    // X-05：unpushed>0 无确认 → 不 import
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('mirror-drift-gate')).toBeInTheDocument();
    });
    expect(ipc.importCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('mirror-drift-confirm-discard-input'));
    fireEvent.click(screen.getByTestId('mirror-drift-accept'));
    await waitFor(() => {
      expect(ipc.importCalls.length).toBe(1);
    });
    expect(ipc.importCalls[0]?.strategy).toBe('drop_unacked');
  });

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
