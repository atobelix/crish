// @vitest-environment jsdom
/**
 * CONN-D×G2′ · 叶 mdPrefix `# ` → product_apply → Strict 同 doc flavour
 *
 * 完成定义：
 * 1. 叶路径：用户输入 `# `（同 doc）或 `tryCommitStrictLeafMdPrefix`（异 doc）
 *    → product-ipc mock apply 成功 applied>0 → notify product_apply
 *    → Strict 同 doc 行 `data-flavour` 前进为 heading
 * 2. 异 doc 不误刷本面板 flavour
 * 3. **不读** `pending_turn_into_flavour` 当 kind UI
 *
 * 诚实边界：
 * - **≠ EL-08**；**≠ EL-01**；**≠ A-BLK-08/09 e2e**；**≠ 打开完成**
 * - Memory / mock IPC；禁止 fixture / mock 伪装 tauri-ipc 为真打开完成
 * - 物质化 = 测夹具：叶 `# ` 的 provisional ops 无 kind 字段（RS 未在
 *   本夹具消费 pending）→ mock apply 成功后把投影 flavour 写成 heading
 *   （哈希前缀族）。**不是** DocSession::apply / 真 RS 改权威 kind
 * - 物质化 **不读** pending 当 kind；pending 仍是 `heading-1`，
 *   投影 / `data-flavour` 是 `heading`（可证 UI 没把 pending 当 flavour）
 * - **≠** 重做 CONN-DG2（DG2 入口是测里直接 `applyOps(kindOpsJson)`）
 * - **≠** 重做 G2 总线 / G2-int / SD-22；不改 EmptyState / Overlay / turnInto.rs
 *
 * 写死路径：Memory hydrate + `resolveProductStrictApplyOps`（product-ipc）
 * + `createProductMdPrefixBinding` + 叶 `# ` 提交。
 */
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  createMemoryNoteTransport,
  setDefaultNoteTransport,
  type MemoryNoteTransport,
} from '../../api/noteApi';
import {
  createMockNoteApplyOpsIpc,
  resolveProductStrictApplyOps,
  type NoteApplyOpsIpc,
  type NoteApplyOpsRequest,
} from '../../api/noteApplyOpsIpc';
import { clearNoteDocWrittenListenersForTests } from '../../bridges/note-doc-written';
import { adaptNoteTransportAsHydrate } from './hydrateProjection';
import { createProductMdPrefixBinding } from './noteMdPrefixBridge';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import { tryCommitStrictLeafMdPrefix } from './StrictContentRowLeaf';

const SEED_ID = 'seed-1';
const NEW_KIND = 'heading';
/** 叶 `# ` 写进 provisional ops 的 pending；**不得**出现在 data-flavour */
const PENDING_AS_KIND = 'heading-1';
const HEADING_TEXT = 'CONN-DXG2 leaf mdPrefix heading';
const OTHER_BLOCK_ID = 'dxg2-other-blk';

beforeEach(() => {
  clearNoteDocWrittenListenersForTests();
  setDefaultNoteTransport(null);
});

type FlavourSeed = { id: string; kind: string; text: string };

/**
 * 叶 `# ` provisional ops：text_edit + update_props.pending，**无** insert.kind。
 * 物质化只读显式 kind/flavour 字段；否则按哈希前缀族固定 heading。
 * **永不**读 pending_turn_into_flavour。
 */
