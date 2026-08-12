/**
 * W3-H 方向子集测（MD 前缀 / turn-into / 未知 flavour 占位）。
 *
 * ## 可点名
 * - A-BLK-09 方向：MD 前缀快路径 + **composing 禁止**
 * - A-BLK-08 方向：turn-into Intent 形状 + 逻辑选区钳制
 * - A-BLK-11 方向：未知 flavour 占位快照（View 半；wire 半见 chrome.a_blk）
 *
 * ## 明确非完成
 * - ≠ A-BLK 全表 e2e
 * - ≠ EL-01 / 块工作区完成
 * - ≠ RS 独立 turn_into Op 真 apply
 * - 不回退 W3-D / W3-F collab apply 测
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  flavourToCollabKind,
  assertCollabOpsWire,
} from '@crish/block-paper-contract';
import { guardStructureIntent } from '@crish/editor-kit';
import { resetIntentIdSeqForTests, nextIntentId } from './TextLeafModel';
import {
  matchMdPrefix,
  shouldTriggerMdPrefix,
  stripMdPrefix,
  firstLineOf,
  mdPrefixRuleCount,
} from './mdPrefix';
import {
  buildTurnIntoIntent,
  isTurnIntoIntent,
  clampLogicalSelection,
  tryMdPrefixFastPath,
  submitTurnIntoIntent,
  turnIntoToStructureKey,
  turnIntoIntentToProvisionalOps,
  turnIntoStripToTextEdit,
  type TurnIntoIntent,
} from './turnInto';
import {
  createUnknownFlavourPlaceholder,
  tryCreateUnknownFlavourPlaceholder,
  isUnknownFlavour,
  isUnknownCollabKind,
  placeholderWithText,
} from './unknownFlavourPlaceholder';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

// ---------------------------------------------------------------------------
// MD 前缀匹配（纯函数）
// ---------------------------------------------------------------------------

describe('W3-H · mdPrefix 匹配', () => {
  it('w3h_md_prefix_heading: #…###### 映射 heading-N', () => {
    expect(matchMdPrefix('# title')).toMatchObject({
      ruleId: 'heading-1',
      flavour: 'heading-1',
      prefixLength: 2,
      matched: '# ',
    });
    expect(matchMdPrefix('## x')).toMatchObject({
      ruleId: 'heading-2',
      flavour: 'heading-2',
      prefixLength: 3,
    });
    expect(matchMdPrefix('### x')).toMatchObject({ flavour: 'heading-3' });
    expect(matchMdPrefix('###### x')).toMatchObject({
      flavour: 'heading-6',
      prefixLength: 7,
    });
    // 无尾随空格不触发
    expect(matchMdPrefix('#nope')).toBeNull();
  });

  it('w3h_md_prefix_list_quote_task: -/* / 1. / > / 任务', () => {
    expect(matchMdPrefix('- item')).toMatchObject({
      ruleId: 'bullet',
      flavour: 'bullet',
      matched: '- ',
    });
    expect(matchMdPrefix('* item')).toMatchObject({ flavour: 'bullet' });
    expect(matchMdPrefix('1. item')).toMatchObject({
      ruleId: 'ordered',
      flavour: 'ordered',
    });
    expect(matchMdPrefix('12) item')).toMatchObject({ flavour: 'ordered' });
    expect(matchMdPrefix('> quote')).toMatchObject({
      ruleId: 'quote',
      flavour: 'quote',
    });
    expect(matchMdPrefix('- [ ] todo')).toMatchObject({
      ruleId: 'task_todo',
      flavour: 'task',
    });
    expect(matchMdPrefix('- [x] done')).toMatchObject({
      ruleId: 'task_done',
      flavour: 'task',
    });
    // 任务优先于 bullet
    const task = matchMdPrefix('- [ ] x')!;
    expect(task.prefixLength).toBeGreaterThan(2);
  });

  it('w3h_md_prefix_code_divider_first_line', () => {
    expect(matchMdPrefix('```')).toMatchObject({
      ruleId: 'code_fence',
      flavour: 'code',
    });
    expect(matchMdPrefix('```ts')).toMatchObject({ flavour: 'code' });
    expect(matchMdPrefix('---')).toMatchObject({
      ruleId: 'divider',
      flavour: 'divider',
    });
    // 多行只看第一行
    expect(firstLineOf('# h\nbody')).toBe('# h');
    expect(matchMdPrefix('# h\nbody')).toMatchObject({ flavour: 'heading-1' });
    expect(stripMdPrefix('# h\nbody', matchMdPrefix('# h\nbody')!)).toBe(
      'h\nbody'
    );
    expect(mdPrefixRuleCount()).toBeGreaterThanOrEqual(10);
  });

  it('w3h_md_prefix_caret_strict: 仅 caret=prefixLength 触发', () => {
    const text = '# ';
    expect(shouldTriggerMdPrefix(text, 2)).toMatchObject({
      flavour: 'heading-1',
    });
    // caret 在文中更后：严格模式不触发（避免中途误转）
    expect(shouldTriggerMdPrefix('# hello', 7)).toBeNull();
    // 宽松可触发
    expect(shouldTriggerMdPrefix('# hello', 7, { loose: true })).toMatchObject({
      flavour: 'heading-1',
    });
    expect(shouldTriggerMdPrefix('plain', 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// turn-into + MD 快路径 + composing
// ---------------------------------------------------------------------------

describe('W3-H · turn-into / MD 快路径', () => {
  it('w3h_turn_into_shape: buildTurnIntoIntent 字段钉死', () => {
    const intent = buildTurnIntoIntent({
      blockIds: ['b1', 'b1', 'b2'],
      flavour: 'heading-1',
      trigger: 'menu',
      logicalSelection: { blockId: 'b1', anchor: 2, head: 5 },
      createIntentId: () => 'turn-shape-1',
    });
    expect(isTurnIntoIntent(intent)).toBe(true);
    expect(intent).toEqual({
      type: 'turn_into',
      intentId: 'turn-shape-1',
      origin: 'chrome',
      blockIds: ['b1', 'b2'],
      flavour: 'heading-1',
      trigger: 'menu',
      logicalSelection: { blockId: 'b1', anchor: 2, head: 5 },
    } satisfies TurnIntoIntent);
    expect(isTurnIntoIntent({ type: 'slash_insert' })).toBe(false);
    expect(isTurnIntoIntent(null)).toBe(false);
  });

  it('w3h_a_blk_08_selection_clamp: 剥前缀后逻辑选区钳制', () => {
    const sel = clampLogicalSelection(
      { blockId: 'b', anchor: 4, head: 7 },
      /* newTextLength */ 5,
      /* strip */ 2
    );
    // 4-2=2, 7-2=5 → clamp head to 5
    expect(sel).toEqual({ blockId: 'b', anchor: 2, head: 5 });
    // 越界钳到 0..len
    expect(
      clampLogicalSelection({ blockId: 'b', anchor: -3, head: 99 }, 3, 0)
    ).toEqual({ blockId: 'b', anchor: 0, head: 3 });
  });

  it('w3h_a_blk_09_md_prefix_fast_path: # → turn_into + stripRange', () => {
    const r = tryMdPrefixFastPath({
      blockId: 'blk-h',
      text: '# ',
      caretOffset: 2,
      fromFlavour: 'paragraph',
      createIntentId: () => 'md-h1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.match.flavour).toBe('heading-1');
    expect(r.strippedText).toBe('');
    expect(r.intent).toMatchObject({
      type: 'turn_into',
      intentId: 'md-h1',
      origin: 'keyboard',
      blockIds: ['blk-h'],
      flavour: 'heading-1',
      trigger: 'md_prefix',
      stripRange: [0, 2],
      mdPrefix: { ruleId: 'heading-1', matched: '# ' },
      fromFlavour: 'paragraph',
    });
    expect(r.logicalSelection).toEqual({
      blockId: 'blk-h',
      anchor: 0,
      head: 0,
    });
  });

  it('w3h_a_blk_09_md_prefix_bullet_and_quote', () => {
    const bullet = tryMdPrefixFastPath({
      blockId: 'b',
      text: '- ',
      caretOffset: 2,
      createIntentId: () => nextIntentId('md'),
    });
    expect(bullet.ok).toBe(true);
    if (bullet.ok) {
      expect(bullet.intent.flavour).toBe('bullet');
      expect(bullet.intent.stripRange).toEqual([0, 2]);
    }

    const quote = tryMdPrefixFastPath({
      blockId: 'q',
      text: '> ',
      caretOffset: 2,
    });
    expect(quote.ok).toBe(true);
    if (quote.ok) expect(quote.intent.flavour).toBe('quote');
  });

  it('w3h_a_blk_09_composing_forbids_md_prefix: composing 禁止前缀转块', () => {
    const r = tryMdPrefixFastPath({
      blockId: 'b-ime',
      text: '# ',
      caretOffset: 2,
      isComposing: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing');
      expect(r.reason).toMatch(/composing|IME|前缀/i);
    }

    // 回调形式同样拒绝
    const r2 = tryMdPrefixFastPath({
      blockId: 'b-ime',
      text: '- ',
      caretOffset: 2,
      isComposing: () => true,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('composing');
  });

  it('w3h_a_blk_09_composing_submit_turn_into: submit 再守卫', async () => {
    const intent = buildTurnIntoIntent({
      blockIds: ['b1'],
      flavour: 'quote',
      trigger: 'menu',
      createIntentId: () => 't-submit',
    });
    const calls: TurnIntoIntent[] = [];
    const sink = async (i: TurnIntoIntent) => {
      calls.push(i);
      return { ok: true };
    };

    const rejected = await submitTurnIntoIntent(intent, sink, {
      isComposing: true,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('composing');
    expect(calls).toHaveLength(0);

    const ok = await submitTurnIntoIntent(intent, sink, {
      isComposing: false,
    });
    expect(ok.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(intent);
  });

  it('w3h_turn_into_structure_key_guard: 复用 editor-kit composing 拒 turn_into', () => {
    const intent = buildTurnIntoIntent({
      blockIds: ['b1'],
      flavour: 'heading-2',
      createIntentId: () => 't-key',
    });
    const key = turnIntoToStructureKey(intent);
    expect(key).toEqual({
      type: 'structure_key',
      kind: 'turn_into',
      blockId: 'b1',
      intentId: 't-key',
    });

    const idle = guardStructureIntent(false, key);
    expect(idle.ok).toBe(true);

    const composing = guardStructureIntent(true, key);
    expect(composing.ok).toBe(false);
    if (!composing.ok) {
      expect(composing.code).toBe('composing_structure_key');
    }
  });

  it('w3h_turn_into_provisional_ops: strip text_edit + pending props 标记', () => {
    const intent = buildTurnIntoIntent({
      blockIds: ['b1'],
      flavour: 'heading-1',
      trigger: 'md_prefix',
      stripRange: [0, 2],
      createIntentId: () => 't-ops',
    });
    const ops = turnIntoIntentToProvisionalOps(intent);
    expect(assertCollabOpsWire(ops)).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      op: 'text_edit',
      id: 'b1',
      start: 0,
      end: 2,
      insert: '',
    });
    expect(ops[1]).toMatchObject({
      op: 'update_props',
      id: 'b1',
    });
    const strip = turnIntoStripToTextEdit(intent, () => 'strip-1');
    expect(strip).toMatchObject({
      type: 'text_edit',
      blockId: 'b1',
      range: [0, 2],
      insert: '',
      intentId: 'strip-1',
    });
  });

  it('w3h_md_prefix_same_flavour_and_no_match', () => {
    const same = tryMdPrefixFastPath({
      blockId: 'b',
      text: '# ',
      caretOffset: 2,
      fromFlavour: 'heading-1',
    });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.code).toBe('same_flavour');

    const none = tryMdPrefixFastPath({
      blockId: 'b',
      text: 'hello',
      caretOffset: 5,
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe('no_match');

    // 有前缀但 caret 未就位
    const early = tryMdPrefixFastPath({
      blockId: 'b',
      text: '# hello',
      caretOffset: 7,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.code).toBe('no_match');
      expect(early.match?.flavour).toBe('heading-1');
    }
  });
});

// ---------------------------------------------------------------------------
// 未知 flavour 占位（A-BLK-11 View 方向）
// ---------------------------------------------------------------------------

describe('W3-H · unknown flavour 占位', () => {
  it('w3h_a_blk_11_placeholder: 未知 flavour 可恢复快照不丢文本/id', () => {
    expect(isUnknownFlavour('callout-ext')).toBe(true);
    expect(isUnknownFlavour('paragraph')).toBe(false);
    expect(isUnknownCollabKind(flavourToCollabKind('my_plugin'))).toBe(true);

    const snap = createUnknownFlavourPlaceholder({
      blockId: 'u-1',
      flavour: 'callout-ext',
      text: '保留正文',
      props: { color: 'amber' },
    });
    expect(snap).toMatchObject({
      blockId: 'u-1',
      flavour: 'callout-ext',
      text: '保留正文',
      kindWire: { unknown: { flavour: 'callout-ext' } },
      displayTitle: 'callout-ext',
      badge: '未知块',
      recoverable: true,
      preservedProps: { color: 'amber' },
    });

    // 文本更新不可变且不丢 id/flavour
    const next = placeholderWithText(snap, '新正文');
    expect(next.text).toBe('新正文');
    expect(next.blockId).toBe('u-1');
    expect(next.kindWire).toEqual({ unknown: { flavour: 'callout-ext' } });
    expect(snap.text).toBe('保留正文');
  });

  it('w3h_a_blk_11_try_create: 已知 flavour 返回 null；未知返回占位', () => {
    expect(
      tryCreateUnknownFlavourPlaceholder({
        blockId: 'k',
        flavour: 'paragraph',
        text: 'x',
      })
    ).toBeNull();
    expect(
      tryCreateUnknownFlavourPlaceholder({
        blockId: 'u',
        flavour: 'widget-xyz',
        text: 'payload',
      })
    ).toMatchObject({
      blockId: 'u',
      flavour: 'widget-xyz',
      text: 'payload',
      recoverable: true,
    });
  });
});
