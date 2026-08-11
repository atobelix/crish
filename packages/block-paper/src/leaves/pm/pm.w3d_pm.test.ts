/**
 * W3-D-PM Strict · 真 ProseMirror 叶适配器单测
 *
 * 验收（09 / 05）：
 * - 真 import prosemirror-model / state / view
 * - inline schema + EditorState
 * - dispatchTransaction / applyLocalEdit → TextEditIntent
 * - Intent → mock sink 记录（sink 仍 mock；**≠ W3-D 真 apply**）
 * - composing 边界：合成期不发 Intent；flush 后进 sink
 *
 * **轨**：W3-D-PM 完成 ≠ W3-D ≠ EL-01
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { TextEditIntent } from '@crish/block-paper-contract';
import { ImeMachine } from '@crish/editor-kit';

import {
  leafInlineSchema,
  textToLeafDoc,
  leafDocToText,
  textOffsetToPmPos,
  pmPosToTextOffset,
  PmTextLeaf,
  diffToReplace,
  isPmTextLeaf,
  PmTextLeafHost,
  createPmLeafEditorState,
  isPmTextLeafHost,
} from './index';
import { createMockIntentSink, submitIntent } from '../intentBridge';
import {
  TextLeafModel,
  nextIntentId,
  resetIntentIdSeqForTests,
} from '../TextLeafModel';

// ---------------------------------------------------------------------------
// 依赖接线：真实 prosemirror-* 可 import
// ---------------------------------------------------------------------------

describe('W3-D-PM 依赖接线（prosemirror-*）', () => {
  it('真实 import model/state/view，Schema 与 EditorState 可构造', () => {
    expect(Schema).toBeTruthy();
    expect(EditorState).toBeTruthy();
    expect(EditorView).toBeTruthy();
    expect(leafInlineSchema).toBeInstanceOf(Schema);

    const state = EditorState.create({
      doc: textToLeafDoc('hello pm', leafInlineSchema),
      schema: leafInlineSchema,
    });
    expect(state.doc.textContent).toBe('hello pm');
    expect(state.schema).toBe(leafInlineSchema);
  });

  it('createPmLeafEditorState：无 DOM 可构造活动叶 state', () => {
    const state = createPmLeafEditorState('abc');
    expect(state.doc.textContent).toBe('abc');
    expect(leafDocToText(state.doc)).toBe('abc');
  });

  it('leafInlineSchema 仅为 inline 叶（单 paragraph，无嵌套块）', () => {
    const doc = textToLeafDoc('x', leafInlineSchema);
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild?.type.name).toBe('paragraph');
    // 不允许在叶内再挂 paragraph 为顶层 content 之外的块
    const para = leafInlineSchema.nodes.paragraph;
    const text = leafInlineSchema.nodes.text;
    expect(para).toBeDefined();
    expect(text).toBeDefined();
    expect(para!.isBlock).toBe(true);
    expect(text!.isText).toBe(true);
  });

  it('textOffset ↔ pmPos 往返（纯 text）', () => {
    const doc = textToLeafDoc('abcd', leafInlineSchema);
    for (let o = 0; o <= 4; o++) {
      const pos = textOffsetToPmPos(doc, o);
      expect(pmPosToTextOffset(doc, pos)).toBe(o);
    }
  });
});

// ---------------------------------------------------------------------------
// PmTextLeaf：dispatch → Intent
// ---------------------------------------------------------------------------

describe('PmTextLeaf（dispatchTransaction → TextEditIntent）', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('构造持有 blockId + 真 EditorState plain 投影', () => {
    const leaf = new PmTextLeaf('b-pm-1', 'hello');
    expect(leaf.blockId).toBe('b-pm-1');
    expect(leaf.getText()).toBe('hello');
    expect(leaf.getState()).toBeInstanceOf(EditorState);
    expect(isPmTextLeaf(leaf)).toBe(true);
    expect(leaf.isComposing()).toBe(false);
  });

  it('空 blockId 抛错', () => {
    expect(() => new PmTextLeaf('')).toThrow(/blockId/);
  });

  it('applyLocalEdit 非 composing 产出 TextEditIntent 并更新 PM doc', () => {
    const leaf = new PmTextLeaf('b-1', 'abc', {
      createIntentId: () => nextIntentId('pm'),
    });
    const intent = leaf.applyLocalEdit(1, 2, 'X');
    expect(leaf.getText()).toBe('aXc');
    expect(intent).not.toBeNull();
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-1',
      range: [1, 2],
      insert: 'X',
    } satisfies Partial<TextEditIntent>);
    expect(intent!.intentId).toBeTruthy();
  });

  it('dispatchTransaction：insertText 事务 → Intent', () => {
    const leaf = new PmTextLeaf('b-2', 'ab');
    const from = textOffsetToPmPos(leaf.getDoc(), 2);
    const tr = leaf.getState().tr.insertText('!', from, from);
    const intent = leaf.dispatchTransaction(tr);
    expect(leaf.getText()).toBe('ab!');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-2',
      range: [2, 2],
      insert: '!',
    });
  });

  it('composing 时 applyLocalEdit 更新 PM 但不发 Intent', () => {
    const leaf = new PmTextLeaf('b-1', 'ab');
    leaf.beginComposition(1);
    expect(leaf.isComposing()).toBe(true);

    const r1 = leaf.applyLocalEdit(1, 1, '你');
    expect(r1).toBeNull();
    expect(leaf.getText()).toBe('a你b');

    const r2 = leaf.applyLocalEdit(1, 2, '你好');
    expect(r2).toBeNull();
    expect(leaf.getText()).toBe('a你好b');
  });

  it('flushOnCompositionEnd 产出覆盖合成区间的 text_edit', () => {
    const leaf = new PmTextLeaf('b-1', 'ab');
    leaf.beginComposition(1);
    leaf.applyLocalEdit(1, 1, '中');
    leaf.applyLocalEdit(1, 2, '中文');

    const intent = leaf.flushOnCompositionEnd();
    expect(leaf.isComposing()).toBe(false);
    expect(leaf.getText()).toBe('a中文b');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'b-1',
      range: [1, 1],
      insert: '中文',
    });
  });

  it('cancelComposition 回滚 PM doc 且不发 Intent', () => {
    const leaf = new PmTextLeaf('b-1', 'base');
    leaf.beginComposition(4);
    leaf.applyLocalEdit(4, 4, 'XXX');
    expect(leaf.getText()).toBe('baseXXX');
    leaf.cancelComposition();
    expect(leaf.isComposing()).toBe(false);
    expect(leaf.getText()).toBe('base');
  });

  it('replaceFromProjection composing 期拒绝', () => {
    const leaf = new PmTextLeaf('b-1', 'old');
    expect(leaf.replaceFromProjection('new')).toBe(true);
    expect(leaf.getText()).toBe('new');
    leaf.beginComposition(0);
    expect(leaf.replaceFromProjection('remote')).toBe(false);
    expect(leaf.getText()).toBe('new');
  });

  it('diffToReplace 收敛前后缀', () => {
    expect(diffToReplace('abc', 'aXc')).toEqual({
      start: 1,
      end: 2,
      insert: 'X',
    });
    expect(diffToReplace('ab', 'ab!')).toEqual({
      start: 2,
      end: 2,
      insert: '!',
    });
  });
});

// ---------------------------------------------------------------------------
// 端到端：PM → Intent → mock sink（≠ 真 apply）
// ---------------------------------------------------------------------------

describe('W3-D-PM 端到端：PM 编辑 → Intent → mock sink', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('leaf apply → submitIntent → mock sink 记录 text_edit', async () => {
    const leaf = new PmTextLeaf('leaf-pm', 'Hello');
    const mock = createMockIntentSink();
    const intent = leaf.applyLocalEdit(5, 5, '!');
    expect(intent).not.toBeNull();
    const r = await submitIntent(intent!, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      type: 'text_edit',
      blockId: 'leaf-pm',
      insert: '!',
      range: [5, 5],
    });
    expect(leaf.getText()).toBe('Hello!');
    // 诚实：mock sink ≠ DocSession::apply
    expect(mock.calls[0]).not.toHaveProperty('apply');
  });

  it('composing：flush 后才进 sink；期间 op 被拒（对齐 TextLeaf 纪律）', async () => {
    const leaf = new PmTextLeaf('leaf-pm', 'a');
    const mock = createMockIntentSink();
    const ime = new ImeMachine();

    ime.startComposition('leaf-pm');
    leaf.beginComposition(1);

    expect(leaf.applyLocalEdit(1, 1, '你')).toBeNull();

    const opR = await submitIntent(
      { type: 'op', ops: [{ kind: 'split_block' }], intentId: 'x' },
      mock.sink,
      { ime }
    );
    expect(opR.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);

    ime.endComposition('你');
    const flushed = leaf.flushOnCompositionEnd('你');
    expect(flushed).not.toBeNull();
    const r = await submitIntent(flushed!, mock.sink, { ime });
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      type: 'text_edit',
      insert: '你',
      range: [1, 1],
    });
  });

  it('plain TextLeafModel 仍可用（W3-D-S 保留）', () => {
    const plain = new TextLeafModel('plain-1', 'x');
    const intent = plain.applyLocalEdit(1, 1, 'y');
    expect(intent?.type).toBe('text_edit');
    expect(plain.getText()).toBe('xy');
  });
});

// ---------------------------------------------------------------------------
// PmTextLeafHost（DOM 可用时）
// ---------------------------------------------------------------------------

function canCreateDomParent(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.createElement) {
    return null;
  }
  try {
    const el = document.createElement('div');
    if (typeof el.appendChild !== 'function') return null;
    return el;
  } catch {
    return null;
  }
}

describe('PmTextLeafHost（DOM）', () => {
  const parentProbe = canCreateDomParent();
  const maybeIt = parentProbe ? it : it.skip;

  let host: PmTextLeafHost | null = null;

  beforeEach(() => {
    resetIntentIdSeqForTests();
    host = null;
  });

  afterEach(() => {
    host?.destroy();
    host = null;
  });

  maybeIt('挂载 EditorView；applyLocalEdit → onIntent', () => {
    const el = canCreateDomParent()!;
    const intents: TextEditIntent[] = [];
    const leaf = new PmTextLeaf('h-1', 'hi');
    host = new PmTextLeafHost(el, {
      leaf,
      onIntent: (i) => intents.push(i),
    });
    expect(isPmTextLeafHost(host)).toBe(true);
    expect(host.getView()).toBeInstanceOf(EditorView);
    expect(host.getText()).toBe('hi');

    const intent = host.applyLocalEdit(2, 2, '!');
    expect(intent).toMatchObject({ insert: '!', range: [2, 2] });
    expect(intents).toHaveLength(1);
    expect(host.getText()).toBe('hi!');
  });

  maybeIt('Host onIntent → mock sink 通路', async () => {
    const el = canCreateDomParent()!;
    const mock = createMockIntentSink();
    host = new PmTextLeafHost(el, {
      blockId: 'h-2',
      initialText: 'z',
      onIntent: (intent) => {
        void submitIntent(intent, mock.sink);
      },
    });
    host.applyLocalEdit(1, 1, 'w');
    // submitIntent 异步；微任务冲刷
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mock.calls[0]?.type).toBe('text_edit');
  });
});
