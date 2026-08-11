/**
 * hydrate 投影形状 + adapter 单测（W5-B Strict · B-09）
 *
 * 测名 w5b_strict_*：形状必须是 hydrate 后投影，非静默假段落。
 */
import { describe, expect, it } from 'vitest';
import { createMemoryNoteTransport } from '../../api/noteApi';
import {
  adaptNoteTransportAsHydrate,
  createEmptyStateStrictDemoTransport,
  createFixtureHydrateTransport,
  makeHydratedBlock,
  mapQueryHitToProjection,
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
});
