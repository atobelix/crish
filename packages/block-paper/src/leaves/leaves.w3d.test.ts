/**
 * W3-D 叶子 Intent 通路骨架单测：
 * - TextLeafModel：本地编辑 / composing 缓冲 / flush
 * - intentBridge：mock sink + composing 结构拒绝
 * - lineWindow：软阈 64KiB / 行·字符窗口
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ImeMachine } from '@crish/editor-kit';
import type { Intent, TextEditIntent } from '@crish/block-paper-contract';
import {
  TextLeafModel,
  nextIntentId,
  resetIntentIdSeqForTests,
} from './TextLeafModel';
import { createMockIntentSink, submitIntent } from './intentBridge';
import {
  DEFAULT_PM_NODE_SOFT_BYTES,
  computeLineWindow,
  getLineWindowSlice,
  getOffsetWindow,
  shouldUseLineWindow,
  splitLines,
  utf8ByteLength,
} from './lineWindow';

// ---------------------------------------------------------------------------
// TextLeafModel
// ---------------------------------------------------------------------------

describe('TextLeafModel', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('构造持有 blockId + 初始 plain text', () => {
    const leaf = new TextLeafModel('b-1', 'hello');
    expect(leaf.blockId).toBe('b-1');
    expect(leaf.getText()).toBe('hello');
    expect(leaf.isComposing()).toBe(false);
  });

  it('空 blockId 抛错', () => {
    expect(() => new TextLeafModel('')).toThrow(/blockId/);
  });

  it('applyLocalEdit 非 composing 产出 TextEditIntent 并更新缓冲', () => {
    const leaf = new TextLeafModel('b-1', 'abc');
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

  it('applyLocalEdit 每次新 intentId', () => {
    const leaf = new TextLeafModel('b-1', '', {
      createIntentId: () => nextIntentId('t'),
    });
    const a = leaf.applyLocalEdit(0, 0, 'a');
    const b = leaf.applyLocalEdit(1, 1, 'b');
    expect(a!.intentId).not.toBe(b!.intentId);
    expect(leaf.getText()).toBe('ab');
  });

  it('composing 时 applyLocalEdit 更新缓冲但不发 Intent', () => {
    const leaf = new TextLeafModel('b-1', 'ab');
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
    const leaf = new TextLeafModel('b-1', 'ab');
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
    expect(intent!.intentId).toBeTruthy();
  });

  it('flushOnCompositionEnd(finalInsert) 以最终串重建缓冲', () => {
    const leaf = new TextLeafModel('b-1', 'xy');
    leaf.beginComposition(1);
    leaf.applyLocalEdit(1, 1, '…'); // 预览
    const intent = leaf.flushOnCompositionEnd('完');
    expect(leaf.getText()).toBe('x完y');
    expect(intent).toMatchObject({
      range: [1, 1],
      insert: '完',
    });
  });

  it('cancelComposition 回滚且不发 Intent', () => {
    const leaf = new TextLeafModel('b-1', 'base');
    leaf.beginComposition(4);
    leaf.applyLocalEdit(4, 4, 'XXX');
    expect(leaf.getText()).toBe('baseXXX');
    leaf.cancelComposition();
    expect(leaf.isComposing()).toBe(false);
    expect(leaf.getText()).toBe('base');
  });

  it('replaceFromProjection composing 期拒绝', () => {
    const leaf = new TextLeafModel('b-1', 'old');
    expect(leaf.replaceFromProjection('new')).toBe(true);
    expect(leaf.getText()).toBe('new');
    leaf.beginComposition(0);
    expect(leaf.replaceFromProjection('remote')).toBe(false);
    expect(leaf.getText()).toBe('new');
  });

  it('无 composition 时 flush 返回 null', () => {
    const leaf = new TextLeafModel('b-1', 'x');
    expect(leaf.flushOnCompositionEnd()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// intentBridge
// ---------------------------------------------------------------------------

describe('intentBridge', () => {
  it('mock sink 记录 text_edit 调用', async () => {
    const mock = createMockIntentSink();
    const intent: TextEditIntent = {
      type: 'text_edit',
      blockId: 'b-1',
      range: [0, 0],
      insert: 'hi',
      intentId: 'i-1',
    };
    const r = await submitIntent(intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(intent);
  });

  it('composing 时结构 op 拒绝，不进 sink', async () => {
    const mock = createMockIntentSink();
    const ime = new ImeMachine();
    ime.startComposition('b-1');

    const op: Intent = {
      type: 'op',
      ops: [{ kind: 'split_block' }],
      intentId: 'i-op',
    };
    const r = await submitIntent(op, mock.sink, { ime });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing_structure_op');
      expect(r.reason).toMatch(/composing|IME/i);
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('composing 时 isComposing 回调同样拒绝 structure_key', async () => {
    const mock = createMockIntentSink();
    const r = await submitIntent(
      {
        type: 'structure_key',
        kind: 'indent',
        blockId: 'b-1',
      },
      mock.sink,
      { isComposing: () => true }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing_structure_key');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('composing 时 text_edit 可下发 sink（守卫放行）', async () => {
    const mock = createMockIntentSink();
    const ime = new ImeMachine();
    ime.startComposition('b-1');
    const intent: TextEditIntent = {
      type: 'text_edit',
      blockId: 'b-1',
      range: [0, 0],
      insert: 'x',
      intentId: 'i-t',
    };
    const r = await submitIntent(intent, mock.sink, { ime });
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it('request_slash 守卫通过后仍因非 W0 拒绝 sink', async () => {
    const mock = createMockIntentSink();
    const r = await submitIntent(
      {
        type: 'request_slash',
        blockId: 'b-1',
        offset: 0,
      },
      mock.sink,
      { isComposing: false }
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('not_w0_intent');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('sink reject 透传 reason', async () => {
    const mock = createMockIntentSink({ ok: false, reason: 'conflict' });
    const r = await submitIntent(
      {
        type: 'text_edit',
        blockId: 'b-1',
        range: [0, 1],
        insert: '',
        intentId: 'i-del',
      },
      mock.sink
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('sink_reject');
      expect(r.reason).toBe('conflict');
    }
  });

  it('端到端：leaf apply → submitIntent → mock sink', async () => {
    const leaf = new TextLeafModel('leaf-1', 'Hello');
    const mock = createMockIntentSink();
    const intent = leaf.applyLocalEdit(5, 5, '!');
    expect(intent).not.toBeNull();
    const r = await submitIntent(intent!, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls[0]?.type).toBe('text_edit');
    expect(leaf.getText()).toBe('Hello!');
  });

  it('端到端 composing：flush 后才进 sink；期间 op 被拒', async () => {
    const leaf = new TextLeafModel('leaf-1', 'a');
    const mock = createMockIntentSink();
    const ime = new ImeMachine();

    ime.startComposition('leaf-1');
    leaf.beginComposition(1);

    // 合成中本地键入
    expect(leaf.applyLocalEdit(1, 1, '你')).toBeNull();

    // 合成中结构 op 拒绝
    const opR = await submitIntent(
      { type: 'op', ops: [{ kind: 'split_block' }], intentId: 'x' },
      mock.sink,
      { ime }
    );
    expect(opR.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);

    // end
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
});

// ---------------------------------------------------------------------------
// lineWindow（V6 / A-HUGE-03 骨架）
// ---------------------------------------------------------------------------

describe('lineWindow', () => {
  it('utf8ByteLength 对 ASCII / 中文计量', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中')).toBe(3);
  });

  it('低于 soft 阈不窗口化', () => {
    const text = 'short\npara';
    expect(shouldUseLineWindow(text)).toBe(false);
    const w = computeLineWindow(text, 0);
    expect(w.windowed).toBe(false);
    expect(w.slice.text).toBe(text);
    expect(w.slice.start).toBe(0);
    expect(w.slice.end).toBe(text.length);
  });

  it('超过 soft 阈（可配小阈）启用行窗口', () => {
    // 构造多行，阈用小值强制 windowed
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-xxxxxxxx`);
    const text = lines.join('\n');
    expect(shouldUseLineWindow(text, 32)).toBe(true);

    const w = computeLineWindow(text, text.length / 2, {
      softThresholdBytes: 32,
      maxVisibleLines: 10,
      overscanLines: 0,
    });
    expect(w.windowed).toBe(true);
    expect(w.lineEnd - w.lineStart).toBeLessThanOrEqual(10);
    expect(w.slice.text.length).toBeLessThan(text.length);
    expect(w.totalLines).toBe(50);
  });

  it('超阈无换行走固定 char 窗口', () => {
    const text = 'x'.repeat(5000);
    const w = computeLineWindow(text, 2500, {
      softThresholdBytes: 100,
      charWindowSize: 200,
    });
    expect(w.windowed).toBe(true);
    expect(w.slice.end - w.slice.start).toBeLessThanOrEqual(200);
    expect(w.slice.text.length).toBeLessThanOrEqual(200);
    // 焦点附近
    expect(w.slice.start).toBeLessThanOrEqual(2500);
    expect(w.slice.end).toBeGreaterThanOrEqual(2500);
  });

  it('默认 soft 阈为 64KiB', () => {
    expect(DEFAULT_PM_NODE_SOFT_BYTES).toBe(64 * 1024);
    // 刚好低于 64KiB 的 ASCII
    const under = 'a'.repeat(DEFAULT_PM_NODE_SOFT_BYTES - 1);
    expect(shouldUseLineWindow(under)).toBe(false);
    const over = 'a'.repeat(DEFAULT_PM_NODE_SOFT_BYTES);
    expect(shouldUseLineWindow(over)).toBe(true);
  });

  it('getOffsetWindow / getLineWindowSlice / splitLines', () => {
    const text = 'aa\nbb\ncc';
    expect(getOffsetWindow(text, 0, 2)).toEqual({
      start: 0,
      end: 2,
      text: 'aa',
    });
    const { lines, offsets } = splitLines(text);
    expect(lines).toEqual(['aa\n', 'bb\n', 'cc']);
    expect(offsets).toEqual([0, 3, 6]);
    const slice = getLineWindowSlice(text, 1, 3);
    expect(slice.text).toBe('bb\ncc');
    expect(slice.start).toBe(3);
  });
});
