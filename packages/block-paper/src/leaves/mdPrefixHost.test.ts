/**
 * W3-H 产品输入接线测（mdPrefixHost）。
 *
 * ## 可点名
 * 1. 行首 MD 前缀 + 提交 → TurnIntoIntent 进可注入 sink
 * 2. composing=true 拒绝（不进 sink）
 * 3. 与 slash_insert 双通道不互抹
 *
 * ## 非完成
 * - ≠ EL-01；≠ A-BLK-08/09 全表 e2e
 * - ≠ RS 真 turn_into Op（provisional sink 仅 strip + pending 标记）
 * - 不回退 w3h.direction 纯函数测
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { resetIntentIdSeqForTests } from './TextLeafModel';
import {
  buildSlashInsertIntent,
  type SlashInsertIntent,
} from '../chrome/structureIntents';
import { submitIntent } from './intentBridge';
import { isTurnIntoIntent } from './turnInto';
import {
  commitMdPrefixFromLeaf,
  simulateMdPrefixSubmit,
  tryMdPrefixAfterLeafEdit,
  createMockTurnIntoSink,
  createTurnIntoProvisionalCollabSink,
  createProductIntentAuditSinks,
} from './mdPrefixHost';
import { TextLeafModel } from './TextLeafModel';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

// ---------------------------------------------------------------------------
// 1. 行首输入 MD 前缀 + 提交 → sink
// ---------------------------------------------------------------------------

describe('W3-H · mdPrefixHost 产品路径', () => {
  it('w3h_host_md_prefix_submit_to_sink: 行首 #  → turn_into 进 mock sink', async () => {
    const mock = createMockTurnIntoSink();
    const sim = await simulateMdPrefixSubmit(
      {
        blockId: 'blk-host-1',
        prefixText: '# ',
        fromFlavour: 'paragraph',
        createIntentId: () => 'host-md-h1',
      },
      mock.sink
    );

    expect(sim.leafText).toBe('# ');
    expect(sim.wasComposing).toBe(false);
    expect(sim.commit.ok).toBe(true);
    if (!sim.commit.ok) return;

    expect(sim.commit.intent).toMatchObject({
      type: 'turn_into',
      intentId: 'host-md-h1',
      origin: 'keyboard',
      blockIds: ['blk-host-1'],
      flavour: 'heading-1',
      trigger: 'md_prefix',
      stripRange: [0, 2],
      mdPrefix: { ruleId: 'heading-1', matched: '# ' },
      fromFlavour: 'paragraph',
    });
    expect(isTurnIntoIntent(sim.commit.intent)).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(sim.commit.intent);
    expect(sim.commit.strippedText).toBe('');
  });

  it('w3h_host_bullet_after_leaf_edit: applyLocalEdit 后 tryMdPrefixAfterLeafEdit', async () => {
    const leaf = new TextLeafModel('blk-bullet', '');
    const intent = leaf.applyLocalEdit(0, 0, '- ');
    expect(intent?.type).toBe('text_edit');

    const mock = createMockTurnIntoSink();
    const r = await tryMdPrefixAfterLeafEdit(leaf, {
      sink: mock.sink,
      fromFlavour: 'paragraph',
      createIntentId: () => 'host-bullet',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.flavour).toBe('bullet');
    expect(r.intent.stripRange).toEqual([0, 2]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.trigger).toBe('md_prefix');
  });

  it('w3h_host_provisional_collab_sink: turn_into → provisional wire（非真 RS turn_into Op）', async () => {
    const applied: string[] = [];
    const collab = createTurnIntoProvisionalCollabSink(
      async (opsJson, meta) => {
        applied.push(opsJson);
        expect(meta.intentId).toBe('host-prov-1');
        return { ok: true };
      }
    );

    const r = await commitMdPrefixFromLeaf(
      {
        blockId: 'blk-prov',
        text: '> ',
        caretOffset: 2,
        fromFlavour: 'paragraph',
      },
      {
        sink: collab.sink,
        createIntentId: () => 'host-prov-1',
      }
    );

    expect(r.ok).toBe(true);
    expect(collab.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    // provisional：strip text_edit + pending_turn_into_flavour；非独立 turn_into Op
    expect(collab.wireCalls[0]).toContain('"op":"text_edit"');
    expect(collab.wireCalls[0]).toContain('pending_turn_into_flavour');
    expect(collab.wireCalls[0]).toContain('quote');
    expect(collab.wireCalls[0]).not.toContain('"op":"turn_into"');
  });

  // ---------------------------------------------------------------------------
  // 2. composing 拒绝
  // ---------------------------------------------------------------------------

  it('w3h_host_composing_rejects: composing=true 不进 sink', async () => {
    const mock = createMockTurnIntoSink();
    const sim = await simulateMdPrefixSubmit(
      {
        blockId: 'blk-ime',
        prefixText: '# ',
        composing: true,
        fromFlavour: 'paragraph',
      },
      mock.sink
    );

    expect(sim.wasComposing).toBe(true);
    expect(sim.textEditIntentId).toBeNull(); // 合成期 applyLocalEdit 不发 text_edit
    expect(sim.commit.ok).toBe(false);
    if (sim.commit.ok) return;
    expect(sim.commit.stage).toBe('fast_path');
    if (sim.commit.stage === 'fast_path') {
      expect(sim.commit.code).toBe('composing');
      expect(sim.commit.reason).toMatch(/composing|IME|前缀/i);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('w3h_host_composing_snapshot_flag: commitMdPrefixFromLeaf 布尔 isComposing', async () => {
    const mock = createMockTurnIntoSink();
    const r = await commitMdPrefixFromLeaf(
      {
        blockId: 'b',
        text: '- ',
        caretOffset: 2,
        isComposing: true,
      },
      { sink: mock.sink }
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.stage === 'fast_path') {
      expect(r.code).toBe('composing');
    }
    expect(mock.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. 与 slash_insert 不互抹
  // ---------------------------------------------------------------------------

  it('w3h_host_slash_and_md_prefix_no_mutual_erase: 双通道 audit 并列', async () => {
    const dual = createProductIntentAuditSinks();

    // ① slash 路径（与 SlashMenuOverlay 同 submitIntent 通道）
    const slash: SlashInsertIntent = buildSlashInsertIntent({
      blockId: 'blk-shared',
      offset: 0,
      flavour: 'code',
      catalogItemId: 'code',
      createIntentId: () => 'slash-keep',
    });
    const slashSubmit = await submitIntent(slash, dual.paperSink, {
      isComposing: false,
    });
    expect(slashSubmit.ok).toBe(true);

    // ② MD 前缀 turn_into 路径（独立 TurnIntoSink）
    const md = await simulateMdPrefixSubmit(
      {
        blockId: 'blk-shared',
        prefixText: '# ',
        fromFlavour: 'paragraph',
        createIntentId: () => 'md-keep',
      },
      dual.turnIntoSink
    );
    expect(md.commit.ok).toBe(true);

    // ③ 审计：两侧 Intent 均在，顺序保留，互不覆盖
    expect(dual.audit).toHaveLength(2);
    expect(dual.audit[0]).toMatchObject({
      channel: 'paper',
      intent: { type: 'slash_insert', intentId: 'slash-keep', flavour: 'code' },
    });
    expect(dual.audit[1]).toMatchObject({
      channel: 'turn_into',
      intent: {
        type: 'turn_into',
        intentId: 'md-keep',
        flavour: 'heading-1',
        trigger: 'md_prefix',
      },
    });

    // 再补一条 slash：不得抹掉已有 turn_into
    const slash2 = buildSlashInsertIntent({
      blockId: 'blk-shared',
      offset: 1,
      flavour: 'quote',
      catalogItemId: 'quote',
      createIntentId: () => 'slash-2',
    });
    await submitIntent(slash2, dual.paperSink);
    expect(dual.audit).toHaveLength(3);
    const turnEntries = dual.audit.filter((e) => e.channel === 'turn_into');
    const slashEntries = dual.audit.filter((e) => e.channel === 'paper');
    expect(turnEntries).toHaveLength(1);
    expect(slashEntries).toHaveLength(2);
    expect(turnEntries[0]!.intent.intentId).toBe('md-keep');
  });
});
