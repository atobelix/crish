// @vitest-environment jsdom
/**
 * CONN-G2-int · product_apply → Strict 同 doc 写后读回
 *
 * 完成定义：
 * 1. 同 docId：adaptNoteApplyOpsIpcAsApplyOps 成功且 applied>0 后
 *    Strict 投影见新块文本（blocks / rev 前进）
 * 2. 异 docId：不误刷新本面板
 * 3. 失败 / applied=0：不刷
 *
 * 诚实边界：
 * - **≠ EL-08**；**≠ EL-01**；**≠ 打开完成**
 * - mock / Memory transport；禁止 fixture / mock 伪装 tauri-ipc 为真打开完成
 * - 不重做 CONN-G2 总线整包（notify 形状见
 *   `bridges/conn-g2.product-apply-note-doc-written.test.ts`）
 * - 不回退 E2 默认关；不改 enableProductPaperList 默认
 * - 不改 presentationMode 互斥默认
 * - Skeleton 双轨保留（本测仅 Strict）
 *
 * 写死路径：Memory hydrate + `adaptNoteApplyOpsIpcAsApplyOps`（mock IPC）。
 * mock 成功且 applied>0 时把 ops 内 text 物质化进 Memory，供 hydrate 读回。
 * 物质化 = 测夹具，**不是** DocSession::apply / 真打开。
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
import { W5B_SKELETON_PACKAGE_ID } from './w5bSkeleton';
import { W5B_STRICT_PACKAGE_ID } from './w5bStrict';

const NEW_BLOCK_TEXT = 'CONN-G2 product apply new block';
const OTHER_DOC_TEXT = 'should not appear here';

beforeEach(() => {
  clearNoteDocWrittenListenersForTests();
  setDefaultNoteTransport(null);
});

function insertOpsJson(text: string): string {
  return JSON.stringify([{ op: 'insert', id: 'g2-blk', text }]);
}

function insertTextFromOpsJson(opsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(opsJson);
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      const rec = parsed[0] as { text?: unknown };
      if (typeof rec.text === 'string' && rec.text.length > 0) {
        return rec.text;
      }
    }
  } catch {
    /* 夹具：解析失败走固定句 */
  }
  return NEW_BLOCK_TEXT;
}

/**
 * mock apply_ops + Memory 对齐：
 * ok 且 applied>0 → seed 一段可观测正文到 Memory（hydrate 读回）。
 * 失败 / applied=0 不写 Memory。
 *
 * mock 成功体 source 仍是契约测形状；**禁止** 当 tauri-ipc 打开完成。
 */
function createMemoryLinkedMockApplyOpsIpc(
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
        const text = insertTextFromOpsJson(req.opsJson);
        mem.seedDoc(req.docId, [
          [`g2-${req.intentId ?? String(ipc.calls.length)}`, 'paragraph', text],
        ]);
      }
      return outcome;
    },
  };
}

/** hydrate 投影 rev = Memory 块数，便于断言 blocks/rev 前进（≠ 产品 RS rev） */
function adaptMemoryHydrateWithBlockRev(mem: MemoryNoteTransport) {
  const inner = adaptNoteTransportAsHydrate(mem);
  return {
    async hydrate(docId: string) {
      const out = await inner.hydrate(docId);
      if (!out.ok) return out;
      return {
        ok: true as const,
        projection: {
          ...out.projection,
          rev: mem.blockCount(docId),
        },
      };
    },
  };
}

function panelBlockCount(): number {
  return Number(
    screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count')
  );
}

function panelRev(): string | null {
  return screen.getByTestId('note-paper-strict-panel').getAttribute('data-rev');
}

describe('CONN-G2-int · product_apply → Strict 写后读回', () => {
  it('conn_g2_same_doc_product_apply_refreshes_strict_projection', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-g2', [['seed-1', 'paragraph', 'seed before apply']]);
    const hydrate = adaptMemoryHydrateWithBlockRev(mem);

    render(<NotePaperStrictPanel docId="doc-g2" hydrateTransport={hydrate} />);

    await waitFor(() => {
      expect(screen.getByText('seed before apply')).toBeInTheDocument();
    });
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-package-id',
      W5B_STRICT_PACKAGE_ID
    );
    expect(W5B_SKELETON_PACKAGE_ID).not.toBe(W5B_STRICT_PACKAGE_ID);
    expect(panelBlockCount()).toBe(1);
    expect(panelRev()).toBe('1');

    const ipc = createMemoryLinkedMockApplyOpsIpc(mem);
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-g2');
    const result = await applyOps(insertOpsJson(NEW_BLOCK_TEXT), {
      intentId: 'conn-g2-write-1',
    });
    expect(result.ok).toBe(true);
    expect(ipc.calls).toHaveLength(1);

    await waitFor(() => {
      expect(screen.getByText(NEW_BLOCK_TEXT)).toBeInTheDocument();
    });
    expect(screen.getByText('seed before apply')).toBeInTheDocument();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
    expect(panelBlockCount()).toBeGreaterThanOrEqual(2);
    expect(Number(panelRev())).toBeGreaterThanOrEqual(2);
  });

  it('conn_g2_other_doc_product_apply_does_not_refresh_this_strict', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-keep', [['k1', 'paragraph', 'keep me']]);
    const hydrate = adaptMemoryHydrateWithBlockRev(mem);

    render(
      <NotePaperStrictPanel docId="doc-keep" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(screen.getByText('keep me')).toBeInTheDocument();
    });
    const beforeCount = screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count');
    const beforeRev = panelRev();

    const ipc = createMemoryLinkedMockApplyOpsIpc(mem);
    const applyOther = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-other');
    const result = await applyOther(insertOpsJson(OTHER_DOC_TEXT), {
      intentId: 'conn-g2-other-1',
    });
    expect(result.ok).toBe(true);
    expect(mem.blockCount('doc-other')).toBe(1);

    await waitFor(() => {
      expect(screen.queryByText(OTHER_DOC_TEXT)).toBeNull();
    });
    expect(screen.getByText('keep me')).toBeInTheDocument();
    expect(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    ).toBe(beforeCount);
    expect(panelRev()).toBe(beforeRev);
  });

  it('conn_g2_product_apply_fail_or_zero_does_not_refresh', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-g2-fz', [['fz1', 'paragraph', 'keep fail-zero']]);
    const hydrate = adaptMemoryHydrateWithBlockRev(mem);

    render(
      <NotePaperStrictPanel docId="doc-g2-fz" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(screen.getByText('keep fail-zero')).toBeInTheDocument();
    });
    const beforeCount = screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count');
    const beforeRev = panelRev();
    const beforeBlocks = mem.blockCount('doc-g2-fz');

    const ipc = createMemoryLinkedMockApplyOpsIpc(mem);
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-g2-fz');

    ipc.setNextError({ code: 'note.apply_failed', reason: 'boom' });
    const fail = await applyOps(insertOpsJson(NEW_BLOCK_TEXT), {
      intentId: 'conn-g2-fail-1',
    });
    expect(fail.ok).toBe(false);

    const zero = await applyOps('[]', { intentId: 'conn-g2-zero-1' });
    expect(zero.ok).toBe(true);
    expect(ipc.calls).toHaveLength(2);

    await waitFor(() => {
      expect(screen.queryByText(NEW_BLOCK_TEXT)).toBeNull();
    });
    expect(screen.getByText('keep fail-zero')).toBeInTheDocument();
    expect(mem.blockCount('doc-g2-fz')).toBe(beforeBlocks);
    expect(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    ).toBe(beforeCount);
    expect(panelRev()).toBe(beforeRev);
  });
});