function flavourSeedFromLeafMdPrefixOps(opsJson: string): FlavourSeed {
  try {
    const parsed: unknown = JSON.parse(opsJson);
    if (Array.isArray(parsed)) {
      let id = SEED_ID;
      let kindFromField: string | null = null;
      let textFromField: string | null = null;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as {
          id?: unknown;
          kind?: unknown;
          flavour?: unknown;
          text?: unknown;
        };
        if (typeof rec.id === 'string' && rec.id.length > 0) id = rec.id;
        if (typeof rec.kind === 'string' && rec.kind.length > 0) {
          kindFromField = rec.kind;
        } else if (
          kindFromField === null &&
          typeof rec.flavour === 'string' &&
          rec.flavour.length > 0
        ) {
          kindFromField = rec.flavour;
        }
        if (typeof rec.text === 'string' && rec.text.length > 0) {
          textFromField = rec.text;
        }
      }
      if (kindFromField) {
        return {
          id,
          kind: kindFromField,
          text: textFromField ?? HEADING_TEXT,
        };
      }
      if (parsed.length > 0) {
        return { id, kind: NEW_KIND, text: HEADING_TEXT };
      }
    }
  } catch {
    /* 夹具：解析失败走固定 heading */
  }
  return { id: SEED_ID, kind: NEW_KIND, text: HEADING_TEXT };
}

/**
 * mock apply + Memory / overlay 对齐：
 * ok 且 applied>0 → 把叶 mdPrefix 的投影 flavour 物质化（同 id overlay；
 * 空文档则 seedDoc 追加）。失败 / 0 不写。
 *
 * mock 成功体 source 仍是契约测形状；**禁止** 当 tauri-ipc / DocSession apply。
 */
function createLeafMdPrefixKindFixture(mem: MemoryNoteTransport): {
  ipc: NoteApplyOpsIpc & {
    calls: NoteApplyOpsRequest[];
    setNextError(err: { code: string; reason: string } | null): void;
  };
  hydrate: ReturnType<typeof adaptNoteTransportAsHydrate>;
} {
  const overlay = new Map<string, Map<string, FlavourSeed>>();
  const innerHydrate = adaptNoteTransportAsHydrate(mem);
  const ipcBase = createMockNoteApplyOpsIpc();

  function materialize(docId: string, seed: FlavourSeed): void {
    let m = overlay.get(docId);
    if (!m) {
      m = new Map();
      overlay.set(docId, m);
    }
    m.set(seed.id, seed);
    if (mem.blockCount(docId) === 0) {
      mem.seedDoc(docId, [[seed.id, seed.kind, seed.text]]);
    }
  }

  return {
    ipc: {
      calls: ipcBase.calls,
      setNextError: (err) => ipcBase.setNextError(err),
      async applyOps(req) {
        const outcome = await ipcBase.applyOps(req);
        if (outcome.ok && outcome.applied > 0) {
          materialize(req.docId, flavourSeedFromLeafMdPrefixOps(req.opsJson));
        }
        return outcome;
      },
    },
    hydrate: {
      async hydrate(docId) {
        const out = await innerHydrate.hydrate(docId);
        if (!out.ok) return out;
        const ov = overlay.get(docId);
        if (!ov) return out;
        return {
          ok: true as const,
          projection: {
            ...out.projection,
            blocks: out.projection.blocks.map((b) => {
              const n = ov.get(b.id);
              return n ? { ...b, flavour: n.kind, text: n.text } : b;
            }),
          },
        };
      },
    },
  };
}

function productMdPrefixBindingFor(ipc: NoteApplyOpsIpc, docId: string) {
  const resolved = resolveProductStrictApplyOps({
    docId,
    applyOpsIpc: ipc,
    isTauriRuntime: false,
  });
  return createProductMdPrefixBinding({
    applyOps: resolved.applyOps!,
    sourceLabel: 'product-ipc',
  });
}

function strictRow(blockId: string): HTMLElement {
  return screen.getByTestId(`note-strict-block-${blockId}`);
}

function strictLeaf(blockId: string): HTMLElement {
  return screen.getByTestId(`note-strict-leaf-${blockId}`);
}

function flavourInPanel(flavour: string): Element | null {
  return screen
    .getByTestId('note-paper-strict-panel')
    .querySelector(`[data-flavour="${flavour}"]`);
}

