/**
 * W3-E 方向子集：flavour `code` / fence ↔ collab kind 诚实映射 + 只读呈现适配。
 *
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - 不回退 intentBridge.apply / direction / paperList
 */
// @vitest-environment jsdom

import { describe, expect, it, afterEach } from 'vitest';
import { flavourToCollabKind } from '@crish/block-paper-contract';
import {
  CODE_COLLAB_KIND,
  CODE_FLAVOUR_IDS,
  codeFlavourToCollabKind,
  codeLeafAttrsForLanguage,
  fenceOpenToLanguage,
  isCodeCollabKind,
  isCodeFlavour,
  parseFenceInfo,
  resolveCodeLeafKindAndLanguage,
  resolveCodeLeafLanguage,
} from './codeFlavourMap';
import {
  BP_CODE_READONLY,
  createReadonlyCodeLeafModel,
  createReadonlyCodeSnapshot,
  mountReadonlyCodePresentation,
  type ReadonlyCodePresentationMount,
} from './ReadonlyCodePresentation';
import { createCm6EditorState } from './Cm6CodeLeafHost';
import { CodeLeafModel } from './CodeLeafModel';

// ---------------------------------------------------------------------------
// flavour / collab kind
// ---------------------------------------------------------------------------

describe('W3-E · code flavour ↔ collab kind 诚实映射', () => {
  it('CODE_FLAVOUR_IDS 均映射为 collab kind "code"', () => {
    for (const id of CODE_FLAVOUR_IDS) {
      expect(flavourToCollabKind(id)).toBe(CODE_COLLAB_KIND);
      expect(isCodeFlavour(id)).toBe(true);
      expect(codeFlavourToCollabKind(id)).toBe('code');
    }
  });

  it('大小写 / 空白：Code → code', () => {
    expect(isCodeFlavour('  CODE  ')).toBe(true);
    expect(codeFlavourToCollabKind('Code_Block')).toBe('code');
    expect(codeFlavourToCollabKind('code-block')).toBe('code');
  });

  it('非代码 flavour 不得伪装为 code', () => {
    expect(isCodeFlavour('paragraph')).toBe(false);
    expect(isCodeFlavour('callout')).toBe(false);
    expect(isCodeFlavour('heading-1')).toBe(false);
    expect(codeFlavourToCollabKind('paragraph')).toBeNull();
    expect(codeFlavourToCollabKind('my_plugin')).toBeNull();
    // 与 contract 一致：未知 → unknown 对象，不是 code
    expect(flavourToCollabKind('callout')).toEqual({
      unknown: { flavour: 'callout' },
    });
  });

  it('isCodeCollabKind 仅字面量 code', () => {
    expect(isCodeCollabKind('code')).toBe(true);
    expect(isCodeCollabKind('paragraph')).toBe(false);
    expect(isCodeCollabKind({ heading: { level: 1 } })).toBe(false);
    expect(isCodeCollabKind({ unknown: { flavour: 'x' } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fence info → language
// ---------------------------------------------------------------------------

describe('W3-E · fence info → CodeLanguage', () => {
  it('parseFenceInfo：开行 / 纯 info / 空', () => {
    expect(parseFenceInfo('```js')).toBe('js');
    expect(parseFenceInfo('```javascript')).toBe('javascript');
    expect(parseFenceInfo('```')).toBe('plaintext');
    expect(parseFenceInfo('python')).toBe('python');
    expect(parseFenceInfo('')).toBe('plaintext');
    expect(parseFenceInfo(null)).toBe('plaintext');
    expect(parseFenceInfo('~~~ts')).toBe('ts');
  });

  it('fenceOpenToLanguage 与 parseFenceInfo 对齐', () => {
    expect(fenceOpenToLanguage('```rust')).toBe(parseFenceInfo('```rust'));
  });

  it('info 首 token；非法字符回落 plaintext', () => {
    expect(parseFenceInfo('js {highlight}')).toBe('js');
    expect(parseFenceInfo('c++')).toBe('c++');
    expect(parseFenceInfo('!!!')).toBe('plaintext');
  });

  it('resolveCodeLeafLanguage 优先级：fenceInfo > language > attrs', () => {
    expect(
      resolveCodeLeafLanguage({
        fenceInfo: '```go',
        language: 'python',
        attrs: { language: 'ruby' },
      })
    ).toBe('go');
    expect(
      resolveCodeLeafLanguage({
        language: 'python',
        attrs: { lang: 'ruby' },
      })
    ).toBe('python');
    expect(
      resolveCodeLeafLanguage({
        attrs: { lang: 'ruby' },
      })
    ).toBe('ruby');
    expect(resolveCodeLeafLanguage({})).toBe('plaintext');
  });

  it('codeLeafAttrsForLanguage：plaintext 不写 attrs；其余写 language', () => {
    expect(codeLeafAttrsForLanguage('plaintext')).toEqual({});
    expect(codeLeafAttrsForLanguage('js')).toEqual({ language: 'js' });
    expect(codeLeafAttrsForLanguage('```ts')).toEqual({ language: 'ts' });
  });

  it('resolveCodeLeafKindAndLanguage：code + fence 一次解析', () => {
    const r = resolveCodeLeafKindAndLanguage({
      flavour: 'code',
      fenceInfo: '```javascript',
    });
    expect(r.isCode).toBe(true);
    expect(r.kindWire).toBe('code');
    expect(r.language).toBe('javascript');

    const other = resolveCodeLeafKindAndLanguage({
      flavour: 'paragraph',
      language: 'js',
    });
    expect(other.isCode).toBe(false);
    expect(other.kindWire).toBe('paragraph');
    // language 仍解析，调用方按 isCode 决定是否采用
    expect(other.language).toBe('js');
  });
});

// ---------------------------------------------------------------------------
// 只读呈现适配
// ---------------------------------------------------------------------------

describe('W3-E · ReadonlyCodePresentation（只读挂载形状）', () => {
  let mount: ReadonlyCodePresentationMount | null = null;

  afterEach(() => {
    mount?.unmount();
    mount = null;
  });

  it('mount：pre/code DOM + language class + data 属性', () => {
    const parent = document.createElement('div');
    mount = mountReadonlyCodePresentation(parent, {
      blockId: 'ro-1',
      content: 'const a = 1;',
      fenceInfo: '```js',
      flavour: 'code',
    });

    expect(mount.root.classList.contains(BP_CODE_READONLY)).toBe(true);
    expect(mount.root.getAttribute('data-bp-code-leaf')).toBe('readonly');
    expect(mount.root.getAttribute('data-read-only')).toBe('true');
    expect(mount.root.getAttribute('data-flavour')).toBe('code');
    expect(mount.getLanguage()).toBe('js');
    expect(mount.getContent()).toBe('const a = 1;');
    expect(mount.codeEl.classList.contains('language-js')).toBe(true);
    expect(mount.model?.isReadOnly()).toBe(true);
    expect(parent.contains(mount.root)).toBe(true);
  });

  it('只读 Model：tryApply 拒绝 read_only', () => {
    const model = createReadonlyCodeLeafModel('ro-2', 'x', {
      fenceInfo: '```ts',
    });
    expect(model.getLanguage()).toBe('ts');
    expect(model.isReadOnly()).toBe(true);
    model.focus();
    const r = model.tryApplyLocalEdit(0, 0, '!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('read_only');
    expect(model.getContent()).toBe('x');
  });

  it('createReadonlyCodeSnapshot：无 DOM 形状', () => {
    const snap = createReadonlyCodeSnapshot({
      blockId: 'ro-3',
      content: 'fn',
      flavour: 'code_block',
      attrs: { language: 'rust' },
    });
    expect(snap).toMatchObject({
      blockId: 'ro-3',
      content: 'fn',
      language: 'rust',
      readOnly: true,
      mounted: false,
      flavour: 'code_block',
    });
    expect(isCodeFlavour(snap.flavour!)).toBe(true);
  });

  it('setContent / setLanguage / unmount', () => {
    const parent = document.createElement('div');
    mount = mountReadonlyCodePresentation(parent, {
      blockId: 'ro-4',
      content: 'a',
      language: 'plaintext',
    });
    mount.setContent('ab');
    expect(mount.getContent()).toBe('ab');
    expect(mount.model?.getContent()).toBe('ab');
    mount.setLanguage('javascript');
    expect(mount.getLanguage()).toBe('javascript');
    expect(mount.codeEl.classList.contains('language-javascript')).toBe(true);

    mount.unmount();
    expect(parent.childNodes.length).toBe(0);
    mount = null;
  });

  it('非 code flavour 挂载时标 data-flavour-mismatch（诚实）', () => {
    const parent = document.createElement('div');
    mount = mountReadonlyCodePresentation(parent, {
      blockId: 'ro-5',
      content: 'x',
      flavour: 'paragraph',
    });
    expect(mount.root.getAttribute('data-flavour-mismatch')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 与既有代码叶 / CM6 可点名交叉（形状；≠ 产品 e2e）
// ---------------------------------------------------------------------------

describe('W3-E · 代码叶模型 + CM6 只读 state 可点名', () => {
  it('CodeLeafModel 可聚焦 + text_edit；只读 CM6 EditorState 可构造', () => {
    const leaf = new CodeLeafModel('c-focus', 'hi', { language: 'javascript' });
    leaf.focus();
    expect(leaf.isFocused()).toBe(true);
    const intent = leaf.applyLocalEdit(2, 2, '!');
    expect(intent).toMatchObject({
      type: 'text_edit',
      blockId: 'c-focus',
      insert: '!',
    });

    // 只读 CM6 state（活动叶编辑面的只读模式；≠ 本 Readonly DOM 适配）
    const { state } = createCm6EditorState({
      doc: 'const x = 1;',
      language: 'javascript',
      readOnly: true,
    });
    expect(state.doc.toString()).toBe('const x = 1;');
  });

  it('kind 映射与 Model language 联立：fence → language，kind 仍为 code', () => {
    const { isCode, kindWire, language } = resolveCodeLeafKindAndLanguage({
      flavour: 'code',
      fenceInfo: '```js',
    });
    expect(isCode).toBe(true);
    expect(kindWire).toBe('code');
    const leaf = new CodeLeafModel('c-map', 'body', {
      language,
      readOnly: false,
    });
    expect(leaf.getLanguage()).toBe('js');
    // language 进 attrs；kind 不承载 lang
    expect(codeLeafAttrsForLanguage(leaf.getLanguage())).toEqual({
      language: 'js',
    });
  });
});
