// @vitest-environment jsdom
/**
 * CONN-DG2 · product_apply → Strict 同 doc kind / flavour 前进
 *
 * 完成定义：
 * 1. 同 docId：adaptNoteApplyOpsIpcAsApplyOps 成功且 applied>0 后
 *    Strict 投影见新 kind（行 `data-flavour` + 叶 `data-from-flavour`）
 *    —— **不是** `pending_turn_into_flavour` 当 kind
 * 2. 异 docId：不误刷本面板 kind
 *
 * 诚实边界：
 * - **≠ EL-08**；**≠ EL-01**；**≠ A-BLK-08/09 e2e**；**≠ 打开完成**
 * - Memory / mock IPC；禁止 fixture / mock 伪装 tauri-ipc 为真打开完成
 * - 物质化 = 测夹具把 ops 内 kind/flavour 写入 Memory，**不是**
 *   DocSession::apply / 真 RS 消费 pending 改权威 kind
 * - 不重做 CONN-G2 总线整包（notify 形状见
 *   `bridges/conn-g2.product-apply-note-doc-written.test.ts`）
 * - 不重做 CONN-G2-int 文本 / blocks / rev 整包
 * - 不改 EmptyState / turnInto.rs / Overlay；不回退 D3 叶纪律
 *
 * 写死路径：Memory hydrate + `adaptNoteApplyOpsIpcAsApplyOps`（mock IPC）。
 * mock 成功且 applied>0 时 seed 新 flavour；pending 只留在 ops 形状里，
 * 物质化 **不读** pending。
 */
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryNoteTransport,
  setDefaultNoteTransport,
  type MemoryNoteTransport,
} from '../../api/noteApi';
import {
  adaptNoteApplyOpsIpcAsApplyOps,
  createMockNoteApplyOpsIpc,
  type NoteApplyOpsIpc,
  type NoteApplyOpsRequest,
} from '../../api/noteApplyOpsIpc';
import { clearNoteDocWrittenListenersForTests } from '../../bridges/note-doc-written';
import { adaptNoteTransportAsHydrate } from './hydrateProjection';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';

const SEED_ID = 'seed-1';
const NEW_BLOCK_ID = 'dg2-kind-blk';
const NEW_KIND = 'heading';
const PENDING_AS_KIND = 'bullet';
const NEW_KIND_TEXT = 'CONN-DG2 product apply heading';
const OTHER_BLOCK_ID = 'dg2-other-blk';
const OTHER_KIND = 'code';
const OTHER_KIND_TEXT = 'should not leak kind here';

beforeEach(() => {
  clearNoteDocWrittenListenersForTests();
  setDefaultNoteTransport(null);
});

/**
 * 夹具 ops：带权威 kind + 故意不同的 pending。
 * **不是** 真 Op::TurnInto / DocSession 消费形状。
 */
function kindOpsJson(input: {
  id: string;
  kind: string;
  text: string;
  pending: string;
}): string {
  return JSON.stringify([
    {
      op: 'insert',
      id: input.id,
      kind: input.kind,
      flavour: input.kind,
      text: input.text,
      props: {
        attrs: { pending_turn_into_flavour: input.pending },
      },
    },
  ]);
}

type KindSeed = { id: string; kind: string; text: string };

/**
 * 物质化只读 ops 的 kind / flavour，**永不**读 pending_turn_into_flavour。
 * 夹具解析失败 → 固定 heading，仍禁止把 pending 当 kind。
 */
function kindSeedFromOpsJson(opsJson: string): KindSeed {
  try {
    const parsed: unknown = JSON.parse(opsJson);
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      const rec = parsed[0] as {
        id?: unknown;
        kind?: unknown;
        flavour?: unknown;
        text?: unknown;
      };
      const kind =
        typeof rec.kind === 'string' && rec.kind.length > 0
          ? rec.kind
          : typeof rec.flavour === 'string' && rec.flavour.length > 0
            ? rec.flavour
            : NEW_KIND;
      const id =
        typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : NEW_BLOCK_ID;
      const text =
        typeof rec.text === 'string' && rec.text.length > 0
          ? rec.text
          : NEW_KIND_TEXT;
      return { id, kind, text };
    }
  } catch {
    /* 夹具：解析失败走固定 heading */
  }
  return { id: NEW_BLOCK_ID, kind: NEW_KIND, text: NEW_KIND_TEXT };
}

/**
 * mock apply_ops + Memory 对齐：
 * ok 且 applied>0 → 把 ops 内 kind 物质化进 Memory（hydrate 读回 flavour）。
 * 失败 / applied=0 不写 Memory。
 *
 * mock 成功体 source 仍是契约测形状；**禁止** 当 tauri-ipc / DocSession apply。
 */