describe('CONN-D×G2′ · 叶 mdPrefix → Strict kind 写后读回', () => {
  it('conn_dxg2_leaf_mdprefix_same_doc_refreshes_flavour', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-dxg2', [[SEED_ID, 'paragraph', 'seed before apply']]);
    const { ipc, hydrate } = createLeafMdPrefixKindFixture(mem);
    const binding = productMdPrefixBindingFor(ipc, 'doc-dxg2');

    render(
      <NotePaperStrictPanel
        docId="doc-dxg2"
        hydrateTransport={hydrate}
        presentationMode="react-rows"
        mdPrefixBinding={binding}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('seed before apply')).toBeInTheDocument();
    });
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    expect(strictLeaf(SEED_ID)).toHaveAttribute(
      'data-from-flavour',
      'paragraph'
    );
    expect(flavourInPanel(NEW_KIND)).toBeNull();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-source',
      'note-transport'
    );
    expect(screen.getByTestId('note-paper-strict-panel')).not.toHaveAttribute(
      'data-hydrate-source',
      'tauri-ipc'
    );

    const leaf = strictLeaf(SEED_ID);
    await act(async () => {
      leaf.textContent = '# ';
      fireEvent.input(leaf);
    });

    await waitFor(() => {
      expect(ipc.calls.length).toBeGreaterThanOrEqual(1);
    });
    expect(binding.collab!.wireCalls.length).toBeGreaterThanOrEqual(1);
    const wire = binding.collab!.wireCalls[0]!;
    expect(wire).toContain('pending_turn_into_flavour');
    expect(wire).toContain(PENDING_AS_KIND);
    expect(wire).not.toContain('"op":"turn_into"');
    expect(ipc.calls[0]!.opsJson).toContain('pending_turn_into_flavour');
    expect(ipc.calls[0]!.opsJson).toContain(PENDING_AS_KIND);
    expect(NEW_KIND).not.toBe(PENDING_AS_KIND);

    await waitFor(() => {
      expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', NEW_KIND);
    });
    const row = strictRow(SEED_ID);
    expect(row).not.toHaveAttribute('data-flavour', PENDING_AS_KIND);
    expect(strictLeaf(SEED_ID)).toHaveAttribute('data-from-flavour', NEW_KIND);
    expect(strictLeaf(SEED_ID)).not.toHaveAttribute(
      'data-from-flavour',
      PENDING_AS_KIND
    );
    expect(flavourInPanel(PENDING_AS_KIND)).toBeNull();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
  });

  it('conn_dxg2_other_doc_does_not_refresh', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-keep', [[SEED_ID, 'paragraph', 'keep my kind']]);
    const { ipc, hydrate } = createLeafMdPrefixKindFixture(mem);
    const keepBinding = productMdPrefixBindingFor(ipc, 'doc-keep');
    const otherBinding = productMdPrefixBindingFor(ipc, 'doc-other');

    render(
      <NotePaperStrictPanel
        docId="doc-keep"
        hydrateTransport={hydrate}
        presentationMode="react-rows"
        mdPrefixBinding={keepBinding}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('keep my kind')).toBeInTheDocument();
    });
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    const beforeCount = screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count');

    const result = await tryCommitStrictLeafMdPrefix({
      blockId: OTHER_BLOCK_ID,
      text: '# ',
      fromFlavour: 'paragraph',
      isComposing: false,
      binding: otherBinding,
      createIntentId: () => 'conn-dxg2-other-1',
    });
    expect(result.ok).toBe(true);
    expect(ipc.calls.length).toBeGreaterThanOrEqual(1);
    expect(otherBinding.collab!.wireCalls[0]).toContain(
      'pending_turn_into_flavour'
    );
    expect(mem.blockCount('doc-other')).toBe(1);

    await waitFor(() => {
      expect(
        screen.queryByTestId(`note-strict-block-${OTHER_BLOCK_ID}`)
      ).toBeNull();
    });
    expect(screen.getByText('keep my kind')).toBeInTheDocument();
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    expect(strictLeaf(SEED_ID)).toHaveAttribute(
      'data-from-flavour',
      'paragraph'
    );
    expect(flavourInPanel(NEW_KIND)).toBeNull();
    expect(flavourInPanel(PENDING_AS_KIND)).toBeNull();
    expect(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    ).toBe(beforeCount);
  });
});
