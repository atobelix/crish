/**
 * W3-E Round8 · 真 CM6 host 接线单测
 *
 * - 真实 import @codemirror/state + @codemirror/view
 * - createCm6EditorState / resolveCm6LanguageExtension（无 DOM，node 可跑）
 * - Cm6CodeLeafHost 方法契约：jsdom 下 mount；DOM 不足时仍保留 EditorState 文档同步
 *
 * **不接 RS**；**≠** 全语言高亮。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';

import {
  createCm6EditorState,
  resolveCm6LanguageExtension,
  isCm6HighlightedLanguage,
  Cm6CodeLeafHost,
  isCm6CodeLeafHost,
} from './Cm6CodeLeafHost';
import { CodeLeafModel, createMockCodeLeafHost, mountCodeLeaf } from './index';
import { resetIntentIdSeqForTests } from '../TextLeafModel';

// ---------------------------------------------------------------------------
// 依赖接线：真实 CM6 包可 import + EditorState 可构造
// ---------------------------------------------------------------------------

describe('CM6 依赖接线（EditorState）', () => {
  it('真实 import @codemirror/state + view，创建 EditorState', () => {
    expect(EditorState).toBeTruthy();
    expect(EditorView).toBeTruthy();
    const state = EditorState.create({ doc: 'hello cm6' });
    expect(state.doc.toString()).toBe('hello cm6');
    expect(state.doc.length).toBe(9);
  });

  it('createCm6EditorState：doc + readOnly + language Compartment', () => {
    const langComp = new Compartment();
    const roComp = new Compartment();
    const { state, languageComp, readOnlyComp } = createCm6EditorState({
      doc: 'const a = 1;',
      language: 'javascript',
      readOnly: true,
      languageComp: langComp,
      readOnlyComp: roComp,
    });

    expect(state.doc.toString()).toBe('const a = 1;');
    expect(languageComp).toBe(langComp);
    expect(readOnlyComp).toBe(roComp);
    expect(state.facet(EditorState.readOnly)).toBe(true);
  });

  it('createCm6EditorState：plaintext 默认可写', () => {
    const { state } = createCm6EditorState({ doc: 'plain' });
    expect(state.doc.toString()).toBe('plain');
    expect(state.facet(EditorState.readOnly)).toBe(false);
  });

  it('resolveCm6LanguageExtension：js 有 LanguageSupport；plain/未知为空', () => {
    const jsExt = resolveCm6LanguageExtension('javascript');
    const js2 = resolveCm6LanguageExtension('js');
    const plain = resolveCm6LanguageExtension('plaintext');
    const unknown = resolveCm6LanguageExtension('python');

    // javascript() 返回 Extension 对象（非空数组）
    expect(jsExt).toBeTruthy();
    expect(js2).toBeTruthy();
    // 空扩展为 []
    expect(plain).toEqual([]);
    expect(unknown).toEqual([]);

    // 对照：lang-javascript 工厂可直接调用（依赖接线）
    const direct = javascript();
    expect(direct).toBeTruthy();
  });

  it('isCm6HighlightedLanguage：仅 js 系为 true', () => {
    expect(isCm6HighlightedLanguage('javascript')).toBe(true);
    expect(isCm6HighlightedLanguage('js')).toBe(true);
    expect(isCm6HighlightedLanguage('plaintext')).toBe(false);
    expect(isCm6HighlightedLanguage('typescript')).toBe(false);
    expect(isCm6HighlightedLanguage(undefined)).toBe(false);
  });

  it('文档同步：EditorState 变更后 doc 字符串一致', () => {
    const { state } = createCm6EditorState({ doc: 'ab' });
    // 无 View 时用 state.update 证明事务路径
    const tr = state.update({
      changes: { from: 1, to: 1, insert: 'X' },
    });
    expect(tr.state.doc.toString()).toBe('aXb');
  });

  it('language Compartment.reconfigure：plaintext → javascript 不抛', () => {
    const languageComp = new Compartment();
    const state = EditorState.create({
      doc: 'x',
      extensions: [languageComp.of(resolveCm6LanguageExtension('plaintext'))],
    });
    const tr = state.update({
      effects: languageComp.reconfigure(
        resolveCm6LanguageExtension('javascript')
      ),
    });
    expect(tr.state.doc.toString()).toBe('x');
    expect(tr.effects.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Host 契约：有 document 时走真 View；否则跳过 DOM mount
// ---------------------------------------------------------------------------

function canCreateDomParent(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.createElement) {
    return null;
  }
  try {
    const el = document.createElement('div');
    // 部分 node polyfill 有 createElement 但缺 CM6 需要的 API
    if (typeof el.appendChild !== 'function') return null;
    return el;
  } catch {
    return null;
  }
}

describe('Cm6CodeLeafHost（DOM 可用时）', () => {
  const parent = canCreateDomParent();
  // node 默认环境无完整 DOM：用条件 skip，核心接线已由上面 EditorState 覆盖
  const maybeIt = parent ? it : it.skip;

  let host: Cm6CodeLeafHost | null = null;
  let el: HTMLElement | null = null;

  beforeEach(() => {
    resetIntentIdSeqForTests();
    el = canCreateDomParent();
    host = null;
  });

  afterEach(() => {
    host?.destroy();
    host = null;
    el = null;
  });

  maybeIt('mount：创建 EditorView，getEditorView 非 null', () => {
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'const x = 1;',
      language: 'javascript',
    });
    const view = host.getEditorView();
    expect(view).toBeTruthy();
    expect(view).toBeInstanceOf(EditorView);
    expect(host.getContent()).toBe('const x = 1;');
    expect(host.getLanguage()).toBe('javascript');
    expect(isCm6CodeLeafHost(host)).toBe(true);
  });

  maybeIt('setContent / getContent 同步；不触发 onDocChanged 回环', () => {
    const changes: string[] = [];
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'a',
      onDocChanged: (c) => changes.push(c),
    });
    host.setContent('hello');
    expect(host.getContent()).toBe('hello');
    // Model 推送 suppress → 不应回调
    expect(changes).toEqual([]);
  });

  maybeIt('用户 dispatch 变更触发 onDocChanged', () => {
    const changes: string[] = [];
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'ab',
      onDocChanged: (c) => changes.push(c),
    });
    const view = host.getEditorView()!;
    view.dispatch({
      changes: { from: 1, to: 1, insert: 'X' },
    });
    expect(host.getContent()).toBe('aXb');
    expect(changes).toEqual(['aXb']);
  });

  maybeIt('setLanguage / setReadOnly 经 Compartment', () => {
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'fn',
      language: 'plaintext',
      readOnly: false,
    });
    host.setLanguage('javascript');
    expect(host.getLanguage()).toBe('javascript');
    host.setReadOnly(true);
    expect(host.isReadOnly()).toBe(true);
    expect(host.getEditorView()!.state.facet(EditorState.readOnly)).toBe(true);
  });

  maybeIt('focus / blur 对接 view（hasFocus 尽力断言）', () => {
    host = new Cm6CodeLeafHost(el!, { initialContent: 'x' });
    // jsdom 下 focus 行为可能受限，至少不抛
    expect(() => host!.focus()).not.toThrow();
    expect(() => host!.blur()).not.toThrow();
  });

  maybeIt('destroy 后 getEditorView null；再操作抛错', () => {
    host = new Cm6CodeLeafHost(el!, { initialContent: 'z' });
    host.destroy();
    expect(host.getEditorView()).toBeNull();
    expect(() => host!.setContent('nope')).toThrow(/destroy/);
    host = null; // afterEach 勿二次 destroy
  });

  maybeIt('与 CodeLeafModel 联调：Model 编辑 → host content', () => {
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'ab',
      language: 'javascript',
    });
    const model = new CodeLeafModel('cm6-1', 'ab', {
      language: 'javascript',
      host,
    });
    model.focus();
    const intent = model.applyLocalEdit(1, 1, 'X');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'cm6-1',
      range: [1, 1],
      insert: 'X',
    });
    expect(model.getContent()).toBe('aXb');
    expect(host.getContent()).toBe('aXb');
  });

  maybeIt('onDocChanged → applyLocalEdit Intent 通路', () => {
    let model: CodeLeafModel | null = null;
    host = new Cm6CodeLeafHost(el!, {
      initialContent: 'hi',
      onDocChanged: (content) => {
        if (!model) return;
        const old = model.getContent();
        if (old === content) return;
        // 用户编辑回写 Model（全量替换形状；Intent 仍 text_edit）
        model.applyLocalEdit(0, old.length, content);
      },
    });
    model = new CodeLeafModel('cm6-2', 'hi', { host: host! });
    model.focus();

    host.getEditorView()!.dispatch({
      changes: { from: 2, to: 2, insert: '!' },
    });
    expect(model.getContent()).toBe('hi!');
  });

  maybeIt('mountCodeLeaf + Cm6CodeLeafHost：getEditorView 非 null', () => {
    const mount = mountCodeLeaf(el!, {
      blockId: 'm-cm6',
      initialContent: 'let x',
      language: 'javascript',
      createHost: (parent) =>
        new Cm6CodeLeafHost(parent, {
          initialContent: 'let x',
          language: 'javascript',
        }),
    });
    expect(mount.getEditorView()).toBeInstanceOf(EditorView);
    expect(mount.model.getContent()).toBe('let x');
    mount.unmount();
  });
});

// ---------------------------------------------------------------------------
// 无 DOM 时 Host 接口仍可被 mock 对照（契约文档）
// ---------------------------------------------------------------------------

describe('Host 契约对照（mock vs CM6 工厂）', () => {
  it('mock host 无 getEditorView；mount 默认 getEditorView null', () => {
    const host = createMockCodeLeafHost({ initialContent: 'm' });
    const fakeEl = { appendChild() {} } as unknown as HTMLElement;
    const mount = mountCodeLeaf(fakeEl, {
      blockId: 'm-mock',
      createHost: () => host,
    });
    expect(mount.getEditorView()).toBeNull();
    mount.unmount();
  });

  it('createCm6EditorState 与 mock host content 语义对齐', () => {
    const doc = 'shared-doc';
    const { state } = createCm6EditorState({ doc, language: 'js' });
    const mock = createMockCodeLeafHost({
      initialContent: doc,
      language: 'javascript',
    });
    expect(state.doc.toString()).toBe(mock.getContent());
  });
});
