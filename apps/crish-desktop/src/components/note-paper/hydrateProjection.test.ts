/**
 * hydrate 投影形状 + adapter + 产品默认选型单测（W5-B Strict · B-09 / 真 hydrate 深化）
 *
 * 测名 w5b_strict_*：形状必须是 hydrate 后投影，非静默假段落。
 * 产品默认：`resolveProductStrictHydrateSource` / `createProductStrictHydrateTransport`
 * —— 可检测 Tauri → tauri-ipc；无 Tauri → fixture；**禁止** fixture 伪装 ipc。
 */
import { describe, expect, it } from 'vitest';
import { createMemoryNoteTransport } from '../../api/noteApi';
import { createMockNoteHydrateIpc } from '../../api/noteHydrateIpc';
import {
  adaptNoteHydrateIpcAsTransport,
  adaptNoteTransportAsHydrate,
  createEmptyStateStrictDemoTransport,
  createFixtureHydrateTransport,
  createProductStrictHydrateTransport,
  makeHydratedBlock,
  mapQueryHitToProjection,
  resolveProductStrictHydrateSource,
} from './hydrateProjection';

describe('hydrateProjection · w5b_strict_shape', () => {
  it('w5b_strict_makeHydratedBlock_has_index_flavour_not_silent_only', () => {
    const b = makeHydratedBlock({
      id: 'blk-1',
      flavour: 'heading',
      text: 'Title after hydrate',
      props: { level: 1 },
      index: 0,
    });
    expect(b).toMatchObject({
      id: 'blk-1',
      flavour: 'heading',
      index: 0,
      text: 'Title after hydrate',
    });
    // 投影字段齐：非 createSilentFixture 假段落路径
    expect(b).toHaveProperty('index');
    expect(b).toHaveProperty('flavour');
  });

  it('w5b_strict_fixture_hydrate_success_projection', async () => {
    const t = createFixtureHydrateTransport({
      'doc-a': {
        rev: 3,
        blocks: [
          makeHydratedBlock({
            id: 'h1',
            flavour: 'heading',
            text: 'Hydrated H1',
            index: 0,
            props: { level: 1 },
          }),
          makeHydratedBlock({
            id: 'p1',
            flavour: 'paragraph',
            text: 'body from hydrate',
            index: 1,
          }),
        ],
      },
    });
    const out = await t.hydrate('doc-a');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.source).toBe('fixture');
    expect(out.projection.docId).toBe('doc-a');
    expect(out.projection.rev).toBe(3);
    expect(out.projection.blocks).toHaveLength(2);
    expect(out.projection.blocks[0]?.flavour).toBe('heading');
    expect(out.projection.blocks[1]?.text).toBe('body from hydrate');
  });

  it('w5b_strict_fixture_hydrate_empty_doc_is_success_zero_blocks', async () => {
    const t = createFixtureHydrateTransport();
    const out = await t.hydrate('never-seeded');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.blocks).toEqual([]);
    expect(out.projection.source).toBe('fixture');
  });

  it('w5b_strict_fixture_hydrate_error', async () => {
    const t = createFixtureHydrateTransport();
    t.setNextError({ code: 'note.hydrate_failed', reason: 'blob missing' });
    const out = await t.hydrate('doc-x');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('note.hydrate_failed');
    expect(out.reason).toMatch(/blob missing/);
  });

  it('w5b_strict_mapQueryHit_and_adapt_note_transport', async () => {
    const mapped = mapQueryHitToProjection(
      {
        id: 'q1',
        kind: 'paragraph',
        snippet: 'from query',
        attrs: { level: 0 },
      },
      2
    );
    expect(mapped).toMatchObject({
      id: 'q1',
      flavour: 'paragraph',
      index: 2,
      text: 'from query',
    });

    const mem = createMemoryNoteTransport();
    await mem.applyMd({
      docId: 'doc-adapt',
      markdown: '## Adapt\n\nbody line',
      intentId: 'adapt-1',
    });
    const hydrate = adaptNoteTransportAsHydrate(mem, { rev: 7 });
    const out = await hydrate.hydrate('doc-adapt');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.source).toBe('note-transport');
    expect(out.projection.rev).toBe(7);
    expect(out.projection.blocks.length).toBeGreaterThanOrEqual(1);
    expect(
      out.projection.blocks.every((b) => typeof b.index === 'number')
    ).toBe(true);
  });

  it('w5b_strict_adapt_propagates_transport_failure', async () => {
    const failing: import('../../api/noteApi').NoteTransport = {
      async applyMd() {
        return { ok: false, code: 'x', reason: 'n/a' };
      },
      async queryBlocks() {
        return {
          ok: false,
          code: 'note.command_missing',
          reason: 'IPC 未就绪',
        };
      },
      async sendToNote() {
        return { ok: false, code: 'x', reason: 'n/a' };
      },
    };
    const hydrate = adaptNoteTransportAsHydrate(failing);
    const out = await hydrate.hydrate('d');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('note.command_missing');
  });

  it('w5b_strict_empty_state_demo_transport_is_fixture_not_ipc', async () => {
    // 产品空态演示 fixture：可演示 ≠ 打开完成；source 必须为 fixture
    const t = createEmptyStateStrictDemoTransport('strict-ws-demo');
    const out = await t.hydrate('strict-ws-demo');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.source).toBe('fixture');
    expect(out.projection.source).not.toBe('tauri-ipc');
    expect(out.projection.blocks.length).toBeGreaterThanOrEqual(1);
    expect(
      out.projection.blocks.every((b) => typeof b.index === 'number')
    ).toBe(true);
  });

  it('w5b_strict_adapt_note_hydrate_ipc_source_tauri_ipc', async () => {
    const ipc = createMockNoteHydrateIpc({
      'doc-ipc': {
        rev: 5,
        blocks: [
          {
            id: 'i1',
            flavour: 'paragraph',
            index: 0,
            text: 'via NoteHydrateIpc',
          },
        ],
      },
    });
    const t = adaptNoteHydrateIpcAsTransport(ipc);
    const out = await t.hydrate('doc-ipc');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.source).toBe('tauri-ipc');
    expect(out.projection.rev).toBe(5);
    expect(out.projection.blocks[0]?.text).toMatch(/NoteHydrateIpc/);
    // CONN-A1：mock 默认 path=doc-session 可观测；≠ 打开完成 / ≠ 关 EL
    expect(out.projection.hydratePath).toBe('doc-session');
  });

  it('conn_a1_mock_ipc_default_hydrate_path_doc_session_observable', async () => {
    // 默认 mock 成功体 path=doc-session；preferQuery → query-blocks 对照
    // **禁止** 用本测宣称关 EL-01/04/08 或打开完成（仅分轨可观测）
    const ipc = createMockNoteHydrateIpc({
      'doc-path': {
        rev: 2,
        blocks: [
          {
            id: 'p1',
            flavour: 'paragraph',
            index: 0,
            text: 'path label only',
          },
        ],
      },
    });
    const t = adaptNoteHydrateIpcAsTransport(ipc);
    const def = await t.hydrate('doc-path');
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    expect(def.projection.source).toBe('tauri-ipc');
    expect(def.projection.hydratePath).toBe('doc-session');
    // fixture 演示轨不得带 tauri-ipc / doc-session 冒充
    const fx = createFixtureHydrateTransport({
      'doc-fx-path': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'f1',
            flavour: 'paragraph',
            text: 'fixture',
            index: 0,
          }),
        ],
      },
    });
    const fxOut = await fx.hydrate('doc-fx-path');
    expect(fxOut.ok).toBe(true);
    if (!fxOut.ok) return;
    expect(fxOut.projection.source).toBe('fixture');
    expect(fxOut.projection.source).not.toBe('tauri-ipc');
    expect(fxOut.projection.hydratePath).toBeUndefined();
  });
});

