/**
 * W3-E CM6 代码叶骨架单测：
 * - focus / blur + host 同步
 * - 编辑 → text_edit → submitIntent → mock sink
 * - 只读拒绝
 * - composing / 外部 isComposing
 * - mountCodeLeaf（mock host）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { TextEditIntent } from '@crish/block-paper-contract';
import { resetIntentIdSeqForTests, nextIntentId } from '../TextLeafModel';
import { createMockIntentSink, submitIntent } from '../intentBridge';
import { CodeLeafModel, createMockCodeLeafHost, mountCodeLeaf } from './index';

describe('CodeLeafModel', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('构造：blockId + content + language + readOnly 快照', () => {
    const leaf = new CodeLeafModel('code-1', 'const a = 1;', {
      language: 'javascript',
      readOnly: false,
    });
    expect(leaf.blockId).toBe('code-1');
    expect(leaf.getContent()).toBe('const a = 1;');
    expect(leaf.getLanguage()).toBe('javascript');
    expect(leaf.isReadOnly()).toBe(false);
    expect(leaf.isFocused()).toBe(false);
    expect(leaf.getSnapshot()).toMatchObject({
      blockId: 'code-1',
      content: 'const a = 1;',
      language: 'javascript',
      readOnly: false,
      focused: false,
      composing: false,
    });
  });

  it('空 blockId 抛错', () => {
    expect(() => new CodeLeafModel('')).toThrow(/blockId/);
  });

  it('focus / blur 切换 focused；同步 mock host', () => {
    const host = createMockCodeLeafHost();
    const leaf = new CodeLeafModel('c-1', 'x', { host });

    expect(leaf.isFocused()).toBe(false);
    expect(host.hasFocus()).toBe(false);

    leaf.focus();
    expect(leaf.isFocused()).toBe(true);
    expect(host.hasFocus()).toBe(true);
    expect(host.focusCount).toBe(1);

    leaf.blur();
    expect(leaf.isFocused()).toBe(false);
    expect(host.hasFocus()).toBe(false);
    expect(host.blurCount).toBeGreaterThanOrEqual(1);
  });

  it('setLanguage / setReadOnly 同步 host', () => {
    const host = createMockCodeLeafHost({ language: 'plaintext' });
    const leaf = new CodeLeafModel('c-1', '', { host });
    leaf.setLanguage('typescript');
    expect(leaf.getLanguage()).toBe('typescript');
    expect(host.getLanguage?.()).toBe('typescript');
    leaf.setReadOnly(true);
    expect(leaf.isReadOnly()).toBe(true);
    expect(host.isReadOnly()).toBe(true);
  });

  it('聚焦后 applyLocalEdit 产出 text_edit 并更新 content/host', () => {
    const host = createMockCodeLeafHost();
    const leaf = new CodeLeafModel('c-1', 'ab', {
      host,
      createIntentId: () => nextIntentId('c'),
    });
    leaf.focus();
    const intent = leaf.applyLocalEdit(1, 1, 'X');
    expect(leaf.getContent()).toBe('aXb');
    expect(host.getContent()).toBe('aXb');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'c-1',
      range: [1, 1],
      insert: 'X',
    } satisfies Partial<TextEditIntent>);
    expect(intent!.intentId).toBeTruthy();
  });

  it('tryApplyLocalEdit 未聚焦时拒绝（requireFocus 默认 true）', () => {
    const leaf = new CodeLeafModel('c-1', 'hi');
    const r = leaf.tryApplyLocalEdit(0, 0, '!');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('not_focused');
    }
    expect(leaf.getContent()).toBe('hi');
  });

  it('只读拒绝：applyLocalEdit 返回 null；tryApply 带 read_only', () => {
    const leaf = new CodeLeafModel('c-1', 'locked', { readOnly: true });
    leaf.focus();
    expect(leaf.applyLocalEdit(0, 0, 'x')).toBeNull();
    expect(leaf.getContent()).toBe('locked');

    const r = leaf.tryApplyLocalEdit(0, 6, 'y');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('read_only');
      expect(r.reason).toMatch(/只读/);
    }
    expect(leaf.getContent()).toBe('locked');
  });

  it('setReadOnly(true) 之后后续编辑拒绝', () => {
    const leaf = new CodeLeafModel('c-1', 'a');
    leaf.focus();
    expect(leaf.applyLocalEdit(1, 1, 'b')).not.toBeNull();
    expect(leaf.getContent()).toBe('ab');
    leaf.setReadOnly(true);
    expect(leaf.applyLocalEdit(2, 2, 'c')).toBeNull();
    expect(leaf.getContent()).toBe('ab');
  });

  it('composing：本地缓冲不发 Intent；flush 产出 text_edit', () => {
    const leaf = new CodeLeafModel('c-1', 'fn');
    leaf.focus();
    leaf.beginComposition(2);
    expect(leaf.isComposing()).toBe(true);
    expect(leaf.applyLocalEdit(2, 2, '()')).toBeNull();
    expect(leaf.getContent()).toBe('fn()');

    const intent = leaf.flushOnCompositionEnd();
    expect(leaf.isComposing()).toBe(false);
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'c-1',
      range: [2, 2],
      insert: '()',
    });
  });

  it('外部 isComposing 注入：合成中不发 Intent', () => {
    let composing = false;
    const leaf = new CodeLeafModel('c-1', '', {
      isComposing: () => composing,
    });
    leaf.focus();
    composing = true;
    expect(leaf.isComposing()).toBe(true);
    expect(leaf.applyLocalEdit(0, 0, 'a')).toBeNull();
    expect(leaf.getContent()).toBe('a');
    composing = false;
    const intent = leaf.applyLocalEdit(1, 1, 'b');
    expect(intent).toMatchObject({ insert: 'b', range: [1, 1] });
  });

  it('cancelComposition 回滚', () => {
    const leaf = new CodeLeafModel('c-1', 'base');
    leaf.focus();
    leaf.beginComposition(4);
    leaf.applyLocalEdit(4, 4, 'XXX');
    leaf.cancelComposition();
    expect(leaf.isComposing()).toBe(false);
    expect(leaf.getContent()).toBe('base');
  });

  it('replaceFromProjection composing 期拒绝', () => {
    const leaf = new CodeLeafModel('c-1', 'old');
    expect(leaf.replaceFromProjection('new')).toBe(true);
    leaf.beginComposition(0);
    expect(leaf.replaceFromProjection('remote')).toBe(false);
    expect(leaf.getContent()).toBe('new');
  });

  it('只读时 beginComposition 无效', () => {
    const leaf = new CodeLeafModel('c-1', 'x', { readOnly: true });
    leaf.beginComposition(0);
    expect(leaf.isComposing()).toBe(false);
  });
});

describe('CodeLeaf → submitIntent', () => {
  beforeEach(() => {
    resetIntentIdSeqForTests();
  });

  it('端到端：focus → edit → submitIntent → mock sink', async () => {
    const leaf = new CodeLeafModel('leaf-code', 'Hello');
    const mock = createMockIntentSink();
    leaf.focus();
    const intent = leaf.applyLocalEdit(5, 5, '!');
    expect(intent).not.toBeNull();
    const r = await submitIntent(intent!, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      type: 'text_edit',
      blockId: 'leaf-code',
      insert: '!',
      range: [5, 5],
    });
  });

  it('只读叶无法产出 Intent，sink 无调用', async () => {
    const leaf = new CodeLeafModel('ro', 'code', { readOnly: true });
    const mock = createMockIntentSink();
    leaf.focus();
    const intent = leaf.applyLocalEdit(0, 0, 'x');
    expect(intent).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });

  it('tryApply + submit：聚焦可写路径', async () => {
    const leaf = new CodeLeafModel('c-2', 'print');
    const mock = createMockIntentSink();
    leaf.focus();
    const attempt = leaf.tryApplyLocalEdit(5, 5, '()');
    expect(attempt.ok).toBe(true);
    if (attempt.ok) {
      expect(attempt.intent).not.toBeNull();
      const r = await submitIntent(attempt.intent!, mock.sink);
      expect(r.ok).toBe(true);
    }
    expect(mock.calls[0]?.type).toBe('text_edit');
  });
});

describe('mountCodeLeaf + mock host', () => {
  it('mount 注入 host，unmount 销毁', () => {
    // 无真实 DOM：用 mock host 工厂
    const host = createMockCodeLeafHost({
      initialContent: 'let x',
      language: 'javascript',
    });
    // mount 需要 HTMLElement；用最小桩满足类型
    const fakeEl = { appendChild() {} } as unknown as HTMLElement;
    const mount = mountCodeLeaf(fakeEl, {
      blockId: 'm-1',
      initialContent: 'let x',
      language: 'javascript',
      createHost: () => host,
    });

    expect(mount.model.blockId).toBe('m-1');
    expect(mount.model.getContent()).toBe('let x');
    expect(mount.model.getLanguage()).toBe('javascript');
    expect(mount.getEditorView()).toBeNull(); // CM6 未接

    mount.model.focus();
    expect(host.hasFocus()).toBe(true);
    expect(mount.model.applyLocalEdit(5, 5, ' = 1')).not.toBeNull();
    expect(host.getContent()).toBe('let x = 1');

    mount.unmount();
    expect(host.destroyed).toBe(true);
  });

  it('createMockCodeLeafHost 独立审计 focus 次数', () => {
    const host = createMockCodeLeafHost();
    host.focus();
    host.focus();
    expect(host.focusCount).toBe(2);
    host.blur();
    expect(host.hasFocus()).toBe(false);
  });
});