function createMemoryLinkedKindApplyOpsIpc(
  mem: MemoryNoteTransport
): NoteApplyOpsIpc & {
  calls: NoteApplyOpsRequest[];
  setNextError(err: { code: string; reason: string } | null): void;
} {
  const ipc = createMockNoteApplyOpsIpc();
  return {
    calls: ipc.calls,
    setNextError: (err) => ipc.setNextError(err),
    async applyOps(req) {
      const outcome = await ipc.applyOps(req);
      if (outcome.ok && outcome.applied > 0) {
        const seed = kindSeedFromOpsJson(req.opsJson);
        mem.seedDoc(req.docId, [[seed.id, seed.kind, seed.text]]);
      }
      return outcome;
    },
  };
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

describe('CONN-DG2 · product_apply → Strict kind 写后读回', () => {
  it('conn_dg2_same_doc_product_apply_refreshes_strict_kind', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-dg2', [[SEED_ID, 'paragraph', 'seed before apply']]);
    const hydrate = adaptNoteTransportAsHydrate(mem);

    render(<NotePaperStrictPanel docId="doc-dg2" hydrateTransport={hydrate} />);

    await waitFor(() => {
      expect(screen.getByText('seed before apply')).toBeInTheDocument();
    });
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    expect(strictLeaf(SEED_ID)).toHaveAttribute(
      'data-from-flavour',
      'paragraph'
    );
    expect(flavourInPanel(NEW_KIND)).toBeNull();

    const ipc = createMemoryLinkedKindApplyOpsIpc(mem);
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-dg2');
    const result = await applyOps(
      kindOpsJson({
        id: NEW_BLOCK_ID,
        kind: NEW_KIND,
        text: NEW_KIND_TEXT,
        pending: PENDING_AS_KIND,
      }),
      { intentId: 'conn-dg2-kind-1' }
    );
    expect(result.ok).toBe(true);
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]!.opsJson).toContain('pending_turn_into_flavour');
    expect(ipc.calls[0]!.opsJson).toContain(PENDING_AS_KIND);
    expect(NEW_KIND).not.toBe(PENDING_AS_KIND);

    await waitFor(() => {
      expect(screen.getByText(NEW_KIND_TEXT)).toBeInTheDocument();
    });

    const row = strictRow(NEW_BLOCK_ID);
    const leaf = strictLeaf(NEW_BLOCK_ID);
    expect(row).toHaveAttribute('data-flavour', NEW_KIND);
    expect(row).not.toHaveAttribute('data-flavour', PENDING_AS_KIND);
    expect(leaf).toHaveAttribute('data-from-flavour', NEW_KIND);
    expect(leaf).not.toHaveAttribute('data-from-flavour', PENDING_AS_KIND);
    // 种子行仍走投影 kind；pending 不得污染已有行
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    expect(strictLeaf(SEED_ID)).toHaveAttribute(
      'data-from-flavour',
      'paragraph'
    );
    expect(flavourInPanel(PENDING_AS_KIND)).toBeNull();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
  });

  it('conn_dg2_other_doc_does_not_refresh_kind', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-keep', [[SEED_ID, 'paragraph', 'keep my kind']]);
    const hydrate = adaptNoteTransportAsHydrate(mem);

    render(
      <NotePaperStrictPanel docId="doc-keep" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(screen.getByText('keep my kind')).toBeInTheDocument();
    });
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    const beforeCount = screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count');

    const ipc = createMemoryLinkedKindApplyOpsIpc(mem);
    const applyOther = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-other');
    const result = await applyOther(
      kindOpsJson({
        id: OTHER_BLOCK_ID,
        kind: OTHER_KIND,
        text: OTHER_KIND_TEXT,
        pending: NEW_KIND,
      }),
      { intentId: 'conn-dg2-other-1' }
    );
    expect(result.ok).toBe(true);
    expect(mem.blockCount('doc-other')).toBe(1);

    await waitFor(() => {
      expect(screen.queryByText(OTHER_KIND_TEXT)).toBeNull();
    });
    expect(screen.getByText('keep my kind')).toBeInTheDocument();
    expect(strictRow(SEED_ID)).toHaveAttribute('data-flavour', 'paragraph');
    expect(strictLeaf(SEED_ID)).toHaveAttribute(
      'data-from-flavour',
      'paragraph'
    );
    expect(
      screen.queryByTestId(`note-strict-block-${OTHER_BLOCK_ID}`)
    ).toBeNull();
    expect(flavourInPanel(OTHER_KIND)).toBeNull();
    expect(flavourInPanel(NEW_KIND)).toBeNull();
    expect(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    ).toBe(beforeCount);
  });
});
