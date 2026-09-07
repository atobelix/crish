// @vitest-environment jsdom
/**
 * NotePaperStrictPanel 单测（**W5-B Strict** · B-09 真数据投影轨）
 *
 * 轨：Strict；与 W5-B-S Skeleton **分轨并存**。
 * 测名 w5b_strict_*。
 *
 * 诚实边界：本测绿 ≠ EL-01/EL-08 关闭；≠ 打开完成；≠ W5-C 隔离全关。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SlashMenuModel, type SlashOpenResult } from '@crish/block-paper';
import { createMemoryNoteTransport } from '../../api/noteApi';
import {
  adaptNoteTransportAsHydrate,
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import { isUuidV4 } from './noteBlockId';
import { EDITOR_SURFACE_NOTE_PAPER } from './editorSurface';
import {
  W5B_STRICT_PACKAGE_ID,
  W5B_STRICT_TRACK,
} from './notePaperStrictTrack';

describe('NotePaperStrictPanel · W5-B Strict · w5b_strict_panel', () => {
  it('w5b_strict_panel_anchors_package_and_track', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-strict': {
        rev: 2,
        blocks: [
          makeHydratedBlock({
            id: 'b1',
            flavour: 'paragraph',
            text: 'hydrated text',
            index: 0,
          }),
        ],
      },
    });
    render(
      <NotePaperStrictPanel docId="doc-strict" hydrateTransport={transport} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-surface', EDITOR_SURFACE_NOTE_PAPER);
    expect(panel).toHaveAttribute('data-leaf-view-root', '1');
    expect(panel).toHaveAttribute('data-package-id', W5B_STRICT_PACKAGE_ID);
    expect(panel).toHaveAttribute('data-track', W5B_STRICT_TRACK);
    // 不得冒充 Skeleton 包 ID
    expect(panel).not.toHaveAttribute('data-package-id', 'W5-B-S');
    expect(panel).toHaveAttribute('data-source', 'hydrate');
    expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    expect(panel).toHaveAttribute('data-doc-id', 'doc-strict');
    expect(panel).toHaveAttribute('data-block-count', '1');
    expect(screen.getByText('hydrated text')).toBeInTheDocument();
  });

  it('w5b_strict_panel_leaf_view_root_is_single_section', async () => {
    // 05-A：section 根带 data-leaf-view-root；禁止 Fragment 多根。
    // 本测绿 ≠ 皮像素已交付 ≠ 打开完成。
    const transport = createFixtureHydrateTransport({
      'doc-leaf-root': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'lr1',
            flavour: 'paragraph',
            text: 'leaf view root',
            index: 0,
          }),
        ],
      },
    });
    const { container } = render(
      <NotePaperStrictPanel
        docId="doc-leaf-root"
        hydrateTransport={transport}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const roots = screen.getAllByTestId('note-paper-strict-panel');
    expect(roots).toHaveLength(1);
    const panel = roots[0];
    expect(panel).toHaveAttribute('data-leaf-view-root', '1');
    expect(panel.tagName).toBe('SECTION');
    const elementChildren = Array.from(container.children);
    expect(elementChildren).toHaveLength(1);
    expect(elementChildren[0]).toBe(panel);
  });

  it('w5b_strict_panel_does_not_render_conex_float_handle', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-no-float': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'nf1',
            flavour: 'paragraph',
            text: 'no third handle',
            index: 0,
          }),
        ],
      },
    });
    render(
      <NotePaperStrictPanel
        docId="doc-no-float"
        hydrateTransport={transport}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    expect(
      screen.queryByTestId('conex-float-handle-singleton')
    ).not.toBeInTheDocument();
  });

  it('w5b_strict_loading_state_visible_before_resolve', async () => {
    const transport = createFixtureHydrateTransport({
      slow: {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 's1',
            flavour: 'paragraph',
            text: 'late',
            index: 0,
          }),
        ],
      },
    });
    transport.setDelayMs(40);

    render(<NotePaperStrictPanel docId="slow" hydrateTransport={transport} />);

    // 加载中 UI
    expect(screen.getByTestId('note-paper-strict-loading')).toBeInTheDocument();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'loading'
    );
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-transport-loading',
      'true'
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    expect(screen.queryByTestId('note-paper-strict-loading')).toBeNull();
    expect(screen.getByText('late')).toBeInTheDocument();
  });

  it('w5b_strict_empty_state_after_successful_hydrate', async () => {
    const transport = createFixtureHydrateTransport();
    // 未 seed → 空成功投影
    render(
      <NotePaperStrictPanel docId="empty-doc" hydrateTransport={transport} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-empty')).toBeInTheDocument();
    });
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-hydrate-status', 'empty');
    expect(panel).toHaveAttribute('data-block-count', '0');
    expect(screen.getByTestId('note-paper-strict-empty').textContent).toMatch(
      /空文档投影/
    );
  });

  it('w5b_strict_error_state_on_hydrate_failure', async () => {
    const transport = createFixtureHydrateTransport();
    transport.setNextError({
      code: 'note.hydrate_failed',
      reason: '结构 encode 不可逆（演示错误态）',
    });

    render(<NotePaperStrictPanel docId="bad" hydrateTransport={transport} />);

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-error')).toBeInTheDocument();
    });
    const err = screen.getByTestId('note-paper-strict-error');
    expect(err).toHaveAttribute('data-error-code', 'note.hydrate_failed');
    expect(err.textContent).toMatch(/结构 encode/);
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'error'
    );
    expect(screen.queryByTestId('note-paper-strict-empty')).toBeNull();
  });

  it('w5b_strict_refresh_reloads_projection', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-r': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'a',
            flavour: 'paragraph',
            text: 'v1',
            index: 0,
          }),
        ],
      },
    });
    const { rerender } = render(
      <NotePaperStrictPanel
        docId="doc-r"
        hydrateTransport={transport}
        refreshToken={0}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('v1')).toBeInTheDocument();
    });

    transport.seed('doc-r', {
      rev: 2,
      blocks: [
        makeHydratedBlock({
          id: 'a',
          flavour: 'paragraph',
          text: 'v2 after refresh',
          index: 0,
        }),
        makeHydratedBlock({
          id: 'b',
          flavour: 'paragraph',
          text: 'second',
          index: 1,
        }),
      ],
    });

    rerender(
      <NotePaperStrictPanel
        docId="doc-r"
        hydrateTransport={transport}
        refreshToken={1}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('v2 after refresh')).toBeInTheDocument();
    });
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-block-count',
      '2'
    );
    expect(screen.getByTestId('note-paper-strict-count').textContent).toMatch(
      /4/
    );
  });

  it('w5b_strict_refresh_button_triggers_reload', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-btn': {
        rev: 1,
        blocks: [],
      },
    });
    render(
      <NotePaperStrictPanel docId="doc-btn" hydrateTransport={transport} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-empty')).toBeInTheDocument();
    });

    transport.seed('doc-btn', {
      rev: 4,
      blocks: [
        makeHydratedBlock({
          id: 'n1',
          flavour: 'heading',
          text: 'After click',
          index: 0,
          props: { level: 2 },
        }),
      ],
    });
    fireEvent.click(screen.getByTestId('note-paper-strict-refresh'));

    await waitFor(() => {
      expect(screen.getByText('After click')).toBeInTheDocument();
    });
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-rev',
      '4'
    );
  });

  it('w5b_strict_adapt_note_transport_success_path', async () => {
    const mem = createMemoryNoteTransport();
    await mem.applyMd({
      docId: 'doc-mem',
      markdown: '# From NoteTransport\n\nbody',
      intentId: 'strict-mem-1',
    });
    const hydrate = adaptNoteTransportAsHydrate(mem);

    render(
      <NotePaperStrictPanel
        docId="doc-mem"
        hydrateTransport={hydrate}
        title="Strict via NoteTransport"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'note-transport'
    );
    expect(screen.getByText('From NoteTransport')).toBeInTheDocument();
    // 无行级权威
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel.querySelector('[data-lines]')).toBeNull();
    expect(panel.querySelector('[data-editor-store]')).toBeNull();
  });

  it('w5b_strict_root_declares_demo_neq_EL_boundary_without_footer', async () => {
    const transport = createFixtureHydrateTransport({
      d: {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'x',
            flavour: 'paragraph',
            text: 't',
            index: 0,
          }),
        ],
      },
    });
    render(<NotePaperStrictPanel docId="d" hydrateTransport={transport} />);

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toBeInTheDocument();
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-package-id', 'W5-B');
    expect(panel).toHaveAttribute('data-track', 'strict');

    const boundary = panel.getAttribute('data-boundary') ?? '';
    expect(boundary).toMatch(/W5-B/);
    expect(boundary).toMatch(/Strict/i);
    expect(boundary).toMatch(/可演示≠EL-01|≠EL-01/);
    expect(boundary).toMatch(/EL-08|S5|W5-C/);
    expect(panel).toHaveAttribute('data-surface', 'note-paper');

    // 刚性防回潮断言：灰底 footer 与 mirrorDriftBar 零渲染
    expect(screen.queryByTestId('note-paper-strict-footer')).toBeNull();
    expect(screen.queryByTestId('mirror-drift-bar')).toBeNull();
  });

  it('conn_a1_strict_dom_exposes_hydrate_path_from_mock_ipc', async () => {
    // CONN-A1：mock 成功体默认 path=doc-session → data-hydrate-path 可观测
    // **本测绿 ≠ 打开完成 / ≠ 关 EL-01/04/08**；fixture 不得伪装 tauri-ipc
    const { createMockNoteHydrateIpc } =
      await import('../../api/noteHydrateIpc');
    const { adaptNoteHydrateIpcAsTransport } =
      await import('./hydrateProjection');
    const ipc = createMockNoteHydrateIpc({
      'doc-conn-a1': {
        rev: 4,
        blocks: [
          {
            id: 'a1-b',
            flavour: 'paragraph',
            index: 0,
            text: 'conn-a1 path label',
          },
        ],
      },
    });
    const transport = adaptNoteHydrateIpcAsTransport(ipc);
    render(
      <NotePaperStrictPanel docId="doc-conn-a1" hydrateTransport={transport} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-hydrate-source', 'tauri-ipc');
    expect(panel).toHaveAttribute('data-hydrate-path', 'doc-session');
    expect(panel).not.toHaveAttribute('data-hydrate-source', 'fixture');
    expect(screen.getByText('conn-a1 path label')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // CONN-B2：产品 `/` / openSlash 打开路径（≠ EL-01）
  // -------------------------------------------------------------------------

  it('conn_b2_strict_slash_button_and_key_open_readonly_catalog', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-b2': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'b2-blk',
            flavour: 'paragraph',
            text: 'slash open path',
            index: 0,
          }),
        ],
      },
    });
    const results: SlashOpenResult[] = [];
    render(
      <NotePaperStrictPanel
        docId="doc-b2"
        hydrateTransport={transport}
        onSlashOpenResult={(r) => results.push(r)}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-slash-open-path', 'product');
    expect(panel).toHaveAttribute('data-slash-write-mode', 'readonly');
    // DomHost 防双浮层（产品挂载）
    expect(
      panel.querySelector('[data-testid="note-paper-strict-chrome-dom"]')
    ).toBeTruthy();

    // 显式 trigger 按钮
    const trigger = screen.getByTestId('note-paper-strict-open-slash');
    expect(trigger).toHaveAttribute('data-slash-open-trigger', '1');
    fireEvent.click(trigger);

    const overlay = await screen.findByTestId(
      'note-paper-strict-slash-overlay'
    );
    expect(overlay).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(overlay).toHaveAttribute('data-block-id', 'b2-blk');
    expect(results.some((r) => r.ok)).toBe(true);

    // Escape 关后 `/` 键再开
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByTestId('note-paper-strict-slash-overlay')
      ).toBeNull();
    });

    panel.focus();
    fireEvent.keyDown(panel, { key: '/', code: 'Slash' });
    await waitFor(() => {
      expect(
        screen.getByTestId('note-paper-strict-slash-overlay')
      ).toBeInTheDocument();
    });
  });

  it('conn_b2_strict_composing_rejects_open_via_injected_menu', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-b2c': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'c-blk',
            flavour: 'paragraph',
            text: 'composing',
            index: 0,
          }),
        ],
      },
    });
    let composing = true;
    const menu = new SlashMenuModel({ isComposing: () => composing });
    const results: SlashOpenResult[] = [];
    render(
      <NotePaperStrictPanel
        docId="doc-b2c"
        hydrateTransport={transport}
        slashMenu={menu}
        onSlashOpenResult={(r) => results.push(r)}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
    expect(menu.isOpen()).toBe(false);
    expect(results.some((r) => !r.ok && r.code === 'composing')).toBe(true);
    expect(screen.queryByTestId('note-paper-strict-slash-overlay')).toBeNull();

    composing = false;
    fireEvent.click(screen.getByTestId('note-paper-strict-open-slash'));
    expect(
      await screen.findByTestId('note-paper-strict-slash-overlay')
    ).toBeInTheDocument();
    expect(menu.getSnapshot().blockId).toBe('c-blk');
  });

  // -------------------------------------------------------------------------
  // 正文直接修改持久化写盘与顶栏状态同步契约
  // -------------------------------------------------------------------------

  it('strict_text_edit_persistence_and_save_status_lifecycle', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-persist-test': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'b-edit-1',
            flavour: 'paragraph',
            text: '初始正文',
            index: 0,
          }),
        ],
      },
    });

    const recordedOps: string[] = [];
    const applyOpsMock = vi.fn(async (opsJson: string) => {
      recordedOps.push(opsJson);
      return { ok: true };
    });

    render(
      <NotePaperStrictPanel
        docId="doc-persist-test"
        hydrateTransport={transport}
        paperList={true}
        applyOps={applyOpsMock}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-save-status', 'saved');
    const saveStatusBadge = screen.getByTestId('note-paper-strict-save-status');
    expect(saveStatusBadge).toHaveAttribute('data-save-status', 'saved');

    // 找到挂载在 PaperList 上的正文块 DOM
    const blockEl = panel.querySelector('[data-block-id="b-edit-1"]') as HTMLElement;
    expect(blockEl).toBeTruthy();
    expect(blockEl.textContent).toBe('初始正文');

    // 模拟用户在正文块内输入并触发 blur / commit
    blockEl.textContent = '修改后的正文内容';
    fireEvent.input(blockEl);
    fireEvent.blur(blockEl);

    // 断言 applyOps 真实接收到 text_edit collab op
    await waitFor(() => {
      expect(applyOpsMock).toHaveBeenCalled();
    });

    const parsedOp = JSON.parse(recordedOps[0]);
    expect(parsedOp).toEqual([
      expect.objectContaining({
        op: 'text_edit',
        id: 'b-edit-1',
        start: 0,
        end: 4, // '初始正文' length
        insert: '修改后的正文内容',
      }),
    ]);

    // 最终状态必须为 saved
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-save-status', 'saved');
      expect(saveStatusBadge).toHaveAttribute('data-save-status', 'saved');
    });
  });

  it('strict_rename_title_triggers_saving_to_saved_transition', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-rename-test': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'b-rename-1',
            flavour: 'paragraph',
            text: '正文',
            index: 0,
          }),
        ],
      },
    });

    let savedTitle = '';
    const onRenameTitle = vi.fn(async (newTitle: string) => {
      savedTitle = newTitle;
    });

    render(
      <NotePaperStrictPanel
        docId="doc-rename-test"
        title="原标题"
        hydrateTransport={transport}
        onRenameTitle={onRenameTitle}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });

    const panel = screen.getByTestId('note-paper-strict-panel');
    const titleEl = screen.getByTestId('note-paper-strict-title');
    fireEvent.click(titleEl);

    const input = screen.getByTestId('note-paper-strict-title-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新笔记标题' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onRenameTitle).toHaveBeenCalledWith('新笔记标题');
    });
    expect(savedTitle).toBe('新笔记标题');

    await waitFor(() => {
      expect(panel).toHaveAttribute('data-save-status', 'saved');
    });
  });

  // -------------------------------------------------------------------------
  // audit-repair-202609 · T7/T8：空笔记首块闭环 + 差量落盘契约
  // -------------------------------------------------------------------------

  it('strict_empty_doc_click_creates_real_block_and_persists_typing', async () => {
    const transport = createFixtureHydrateTransport(); // 空文档成功投影
    const recordedOps: string[] = [];
    const applyOpsMock = vi.fn(async (opsJson: string) => {
      recordedOps.push(opsJson);
      return { ok: true };
    });

    render(
      <NotePaperStrictPanel
        docId="doc-init-flow"
        hydrateTransport={transport}
        applyOps={applyOpsMock}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'empty'
      );
    });

    // 点击空白 → insert paragraph（合法 UUID 块 ID）落盘
    await act(async () => {
      fireEvent.click(screen.getByTestId('note-paper-strict-empty'));
    });
    await waitFor(() => {
      expect(applyOpsMock).toHaveBeenCalledTimes(1);
    });
    const insertOp = JSON.parse(recordedOps[0])[0];
    expect(insertOp.op).toBe('insert');
    expect(insertOp.kind).toBe('paragraph');
    expect(insertOp.parent).toBeNull();
    expect(isUuidV4(insertOp.id)).toBe(true);

    // 初始化行必须绑定该真实块 ID（杜绝幽灵 init-first-block ID）
    const row = screen.getByTestId('note-strict-block-init-first-block');
    expect(row.getAttribute('data-block-id')).toBe(insertOp.id);

    // 打字 → 失焦：text_edit 差量 op 落到同一块（UTF-8 无 BOM 全链真实形状）
    const leaf = row.querySelector('div[contenteditable="true"]');
    expect(leaf).not.toBeNull();
    await act(async () => {
      (leaf as HTMLElement).textContent = '新内容';
      fireEvent.input(leaf as HTMLElement);
      fireEvent.blur(leaf as HTMLElement);
    });
    await waitFor(() => {
      expect(applyOpsMock).toHaveBeenCalledTimes(2);
    });
    const editOp = JSON.parse(recordedOps[1])[0];
    expect(editOp).toEqual({
      op: 'text_edit',
      id: insertOp.id,
      start: 0,
      end: 0,
      insert: '新内容',
    });
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-save-status',
        'saved'
      );
    });
  });
});
