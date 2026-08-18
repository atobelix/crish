// @vitest-environment jsdom
/**
 * CONN-EXT-LEAF / CONN-EXT-TEST / CONN-EXT-DEACT
 *
 * 证伪：扩展激活后叶工厂是否按 07 §5.2 一次挂齐（读原策略常量，不新开锥）。
 * 测头自钉：jsdom 绿 ≠ 打开完成 ≠ 关 EL ≠ 重做 E2′ / C2′ / G2。
 * WorkspaceProductEmptyHost 已删，不得再当入口。EmptyState + CTA 仍是夹具；
 * 产品默开在 NoteLeafHost。`conn_c2_prod_*` / `conn_e2p_*` 测名仍作策略回归。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { Suspense, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as projectStore from '../../api/projectStore';
import { createMemoryNoteTransport } from '../../api/noteApi';
import { createMockNoteMirrorIpc } from '../../api/noteMirrorIpc';
import {
  notifyNoteDocWritten,
  clearNoteDocWrittenListenersForTests,
} from '../../bridges/note-doc-written';
import * as hydrateProduct from '../../components/note-paper/hydrateProjection';
import { adaptNoteTransportAsHydrate } from '../../components/note-paper/hydrateProjection';
import { WorkspaceEmptyState } from '../../components/workspace/WorkspaceEmptyState';
import { viewRegistry } from '../../services/view-registry';
import type { ViewRenderContext } from '../../services/view-registry';
import { activateNotePaper, deactivateNotePaper } from './activate';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';
import { NoteLeafHost } from './NoteLeafHost';
import * as productMirror from './productMirrorPolicy';
import { WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE } from './productMirrorPolicy';
import { WORKSPACE_PRODUCT_ENABLE_PAPER_LIST } from './productPaperListPolicy';
import { resetWorkspacePersistedStrictDocBindings } from './productStrictDoc';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const WORKSPACE_DIR = join(DIR, '../../components/workspace');

function ctx(partial: Partial<ViewRenderContext> = {}): ViewRenderContext {
  return {
    panelId: 'note',
    leafId: 'leaf-conn-ext',
    sessionId: 'chat-session-99',
    isActive: true,
    openView: () => {},
    params: {},
    ...partial,
  };
}

function readExt(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

function readWorkspace(name: string): string {
  return readFileSync(join(WORKSPACE_DIR, name), 'utf8');
}

async function renderActivatedFactory(
  partial: Partial<ViewRenderContext> = {}
) {
  activateNotePaper();
  const Comp = viewRegistry.getView('note')?.component;
  expect(Comp).toBeTruthy();
  const view = render(
    <Suspense fallback={<div data-testid="conn-ext-lazy">loading</div>}>
      {Comp ? <Comp {...ctx(partial)} /> : null}
    </Suspense>
  );
  await screen.findByTestId('note-paper-strict-panel');
  return view;
}

/** 残留 tab：订阅 registry，文案与 TreeLeafPanel 未知叶同形（不 import 叶壳，避开域外坏边）。 */
function ResidualNoteTab(props: ViewRenderContext) {
  const version = useSyncExternalStore(
    (cb) => viewRegistry.subscribe(cb),
    () => viewRegistry.getVersion()
  );
  void version;
  const def = viewRegistry.getView('note');
  if (!def) {
    return (
      <div data-testid="conn-ext-residual">
        未知面板类型：note（笔记扩展未激活）
      </div>
    );
  }
  const Comp = def.component;
  return (
    <Suspense fallback={<div data-testid="conn-ext-lazy">loading</div>}>
      <Comp {...props} />
    </Suspense>
  );
}

