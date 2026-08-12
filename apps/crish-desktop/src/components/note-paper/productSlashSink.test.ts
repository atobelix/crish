/**
 * CONN-B · 产品 Strict slash 写锥绑定工厂
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 有 applyOps → createCollabApplySink 可写 | EL-01 / A-BLK-02 e2e 满关 |
 * | 无后端 → mode=readonly、sink undefined | mock 当生产默认 |
 * | wireCalls 审计（injected-applyOps） | 桌面 note_apply_ops 产品 IPC 已挂 |
 */
import { describe, expect, it } from 'vitest';
import {
  createCollabApplySink,
  createMockIntentSink,
  submitIntent,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
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
});
