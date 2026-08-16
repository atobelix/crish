/**
 * CONN-B / B3 · 产品 Strict slash 写锥绑定工厂
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 有 applyOps → createCollabApplySink 可写 | EL-01 / A-BLK-02 e2e 满关 |
 * | 无后端 → mode=readonly、sink undefined | mock 当生产默认 |
 * | wireCalls 审计（injected-applyOps / product-ipc） | 假关 EL |
 * | CONN-B3 product-ipc sourceLabel | 无 IPC 仍默认可写 |
 * | R2-b ⑥ apply 拒绝 → 块域编辑会话 invalidate('collab-conflict') | 静默 LWW / 自动合并 |
 */
import { describe, expect, it } from 'vitest';
import {
  createCollabApplySink,
  createMockIntentSink,
  submitIntent,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
import {
  defaultEditSessionRegistry,
  isEditSessionOpen,
  openEditSession,
} from '../../api/editSession';
import {
  createMockNoteApplyOpsIpc,
  resolveProductStrictApplyOps,
} from '../../api/noteApplyOpsIpc';
import { createProductStrictSlashBinding } from './productSlashSink';

const ID_NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('createProductStrictSlashBinding · CONN-B', () => {
  it('conn_b_no_backend_defaults_to_readonly', () => {
    const b = createProductStrictSlashBinding();
    expect(b.mode).toBe('readonly');
    expect(b.sink).toBeUndefined();
    expect(b.collab).toBeNull();
    expect(b.source).toBe('none');
  });

  it('conn_b_applyOps_creates_collab_writable_sink', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const b = createProductStrictSlashBinding({
      applyOps,
      allocateId: () => ID_NEW,
      resolveOrder: () => 'a0',
    });
    expect(b.mode).toBe('writable');
    expect(b.source).toBe('injected-applyOps');
    expect(b.sink).toBeTypeOf('function');
    expect(b.collab).not.toBeNull();
    expect(b.collab!.wireCalls).toHaveLength(0);

    const intent = {
      type: 'slash_insert' as const,
      blockId: 'anchor-1',
      offset: 0,
      flavour: 'paragraph',
      catalogItemId: 'paragraph',
      origin: 'slash' as const,
      intentId: 'conn-b-slash-1',
    };
    const r = await submitIntent(intent, b.sink!);
    expect(r.ok).toBe(true);
    expect(b.collab!.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"insert"');
    expect(applied[0]).toContain(ID_NEW);
    // 不是 mock 形状
    expect('calls' in (b.collab as object)).toBe(false);
  });

  it('conn_b_injected_sink_preferred_over_applyOps', async () => {
    const mock = createMockIntentSink();
    const applyOps: ApplyOpsAdapter = async () => {
      throw new Error('should not call applyOps when sink injected');
    };
    const b = createProductStrictSlashBinding({
      slashIntentSink: mock.sink,
      applyOps,
    });
    expect(b.mode).toBe('writable');
    expect(b.source).toBe('injected-sink');
    expect(b.collab).toBeNull();

    await submitIntent(
      {
        type: 'text_edit',
        blockId: 'a',
        range: [0, 0],
        insert: 'x',
        intentId: 'pref-sink',
      },
      b.sink!
    );
    expect(mock.calls).toHaveLength(1);
  });

  it('conn_b_shape_matches_createCollabApplySink_factory', () => {
    const applyOps: ApplyOpsAdapter = async () => ({ ok: true });
    const direct = createCollabApplySink({ applyOps });
    const viaProduct = createProductStrictSlashBinding({ applyOps });
    expect(viaProduct.mode).toBe('writable');
    expect(typeof viaProduct.sink).toBe('function');
    expect(typeof direct.sink).toBe('function');
    expect(viaProduct.collab).not.toBeNull();
    expect(Array.isArray(viaProduct.collab!.wireCalls)).toBe(true);
  });

  it('conn_b3_product_ipc_sourceLabel_and_wireCalls', async () => {
    const mockIpc = createMockNoteApplyOpsIpc();
    const resolved = resolveProductStrictApplyOps({
      docId: 'slash-ipc-doc',
      applyOpsIpc: mockIpc,
      isTauriRuntime: false,
    });
    expect(resolved.source).toBe('product-ipc');

    const b = createProductStrictSlashBinding({
      applyOps: resolved.applyOps!,
      sourceLabel: 'product-ipc',
      allocateId: () => ID_NEW,
      resolveOrder: () => 'a0',
    });
    expect(b.mode).toBe('writable');
    expect(b.source).toBe('product-ipc');
    expect(b.collab).not.toBeNull();
    expect(b.collab!.wireCalls).toHaveLength(0);

    const r = await submitIntent(
      {
        type: 'slash_insert' as const,
        blockId: 'anchor-1',
        offset: 0,
        flavour: 'paragraph',
        catalogItemId: 'paragraph',
        origin: 'slash' as const,
        intentId: 'conn-b3-slash-1',
      },
      b.sink!
    );
    expect(r.ok).toBe(true);
    expect(b.collab!.wireCalls.length).toBeGreaterThanOrEqual(1);
    expect(b.collab!.wireCalls[0]).toContain('"op":"insert"');
    expect(mockIpc.calls).toHaveLength(1);
    expect(mockIpc.calls[0]?.docId).toBe('slash-ipc-doc');
    expect(mockIpc.calls[0]?.opsJson).toContain('"op":"insert"');
  });

  it('conn_b_apply_rejected_invalidates_block_edit_sessions', async () => {
    // R2-b ⑥ 宿主接线（主控裁决②）：apply 拒绝（ok:false）→ 块域编辑会话
    // invalidate('collab-conflict')——不自动合并、不静默 LWW
    const applyOps: ApplyOpsAdapter = async () => ({
      ok: false,
      reason: 'doc rev conflict',
    });
    const b = createProductStrictSlashBinding({
      applyOps,
      allocateId: () => ID_NEW,
      resolveOrder: () => 'a0',
    });
    try {
      // 块域编辑会话：模拟本地编辑持有中
      openEditSession('anchor-1');
      openEditSession('blk-a');
      openEditSession('blk-b');
      expect(isEditSessionOpen('anchor-1')).toBe(true);

      // 单块意图（slash_insert）拒绝 → 锚点块会话失效（hadSession=true 广播）
      const r = await submitIntent(
        {
          type: 'slash_insert' as const,
          blockId: 'anchor-1',
          offset: 0,
          flavour: 'paragraph',
          catalogItemId: 'paragraph',
          origin: 'slash' as const,
          intentId: 'conn-b-reject-1',
        },
        b.sink!
      );
      expect(r.ok).toBe(false);
      expect(isEditSessionOpen('anchor-1')).toBe(false);

      // 批量意图（delete_blocks）拒绝 → 全部目标块会话失效
      const r2 = await submitIntent(
        {
          type: 'delete_blocks' as const,
          blockIds: ['blk-a', 'blk-b'],
          origin: 'slash' as const,
          intentId: 'conn-b-reject-2',
        },
        b.sink!
      );
      expect(r2.ok).toBe(false);
      expect(isEditSessionOpen('blk-a')).toBe(false);
      expect(isEditSessionOpen('blk-b')).toBe(false);
    } finally {
      defaultEditSessionRegistry.clearAll();
    }
  });
});