describe('hydrateProjection · product default source selection', () => {
  it('product_strict_resolve_source_tauri_true_is_tauri_ipc', () => {
    expect(resolveProductStrictHydrateSource({ isTauriRuntime: true })).toBe(
      'tauri-ipc'
    );
  });

  it('product_strict_resolve_source_tauri_false_is_fixture', () => {
    expect(resolveProductStrictHydrateSource({ isTauriRuntime: false })).toBe(
      'fixture'
    );
    // vitest 默认无 Tauri 全局 → 与显式 false 同向
    expect(resolveProductStrictHydrateSource()).toBe('fixture');
  });

  it('product_strict_transport_no_tauri_uses_fixture_demo_not_ipc', async () => {
    const t = createProductStrictHydrateTransport('strict-ws-product', {
      isTauriRuntime: false,
    });
    const out = await t.hydrate('strict-ws-product');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 无 Tauri：演示 fixture，禁止伪装 tauri-ipc
    expect(out.projection.source).toBe('fixture');
    expect(out.projection.source).not.toBe('tauri-ipc');
    expect(out.projection.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('product_strict_transport_tauri_uses_ipc_source_success', async () => {
    // path=doc-session 可观测 ≠ 打开完成 / ≠ 关 EL（CONN-A1 分轨诚实）
    const ipc = createMockNoteHydrateIpc({
      'doc-product-tauri': {
        rev: 11,
        blocks: [
          {
            id: 'pt1',
            flavour: 'paragraph',
            index: 0,
            text: 'product default tauri-ipc',
          },
        ],
      },
    });
    const t = createProductStrictHydrateTransport('doc-product-tauri', {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });
    const out = await t.hydrate('doc-product-tauri');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.source).toBe('tauri-ipc');
    expect(out.projection.source).not.toBe('fixture');
    expect(out.projection.hydratePath).toBe('doc-session');
    expect(out.projection.rev).toBe(11);
    expect(out.projection.blocks[0]?.text).toMatch(/product default tauri-ipc/);
  });

  it('product_strict_transport_tauri_empty_success_still_tauri_ipc', async () => {
    // 未 seed = 空投影成功；有 Tauri 时不得回退 fixture
    const ipc = createMockNoteHydrateIpc();
    const t = createProductStrictHydrateTransport('doc-empty-tauri', {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });
    const out = await t.hydrate('doc-empty-tauri');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.projection.blocks).toEqual([]);
    expect(out.projection.source).toBe('tauri-ipc');
    expect(out.projection.source).not.toBe('fixture');
  });

  it('product_strict_transport_tauri_failure_does_not_fallback_fixture', async () => {
    const ipc = createMockNoteHydrateIpc({
      'doc-fail': {
        rev: 1,
        blocks: [
          {
            id: 'f1',
            flavour: 'paragraph',
            index: 0,
            text: 'should not surface on error',
          },
        ],
      },
    });
    ipc.setNextError({
      code: 'note.hydrate_failed',
      reason: 'blob missing in product path',
    });
    const t = createProductStrictHydrateTransport('doc-fail', {
      isTauriRuntime: true,
      hydrateIpc: ipc,
    });
    const out = await t.hydrate('doc-fail');
    // 失败三态：ok:false，不静默换成 fixture 演示块
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('note.hydrate_failed');
    expect(out.reason).toMatch(/blob missing/);
  });

  it('product_strict_fixture_never_labels_source_as_tauri_ipc', async () => {
    const fixture = createFixtureHydrateTransport({
      'doc-fx': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'x',
            flavour: 'paragraph',
            text: 'fixture only',
            index: 0,
          }),
        ],
      },
    });
    const out = await fixture.hydrate('doc-fx');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 纪律：fixture 响应不得写 tauri-ipc 骗测
    expect(out.projection.source).toBe('fixture');
    expect(out.projection.source).not.toBe('tauri-ipc');
  });
});
