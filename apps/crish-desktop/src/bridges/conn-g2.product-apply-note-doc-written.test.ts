/**
 * CONN-G2 · 产品 apply 写成功 → note-doc-written 总线
 *
 * 完成定义：
 * 1. product_apply source 钉清（NoteDocWrittenSource）
 * 2. note_apply_ops 适配 / slash / mdPrefix 产品写锥：applied 成功后 notify
 * 3. 失败 / applied=0 **不** 通知
 * 4. 不回退 G1 send_to_note source
 *
 * 诚实边界：**≠ EL-08**；**≠ EL-01**；**≠ 打开完成**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { submitIntent } from '@crish/block-paper';
import {
  adaptNoteApplyOpsIpcAsApplyOps,
  createMockNoteApplyOpsIpc,
  resolveProductStrictApplyOps,
} from '../api/noteApplyOpsIpc';
import {
  commitProductMdPrefixFromPlainText,
  createProductMdPrefixBinding,
} from '../components/note-paper/noteMdPrefixBridge';
import { createProductStrictSlashBinding } from '../components/note-paper/productSlashSink';
import {
  clearNoteDocWrittenListenersForTests,
  subscribeNoteDocWritten,
  type NoteDocWrittenEvent,
} from './note-doc-written';

const ID_NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  clearNoteDocWrittenListenersForTests();
});

function collectWritten(): {
  events: NoteDocWrittenEvent[];
  unsub: () => void;
} {
  const events: NoteDocWrittenEvent[] = [];
  const unsub = subscribeNoteDocWritten((ev) => {
    events.push(ev);
  });
  return { events, unsub };
}

describe('CONN-G2 · product apply → note-doc-written', () => {
  it('conn_g2_adapt_apply_ops_success_notifies_product_apply', async () => {
    const ipc = createMockNoteApplyOpsIpc();
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-g2-adapt');
    const { events, unsub } = collectWritten();

    const r = await applyOps('[{"op":"insert","id":"b1"}]', {
      intentId: 'g2-adapt-1',
    });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      docId: 'doc-g2-adapt',
      intentId: 'g2-adapt-1',
      source: 'product_apply',
    });
    unsub();
  });

  it('conn_g2_adapt_apply_ops_fail_does_not_notify', async () => {
    const ipc = createMockNoteApplyOpsIpc();
    ipc.setNextError({ code: 'note.id_conflict', reason: 'dup' });
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-g2-fail');
    const { events, unsub } = collectWritten();

    const r = await applyOps('[{"op":"insert","id":"b1"}]', {
      intentId: 'g2-fail-1',
    });
    expect(r.ok).toBe(false);
    expect(events).toHaveLength(0);
    unsub();
  });

  it('conn_g2_adapt_applied_zero_does_not_notify', async () => {
    const ipc = createMockNoteApplyOpsIpc();
    const applyOps = adaptNoteApplyOpsIpcAsApplyOps(ipc, 'doc-g2-zero');
    const { events, unsub } = collectWritten();

    // mock：空 ops 数组 → applied=0、ok=true，不得打扰 Strict 投影
    const r = await applyOps('[]', { intentId: 'g2-zero-1' });
    expect(r.ok).toBe(true);
    expect(ipc.calls).toHaveLength(1);
    expect(events).toHaveLength(0);
    unsub();
  });

  it('conn_g2_slash_product_ipc_success_notifies', async () => {
    const mockIpc = createMockNoteApplyOpsIpc();
    const resolved = resolveProductStrictApplyOps({
      docId: 'doc-g2-slash',
      applyOpsIpc: mockIpc,
      isTauriRuntime: false,
    });
    expect(resolved.source).toBe('product-ipc');

    const binding = createProductStrictSlashBinding({
      applyOps: resolved.applyOps!,
      sourceLabel: 'product-ipc',
      allocateId: () => ID_NEW,
      resolveOrder: () => 'a0',
    });
    const { events, unsub } = collectWritten();

    const r = await submitIntent(
      {
        type: 'slash_insert' as const,
        blockId: 'anchor-1',
        offset: 0,
        flavour: 'paragraph',
        catalogItemId: 'paragraph',
        origin: 'slash' as const,
        intentId: 'g2-slash-1',
      },
      binding.sink!
    );
    expect(r.ok).toBe(true);
    expect(mockIpc.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.docId).toBe('doc-g2-slash');
    expect(events[0]?.source).toBe('product_apply');
    expect(events[0]?.intentId).toBe('g2-slash-1');
    unsub();
  });

  it('conn_g2_slash_product_ipc_fail_does_not_notify', async () => {
    const mockIpc = createMockNoteApplyOpsIpc();
    mockIpc.setNextError({ code: 'note.apply_failed', reason: 'boom' });
    const resolved = resolveProductStrictApplyOps({
      docId: 'doc-g2-slash-fail',
      applyOpsIpc: mockIpc,
      isTauriRuntime: false,
    });
    const binding = createProductStrictSlashBinding({
      applyOps: resolved.applyOps!,
      sourceLabel: 'product-ipc',
      allocateId: () => ID_NEW,
      resolveOrder: () => 'a0',
    });
    const { events, unsub } = collectWritten();

    const r = await submitIntent(
      {
        type: 'slash_insert' as const,
        blockId: 'anchor-1',
        offset: 0,
        flavour: 'paragraph',
        catalogItemId: 'paragraph',
        origin: 'slash' as const,
        intentId: 'g2-slash-fail-1',
      },
      binding.sink!
    );
    expect(r.ok).toBe(false);
    expect(events).toHaveLength(0);
    unsub();
  });

  it('conn_g2_md_prefix_product_ipc_success_notifies', async () => {
    const mockIpc = createMockNoteApplyOpsIpc();
    const resolved = resolveProductStrictApplyOps({
      docId: 'doc-g2-md',
      applyOpsIpc: mockIpc,
      isTauriRuntime: false,
    });
    const binding = createProductMdPrefixBinding({
      applyOps: resolved.applyOps!,
      sourceLabel: 'product-ipc',
    });
    const { events, unsub } = collectWritten();

    const r = await commitProductMdPrefixFromPlainText({
      blockId: 'blk-g2-md',
      text: '# ',
      fromFlavour: 'paragraph',
      binding,
      createIntentId: () => 'g2-md-1',
    });
    expect(r.ok).toBe(true);
    expect(mockIpc.calls.length).toBeGreaterThanOrEqual(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.docId).toBe('doc-g2-md');
    expect(events[0]?.source).toBe('product_apply');
    expect(events[0]?.intentId).toBe('g2-md-1');
    unsub();
  });

  it('conn_g2_injected_applyOps_does_not_auto_notify', async () => {
    // 宿主直接注入 ApplyOpsAdapter：不经 adapt → 不自动 notify（避免测侧双刷）
    const resolved = resolveProductStrictApplyOps({
      docId: 'doc-g2-inj',
      applyOps: async () => ({ ok: true }),
      isTauriRuntime: false,
    });
    expect(resolved.source).toBe('injected-applyOps');
    const { events, unsub } = collectWritten();
    const r = await resolved.applyOps!('[{"op":"insert"}]', {
      intentId: 'inj-1',
    });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(0);
    unsub();
  });
});
