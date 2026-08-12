/**
 * CONN-D2 · 桌面 mdPrefix 叶输入接线
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 有 applyOps → provisional collab 可写；wireCalls 含 pending | EL-01 / A-BLK-08/09 e2e 满关 |
 * | 无后端 → mode=disabled、sink undefined | 库 mdPrefixHost 单测 = 桌面接线完成 |
 * | composing 双守卫不进 sink | provisional 属性 = 真 kind UI |
 * | 桌面产品路径调用 commitMdPrefixFromLeaf | 打开完成 / HiddenInput PM 全链 |
 */
import { describe, expect, it } from 'vitest';
import {
  createMockTurnIntoSink,
  TextLeafModel,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
import {
  commitProductMdPrefixFromLeaf,
  commitProductMdPrefixFromPlainText,
  createProductMdPrefixBinding,
  resolveStrictMdPrefixBinding,
  tryProductMdPrefixAfterLeafEdit,
} from './noteMdPrefixBridge';

describe('createProductMdPrefixBinding · CONN-D2', () => {
  it('conn_d2_no_backend_defaults_to_disabled', () => {
    const b = createProductMdPrefixBinding();
    expect(b.mode).toBe('disabled');
    expect(b.sink).toBeUndefined();
    expect(b.collab).toBeNull();
    expect(b.source).toBe('none');
  });

  it('conn_d2_applyOps_creates_provisional_writable_sink_with_pending_wire', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson, meta) => {
      applied.push(opsJson);
      expect(meta.intentId).toBe('conn-d2-h1');
      return { ok: true };
    };
    const b = createProductMdPrefixBinding({ applyOps });
    expect(b.mode).toBe('writable');
    expect(b.source).toBe('injected-applyOps');
    expect(b.sink).toBeTypeOf('function');
    expect(b.collab).not.toBeNull();
    expect(b.collab!.wireCalls).toHaveLength(0);

    const r = await commitProductMdPrefixFromPlainText({
      blockId: 'blk-conn-d2-1',
      text: '# ',
      fromFlavour: 'paragraph',
      binding: b,
      createIntentId: () => 'conn-d2-h1',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent).toMatchObject({
      type: 'turn_into',
      flavour: 'heading-1',
      trigger: 'md_prefix',
      blockIds: ['blk-conn-d2-1'],
      intentId: 'conn-d2-h1',
    });

    // wireCalls 可见 pending / TurnInto 产品形状（strip + pending；非独立 turn_into JSON）
    expect(b.collab!.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(b.collab!.wireCalls[0]).toContain('"op":"text_edit"');
    expect(b.collab!.wireCalls[0]).toContain('pending_turn_into_flavour');
    expect(b.collab!.wireCalls[0]).toContain('heading-1');
    expect(b.collab!.wireCalls[0]).not.toContain('"op":"turn_into"');
    // 不是 mock 形状
    expect('calls' in (b.collab as object)).toBe(false);
  });

  it('conn_d2_injected_sink_preferred_over_applyOps', async () => {
    const mock = createMockTurnIntoSink();
    const applyOps: ApplyOpsAdapter = async () => {
      throw new Error('should not call applyOps when sink injected');
    };
    const b = createProductMdPrefixBinding({
      turnIntoSink: mock.sink,
      applyOps,
    });
    expect(b.mode).toBe('writable');
    expect(b.source).toBe('injected-sink');
    expect(b.collab).toBeNull();

    const r = await commitProductMdPrefixFromLeaf(
      {
        blockId: 'a',
        text: '- ',
        caretOffset: 2,
        fromFlavour: 'paragraph',
      },
      b,
      { createIntentId: () => 'pref-sink-md' }
    );
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.flavour).toBe('bullet');
  });

  it('conn_d2_disabled_commit_rejects_without_wire', async () => {
    const b = createProductMdPrefixBinding();
    const r = await commitProductMdPrefixFromPlainText({
      blockId: 'blk-ro',
      text: '# ',
      binding: b,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.stage).toBe('product');
    if (r.stage === 'product') {
      expect(r.code).toBe('disabled');
    }
  });
});

describe('commitProductMdPrefixFromLeaf · composing 双守卫', () => {
  it('conn_d2_composing_true_rejects_no_wireCalls', async () => {
    const applied: string[] = [];
    const b = createProductMdPrefixBinding({
      applyOps: async (opsJson) => {
        applied.push(opsJson);
        return { ok: true };
      },
    });

    const r = await commitProductMdPrefixFromLeaf(
      {
        blockId: 'blk-ime',
        text: '# ',
        caretOffset: 2,
        isComposing: true,
        fromFlavour: 'paragraph',
      },
      b,
      { createIntentId: () => 'ime-block' }
    );

    expect(r.ok).toBe(false);
    if (!r.ok && r.stage === 'fast_path') {
      expect(r.code).toBe('composing');
    }
    expect(b.collab!.wireCalls).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it('conn_d2_composing_callback_rejects', async () => {
    const mock = createMockTurnIntoSink();
    const b = createProductMdPrefixBinding({ turnIntoSink: mock.sink });
    let composing = true;
    const r = await commitProductMdPrefixFromLeaf(
      {
        blockId: 'blk-ime2',
        text: '> ',
        caretOffset: 2,
        isComposing: () => composing,
      },
      b
    );
    expect(r.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    composing = false;
    const r2 = await commitProductMdPrefixFromLeaf(
      {
        blockId: 'blk-ime2',
        text: '> ',
        caretOffset: 2,
        isComposing: () => composing,
        fromFlavour: 'paragraph',
      },
      b,
      { createIntentId: () => 'after-ime' }
    );
    expect(r2.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('tryProductMdPrefixAfterLeafEdit · 文本叶入口', () => {
  it('conn_d2_text_leaf_after_edit_to_pending_wire', async () => {
    const leaf = new TextLeafModel('blk-leaf', '');
    const edit = leaf.applyLocalEdit(0, 0, '- ');
    expect(edit?.type).toBe('text_edit');
    expect(leaf.isComposing()).toBe(false);

    const applied: string[] = [];
    const b = createProductMdPrefixBinding({
      applyOps: async (opsJson) => {
        applied.push(opsJson);
        return { ok: true };
      },
    });

    const r = await tryProductMdPrefixAfterLeafEdit(leaf, b, {
      fromFlavour: 'paragraph',
      createIntentId: () => 'leaf-bullet',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.flavour).toBe('bullet');
    expect(b.collab!.wireCalls).toHaveLength(1);
    expect(b.collab!.wireCalls[0]).toContain('pending_turn_into_flavour');
    expect(b.collab!.wireCalls[0]).toContain('bullet');
    expect(applied).toHaveLength(1);
  });

  it('conn_d2_text_leaf_composing_no_commit', async () => {
    const leaf = new TextLeafModel('blk-c', '');
    leaf.beginComposition(0);
    leaf.applyLocalEdit(0, 0, '# ');
    expect(leaf.isComposing()).toBe(true);

    const mock = createMockTurnIntoSink();
    const b = createProductMdPrefixBinding({ turnIntoSink: mock.sink });
    const r = await tryProductMdPrefixAfterLeafEdit(leaf, b, {
      fromFlavour: 'paragraph',
    });
    expect(r.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('resolveStrictMdPrefixBinding · UI 诚实标注', () => {
  it('conn_d2_ui_default_disabled_without_sink', () => {
    const ui = resolveStrictMdPrefixBinding({});
    expect(ui.writeMode).toBe('disabled');
    expect(ui.sinkSource).toBe('none');
  });

  it('conn_d2_ui_writable_with_sink', () => {
    const mock = createMockTurnIntoSink();
    const ui = resolveStrictMdPrefixBinding({ turnIntoSink: mock.sink });
    expect(ui.writeMode).toBe('writable');
    expect(ui.sinkSource).toBe('injected-sink');
  });

  it('conn_d2_ui_override_source', () => {
    const mock = createMockTurnIntoSink();
    const ui = resolveStrictMdPrefixBinding({
      turnIntoSink: mock.sink,
      mdPrefixWriteMode: 'writable',
      mdPrefixSinkSource: 'injected-applyOps',
    });
    expect(ui.writeMode).toBe('writable');
    expect(ui.sinkSource).toBe('injected-applyOps');
  });
});

describe('CONN-D2 诚实边界（结构钉）', () => {
  it('conn_d2_honesty_provisional_is_not_kind_op_json', async () => {
    // 钉：产品 wire 是 strip+pending，**不是**独立 turn_into Op JSON
    // UI 不得把 pending 当 kind；本测 **不**关 A-BLK-08/EL-01
    const b = createProductMdPrefixBinding({
      applyOps: async () => ({ ok: true }),
    });
    const r = await commitProductMdPrefixFromPlainText({
      blockId: 'honesty',
      text: '# ',
      fromFlavour: 'paragraph',
      binding: b,
      createIntentId: () => 'honesty-1',
    });
    expect(r.ok).toBe(true);
    const wire = b.collab!.wireCalls[0]!;
    expect(wire).toContain('pending_turn_into_flavour');
    expect(wire).not.toContain('"op":"turn_into"');
  });
});