describe('CONN-EXT · 扩展叶工厂 / 注销（≠ EL · ≠ 打开完成 · ≠ 重做 E2′C2′G2）', () => {
  beforeEach(() => {
    deactivateNotePaper();
    resetWorkspacePersistedStrictDocBindings();
    clearNoteDocWrittenListenersForTests();
    vi.spyOn(projectStore, 'getActiveProjectId').mockReturnValue(null);
    vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue('');
  });

  afterEach(() => {
    act(() => {
      deactivateNotePaper();
    });
    vi.restoreAllMocks();
    resetWorkspacePersistedStrictDocBindings();
    clearNoteDocWrittenListenersForTests();
  });

  it('conn_ext_activate_registers_note_view', () => {
    expect(viewRegistry.getView('note')).toBeUndefined();
    activateNotePaper();
    const def = viewRegistry.getView('note');
    expect(def).toBeDefined();
    expect(def?.id).toBe('note');
    expect(def?.category).toBe('tool');
    expect(viewRegistry.getToolViews().some((v) => v.id === 'note')).toBe(true);
  });

  it('conn_ext_factory_mounts_strict_panel', async () => {
    const { container } = await renderActivatedFactory();
    expect(screen.getByTestId('note-paper-strict-panel')).toBeTruthy();
    expect(screen.queryByTestId('open-note-paper-strict')).toBeNull();
    expect(container.querySelector('[data-note-leaf-host="true"]')).toBeTruthy();
  });

  // jsdom 属性 ≠ 皮像素 ≠ 打开完成
  it('conn_ext_leaf_section_has_leaf_view_root', async () => {
    await renderActivatedFactory();
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-leaf-view-root', '1');
  });

  it('conn_ext_hydrate_no_tauri_is_fixture', async () => {
    const { container } = render(<NoteLeafHost {...ctx()} />);
    const panel = await screen.findByTestId('note-paper-strict-panel');
    await waitFor(() => {
      expect(panel).toHaveAttribute('data-hydrate-source', 'fixture');
    });
    expect(panel.getAttribute('data-hydrate-source')).not.toBe('tauri-ipc');
    expect(container.innerHTML).not.toMatch(/data-hydrate-source="tauri-ipc"/);
  });

  it('conn_ext_hydrate_not_session_id', async () => {
    render(
      <NoteLeafHost {...ctx({ sessionId: 'chat-session-99', params: {} })} />
    );
    const panel = await screen.findByTestId('note-paper-strict-panel');
    expect(panel.getAttribute('data-doc-id')).not.toBe('chat-session-99');
    expect(panel.getAttribute('data-doc-id')).toBe('strict-default');
  });

  it('conn_ext_c2_prime_paper_list_on', async () => {
    expect(WORKSPACE_PRODUCT_ENABLE_PAPER_LIST).toBe(true);
    expect(readExt('NoteLeafHost.tsx')).toMatch(
      /paperList=\{WORKSPACE_PRODUCT_ENABLE_PAPER_LIST/
    );
    expect(readExt('NoteLeafHost.tsx')).not.toMatch(
      /NOTE_LEAF_ENABLE_PAPER_LIST/
    );

    const { container } = render(<NoteLeafHost {...ctx()} />);
    const panel = await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(panel).toHaveAttribute('data-paper-list', '1');
    expect(panel).toHaveAttribute('data-presentation-mode', 'paper-list');
    expect(host).toHaveAttribute('data-product-paper-list', '1');
    expect(host).toHaveAttribute('data-el01', 'not-claimed');
    expect(host).toHaveAttribute('data-w3p-full', 'not-claimed');
    expect(screen.getByTestId('note-paper-strict-paper-list')).toBeTruthy();
    expect(panel.querySelectorAll('[data-content-row="1"]').length).toBe(0);
  });

  it('conn_ext_c2_empty_state_direct_still_off', async () => {
    expect(readWorkspace('WorkspaceEmptyState.tsx')).toMatch(
      /enableProductPaperList\s*=\s*false/
    );
    render(<WorkspaceEmptyState wsId="ws-conn-ext-c2-direct" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-product-paper-list', '0');
    expect(root).toHaveAttribute('data-el01', 'not-claimed');
    fireEvent.click(screen.getByTestId('open-note-paper-strict'));
    const panel = await screen.findByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-paper-list', '0');
  });

  it('conn_ext_e2_prime_policy_on_no_tauri', async () => {
    expect(WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE).toBe(true);
    expect(readExt('NoteLeafHost.tsx')).toMatch(
      /resolveWorkspaceProductEmptyMirrorProps/
    );
    expect(readExt('NoteLeafHost.tsx')).toMatch(
      /WORKSPACE_PRODUCT_ENABLE_MIRROR_DETECT_SCHEDULE/
    );

    const { container } = render(<NoteLeafHost {...ctx()} />);
    await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toHaveAttribute('data-mirror-detect-policy', '1');
    expect(host).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(host).toHaveAttribute('data-el03', 'not-claimed');
    expect(host).toHaveAttribute('data-inotify-full', 'not-claimed');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
  });

  it('conn_ext_e2_empty_state_direct_still_off', () => {
    expect(readWorkspace('WorkspaceEmptyState.tsx')).toMatch(
      /enableMirrorDetectSchedule\s*=\s*false/
    );
    render(<WorkspaceEmptyState wsId="ws-conn-ext-e2-direct" />);
    const root = screen.getByRole('status');
    expect(root).toHaveAttribute('data-mirror-detect-schedule', '0');
    expect(root).toHaveAttribute('data-mirror-detect-policy', '0');
    expect(screen.queryByTestId('mirror-drift-status-bar')).toBeNull();
  });

  it('conn_ext_e2_prime_mock_ipc_detect_once', async () => {
    const ipc = createMockNoteMirrorIpc();
    ipc.setNextError({ code: 'note.detect_fail', reason: 'injected fail' });
    vi.spyOn(
      productMirror,
      'resolveWorkspaceProductEmptyMirrorProps'
    ).mockReturnValue({
      enableMirrorDetectSchedule: true,
      mirrorIpc: ipc,
    });

    render(
      <NoteLeafHost {...ctx({ params: { docId: 'doc-ext-e2-fail' } })} />
    );
    await waitFor(() => {
      expect(ipc.detectCalls.length).toBeGreaterThanOrEqual(1);
    });
    const n = ipc.detectCalls.length;
    expect(n).toBeLessThanOrEqual(2);
    expect(ipc.detectCalls[0]?.docId).toBe('doc-ext-e2-fail');
    await new Promise((r) => setTimeout(r, 40));
    expect(ipc.detectCalls.length).toBe(n);

    const bar = screen.queryByTestId('mirror-drift-status-bar');
    if (bar) {
      expect(bar).not.toHaveAttribute('data-drift-class', 'mirror_only');
      expect(bar.textContent ?? '').toMatch(/未检测/);
    }
  });

  it('conn_ext_slash_no_tauri_readonly', async () => {
    const { container } = render(<NoteLeafHost {...ctx()} />);
    await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toHaveAttribute('data-slash-write-mode', 'readonly');
    expect(host).toHaveAttribute('data-slash-sink-source', 'none');
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-slash-write-mode',
      'readonly'
    );
  });

  // D2 默认：产品叶无 Tauri → mdPrefix disabled / sink=none
  // 测头自钉：jsdom 绿 ≠ 打开完成 ≠ 关 EL；不复制 d2 夹具注入可写
  it('conn_ext_md_prefix_no_tauri_disabled', async () => {
    const { container } = render(<NoteLeafHost {...ctx()} />);
    const panel = await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(screen.queryByTestId('open-note-paper-strict')).toBeNull();
    expect(host).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(host).toHaveAttribute('data-md-prefix-sink-source', 'none');
    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(panel).toHaveAttribute('data-md-prefix-sink-source', 'none');
  });

  it('conn_ext_g2_same_doc_notify_reloads', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-ext-g2', [['s1', 'paragraph', 'seed-ext-g2']]);
    const inner = adaptNoteTransportAsHydrate(mem);
    vi.spyOn(
      hydrateProduct,
      'createProductStrictHydrateTransport'
    ).mockReturnValue({
      hydrate: (id) => inner.hydrate(id),
    });

    render(
      <NoteLeafHost {...ctx({ params: { docId: 'doc-ext-g2' } })} />
    );
    await waitFor(() => {
      expect(screen.getByText('seed-ext-g2')).toBeInTheDocument();
    });
    expect(readExt('NoteLeafHost.tsx')).toMatch(
      /createProductStrictHydrateTransport/
    );
    expect(readExt('NoteLeafHost.tsx')).not.toMatch(/notifyNoteDocWritten/);

    mem.seedDoc('doc-ext-g2', [['s2', 'paragraph', 'after-notify-ext']]);
    act(() => {
      notifyNoteDocWritten({
        docId: 'doc-ext-g2',
        source: 'product_apply',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('after-notify-ext')).toBeInTheDocument();
    });
    expect(screen.getByText('seed-ext-g2')).toBeInTheDocument();
  });

  it('conn_ext_g2_other_doc_no_reload', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-ext-keep', [['k1', 'paragraph', 'keep-ext-g2']]);
    const inner = adaptNoteTransportAsHydrate(mem);
    let hydrates = 0;
    vi.spyOn(
      hydrateProduct,
      'createProductStrictHydrateTransport'
    ).mockReturnValue({
      hydrate: async (id) => {
        hydrates += 1;
        return inner.hydrate(id);
      },
    });

    render(
      <NoteLeafHost {...ctx({ params: { docId: 'doc-ext-keep' } })} />
    );
    await waitFor(() => {
      expect(screen.getByText('keep-ext-g2')).toBeInTheDocument();
    });
    const before = hydrates;

    mem.seedDoc('doc-other', [['o1', 'paragraph', 'other-ext-should-hide']]);
    act(() => {
      notifyNoteDocWritten({
        docId: 'doc-other',
        source: 'product_apply',
      });
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(hydrates).toBe(before);
    expect(screen.queryByText('other-ext-should-hide')).toBeNull();
    expect(screen.getByText('keep-ext-g2')).toBeInTheDocument();
  });

  it('conn_ext_honesty_attrs_on_leaf', async () => {
    const { container } = render(<NoteLeafHost {...ctx()} />);
    await screen.findByTestId('note-paper-strict-panel');
    const host = container.querySelector('[data-note-leaf-host="true"]');
    expect(host).toBeTruthy();
    expect(NOTE_LEAF_HONESTY_ATTRS).toEqual({
      'data-el01': 'not-claimed',
      'data-el03': 'not-claimed',
      'data-el04': 'not-claimed',
      'data-el08': 'not-claimed',
      'data-open-complete': 'not-claimed',
      'data-w3p-full': 'not-claimed',
      'data-inotify-full': 'not-claimed',
    });
    for (const [attr, value] of Object.entries(NOTE_LEAF_HONESTY_ATTRS)) {
      expect(host).toHaveAttribute(attr, value);
    }
  });

  it('conn_ext_deactivate_unregisters', async () => {
    const treeSrc = readFileSync(
      join(DIR, '../../components/binary-tree/TreeLeafPanel.tsx'),
      'utf8'
    );
    expect(treeSrc).toMatch(/未知面板类型：/);
    expect(treeSrc).toMatch(/笔记扩展未激活/);

    activateNotePaper();
    render(<ResidualNoteTab {...ctx()} />);
    await screen.findByTestId('note-paper-strict-panel');

    act(() => {
      deactivateNotePaper();
    });

    expect(viewRegistry.getView('note')).toBeUndefined();
    expect(viewRegistry.getToolViews().some((v) => v.id === 'note')).toBe(
      false
    );
    await waitFor(() => {
      expect(screen.getByTestId('conn-ext-residual').textContent ?? '').toMatch(
        /未知|扩展未激活/
      );
    });
    expect(screen.queryByTestId('note-paper-strict-panel')).toBeNull();
  });

  it('conn_ext_legacy_host_strategy_names_retained', () => {
    const c2 = readWorkspace('WorkspaceEmptyState.conn-c2-prod.test.tsx');
    const e2p = readWorkspace('Workspace.conn-e2-prime.test.tsx');
    expect(c2).toMatch(/conn_c2_prod_default_paper_list_on/);
    expect(c2).toMatch(/conn_c2_prod_paper_list_mutex_content_row/);
    expect(e2p).toMatch(/conn_e2p_workspace_product_host_enables_detect_schedule/);
    expect(e2p).toMatch(/conn_e2p_empty_state_direct_still_defaults_off/);
    expect(e2p).toMatch(/conn_e2p_no_tauri_does_not_fabricate_report/);
  });
});
