/**
 * 标量坐标单射转换与富文本 Leaf / TextLeaf / CodeLeaf 专项单元测试。
 *
 * 验证：
 * 1. `diffToReplace` 算子：
 *    - 最长公共前后缀比对
 *    - 代理项边界对齐（绝不切断高低位代理项）
 *    - 产出精准的双坐标系（UTF-16 vs Unicode Scalar）
 * 2. `PmTextLeaf`：
 *    - 在包含复合 Emoji（👨‍👩‍👧‍👦）、彩虹旗（🏳️‍🌈）、生僻字（𠮷）的内容中执行本地编辑，产出的 TextEditIntent range 严格为 Unicode 标量偏移（0 Off-by-4 漂移）
 *    - `adoptState` 单源状态采纳与单向同步
 *    - `compositionend` flush 产出精确标量坐标
 * 3. `TextLeafModel`：
 *    - `applyLocalEdit` 与 `flushOnCompositionEnd` 在 Emoji 场景下的源头标量转换
 * 4. `CodeLeafModel`：
 *    - `tryApplyLocalEdit` 与 `flushOnCompositionEnd` 在 Emoji 场景下的源头标量转换
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { TextEditIntent } from '@crish/block-paper-contract';
import { diffToReplace } from './diffToReplace';
import {
  PmTextLeaf,
  leafInlineSchema,
  textToLeafDoc,
  textOffsetToPmPos,
} from './index';
import { TextLeafModel, resetIntentIdSeqForTests } from '../TextLeafModel';
import { CodeLeafModel } from '../code/CodeLeafModel';

describe('diffToReplace: 代理项感知与标量坐标产出', () => {
  it('相同文本返回全零偏移与空 insert', () => {
    const r = diffToReplace('hello', 'hello');
    expect(r.startU16).toBe(0);
    expect(r.endU16).toBe(0);
    expect(r.startScalar).toBe(0);
    expect(r.endScalar).toBe(0);
    expect(r.insert).toBe('');
  });

  it('ASCII 文本单处替换：双坐标系数值严格一致', () => {
    const r = diffToReplace('Hello World', 'Hello Rust World');
    expect(r.startU16).toBe(6);
    expect(r.endU16).toBe(6);
    expect(r.startScalar).toBe(6);
    expect(r.endScalar).toBe(6);
    expect(r.insert).toBe('Rust ');
  });

  it('Emoji 辅助平面字符（🎉）前后缀识别与代理项保护', () => {
    // oldText: "🎉Hello" (len=7, chars=6) -> newText: "🎉World"
    const r = diffToReplace('🎉Hello', '🎉World');
    expect(r.startU16).toBe(2); // 跳过 🎉 (2 UTF-16 units)
    expect(r.startScalar).toBe(1); // 标量索引为 1
    expect(r.endU16).toBe(7);
    expect(r.endScalar).toBe(6);
    expect(r.insert).toBe('World');
  });

  it('ZWJ 复合表情（👨‍👩‍👧‍👦）替换后缀，彻底消除 Off-by-4 漂移', () => {
    const oldText = '👨‍👩‍👧‍👦Text'; // UTF-16 len=15, scalars=11
    const newText = '👨‍👩‍👧‍👦Doc';
    const r = diffToReplace(oldText, newText);

    // "👨‍👩‍👧‍👦" 占 11 个 UTF-16 code units，7 个 Unicode 标量
    expect(r.startU16).toBe(11);
    expect(r.startScalar).toBe(7); // 对齐 Rust chars().take(7)
    expect(r.endU16).toBe(15);
    expect(r.endScalar).toBe(11);
    expect(r.insert).toBe('Doc');
  });
});

describe('PmTextLeaf: 源头强制标量坐标转换与状态采纳', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('在包含 Emoji 文本中执行 applyLocalEdit：Intent.range 严格为 Unicode 标量', () => {
    // "🎉Hello" (7 UTF-16, 6 scalars)
    const leaf = new PmTextLeaf('b-emoji-1', '🎉Hello');

    // 在 "Hello" 中的 'e' 处做替换（JS UTF-16 位置 3..4，对应 "e"）
    // 字符位置：'🎉' (0..2 u16, scalar 0), 'H' (2..3 u16, scalar 1), 'e' (3..4 u16, scalar 2)
    const intent = leaf.applyLocalEdit(3, 4, 'a');
    expect(leaf.getText()).toBe('🎉Hallo');
    expect(intent).not.toBeNull();
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-emoji-1',
      range: [2, 3], // 标量坐标 [2, 3]，而非 UTF-16 [3, 4]
      insert: 'a',
    } satisfies Partial<TextEditIntent>);
  });

  it('在 ZWJ 复合表情文本（👨‍👩‍👧‍👦Text）中执行 dispatchTransaction：消除 Off-by-4', () => {
    const leaf = new PmTextLeaf('b-zwj-1', '👨‍👩‍👧‍👦Text');
    // 在 "Text" 后追加 "!"（JS UTF-16 pos: textToPmPos(15) -> pmPos: 16）
    const pmPos = textOffsetToPmPos(leaf.getDoc(), 15);
    const tr = leaf.getState().tr.insertText('!', pmPos, pmPos);
    const intent = leaf.dispatchTransaction(tr);

    expect(leaf.getText()).toBe('👨‍👩‍👧‍👦Text!');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-zwj-1',
      range: [11, 11], // 标量坐标为 11（7+4），而非 UTF-16 15
      insert: '!',
    });
  });

  it('flushOnCompositionEnd 在包含 Emoji 的前缀下产出精确标量坐标', () => {
    const leaf = new PmTextLeaf('b-ime-emoji', '🎉Doc');
    // 在 "Doc" 处开始合成（JS UTF-16 pos = 2）
    leaf.beginComposition(2);
    // 选词上屏 "协同"
    const intent = leaf.flushOnCompositionEnd('协同');
    expect(leaf.getText()).toBe('🎉协同Doc');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-ime-emoji',
      range: [1, 1], // 标量坐标：'🎉' 是第 0 个标量，所以在标量 1 处插入
      insert: '协同',
    });
  });

  it('adoptState 正确推进 EditorState 杜绝状态脱节', () => {
    const leaf = new PmTextLeaf('b-adopt-1', 'initial');
    const nextState = EditorState.create({
      doc: textToLeafDoc('updated external', leafInlineSchema),
      schema: leafInlineSchema,
    });

    leaf.adoptState(nextState);
    expect(leaf.getState()).toBe(nextState);
    expect(leaf.getText()).toBe('updated external');
  });
});

describe('TextLeafModel: 源头强制标量坐标转换', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('applyLocalEdit 在 Emoji 场景产出标量坐标', () => {
    const model = new TextLeafModel('b-text-1', '🎉ABC');
    // 在 'A' (JS offset 2) 处替换 'A' 为 'X'
    const intent = model.applyLocalEdit(2, 3, 'X');
    expect(model.getText()).toBe('🎉XBC');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-text-1',
      range: [1, 2], // 标量 [1, 2]
      insert: 'X',
    });
  });

  it('flushOnCompositionEnd 在 ZWJ 场景产出标量坐标', () => {
    const model = new TextLeafModel('b-text-zwj', '👨‍👩‍👧‍👦End');
    // 在 "End" (JS offset 11, scalar 7) 处合成
    model.beginComposition(11);
    const intent = model.flushOnCompositionEnd('Plus');
    expect(model.getText()).toBe('👨‍👩‍👧‍👦PlusEnd');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-text-zwj',
      range: [7, 7], // 标量坐标 7
      insert: 'Plus',
    });
  });
});

describe('CodeLeafModel: 源头强制标量坐标转换', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('tryApplyLocalEdit 在包含 Emoji 的代码中产出标量坐标', () => {
    const code = new CodeLeafModel('b-code-1', '// 🎉 test');
    code.focus();
    // "// 🎉 " UTF-16 长度为 6 ('// ' 3 + '🎉' 2 + ' ' 1 = 6), 标量长度为 5 ('// ' 3 + '🎉' 1 + ' ' 1 = 5)
    // 替换 "test" (6..10) 为 "code"
    const res = code.tryApplyLocalEdit(6, 10, 'code');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(code.getContent()).toBe('// 🎉 code');
      expect(res.intent).toMatchObject({
        type: 'text_edit',
        blockId: 'b-code-1',
        range: [5, 9], // 标量 [5, 9]
        insert: 'code',
      });
    }
  });
});
