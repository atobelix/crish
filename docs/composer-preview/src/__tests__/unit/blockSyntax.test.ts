/**
 * 块级语法（标题前缀）行为测试
 *
 * 验证「用键盘实时改标题级别」这条核心诉求：
 * `#` 是文档里的真字符，节点类型反过来由它推导，因此完全可逆。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { LivePreviewInline, STARTER_KIT_DISABLED, detectBlockPrefix } from '../../core/live-preview';
import { revealPluginKey } from '../../core/live-preview/revealPlugin';

let editor: Editor;
let host: HTMLElement;

function mount(html: string): Editor {
  host = document.createElement('div');
  document.body.appendChild(host);
  const ed = new Editor({
    element: host,
    extensions: [StarterKit.configure({ ...STARTER_KIT_DISABLED }), LivePreviewInline],
    content: html,
  });
  ed.commands.reconcileDocument();
  return ed;
}

/** 第一个块的类型名与属性 */
function firstBlock(ed: Editor) {
  const node = ed.state.doc.firstChild!;
  return { type: node.type.name, level: node.attrs.level as number | undefined };
}

function cursor(ed: Editor, offset: number) {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1 + offset)));
}

function revealedCount(ed: Editor): number {
  const set: any = revealPluginKey.getState(ed.state);
  return set.find().length;
}

afterEach(() => {
  editor?.destroy();
  host?.remove();
});

/* ════════════════════════════════════════════
 * 前缀识别
 * ════════════════════════════════════════════ */

describe('detectBlockPrefix', () => {
  it('识别 1~6 级标题', () => {
    expect(detectBlockPrefix('# a')).toMatchObject({ level: 1, length: 2 });
    expect(detectBlockPrefix('### a')).toMatchObject({ level: 3, length: 4 });
    expect(detectBlockPrefix('###### a')).toMatchObject({ level: 6, length: 7 });
  });

  it('七个井号不是标题', () => {
    expect(detectBlockPrefix('####### a')).toBeNull();
  });

  it('井号后必须有空白，#tag 不会被误判为标题', () => {
    expect(detectBlockPrefix('#tag 内容')).toBeNull();
    expect(detectBlockPrefix('#')).toBeNull();
  });

  it('允许多个空格 / 制表符', () => {
    expect(detectBlockPrefix('##   a')).toMatchObject({ level: 2, length: 5 });
    expect(detectBlockPrefix('#\ta')).toMatchObject({ level: 1, length: 2 });
  });
});

/* ════════════════════════════════════════════
 * 文本驱动节点类型
 * ════════════════════════════════════════════ */

describe('标题级别由文本推导', () => {
  it('载入时按前缀得到正确的标题节点', () => {
    editor = mount('<p>## 二级标题</p>');
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 2 });
    // 井号仍然真实存在于文档里
    expect(editor.state.doc.textContent).toBe('## 二级标题');
  });

  it('在段落行首敲 "### " 就变成三级标题', () => {
    editor = mount('<p>标题文字</p>');
    expect(firstBlock(editor).type).toBe('paragraph');
    editor.view.dispatch(editor.state.tr.insertText('### ', 1));
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 3 });
    expect(editor.state.doc.textContent).toBe('### 标题文字');
  });

  it('再补一个 # 就降一级（可逆的级别调整）', () => {
    editor = mount('<p>## 标题</p>');
    expect(firstBlock(editor).level).toBe(2);
    editor.view.dispatch(editor.state.tr.insertText('#', 1));
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 3 });
  });

  it('删掉一个 # 就升一级', () => {
    editor = mount('<p>### 标题</p>');
    editor.view.dispatch(editor.state.tr.delete(1, 2));
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 2 });
  });

  it('删光所有 # 就退回普通段落', () => {
    editor = mount('<p>## 标题</p>');
    editor.view.dispatch(editor.state.tr.delete(1, 4)); // 删掉 "## "
    expect(firstBlock(editor).type).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('标题');
  });

  it('标题里的行内格式照常工作', () => {
    editor = mount('<p>## 带 **粗体** 的标题</p>');
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 2 });
    const $p = editor.state.doc.resolve(1 + 6);
    const node = $p.parent.childAfter($p.parentOffset).node!;
    expect(node.marks.map((m) => m.type.name)).toContain('bold');
  });
});

/* ════════════════════════════════════════════
 * 前缀的显隐
 * ════════════════════════════════════════════ */

describe('标题前缀显隐', () => {
  it('光标在标题行的任何位置，井号都保持可见', () => {
    editor = mount('<p>## 标题文字</p>');
    for (let offset = 0; offset <= '## 标题文字'.length; offset++) {
      cursor(editor, offset);
      expect(revealedCount(editor)).toBeGreaterThan(0);
    }
  });

  it('光标移到别的块后井号收起', () => {
    editor = mount('<p>## 标题</p><p>正文</p>');
    // 第二个块内
    const secondPos = editor.state.doc.firstChild!.nodeSize + 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, secondPos)),
    );
    expect(revealedCount(editor)).toBe(0);
  });
});

/* ════════════════════════════════════════════
 * 撤销
 * ════════════════════════════════════════════ */

describe('撤销一致性', () => {
  it('撤销后节点类型与文本一起回滚', () => {
    editor = mount('<p>文字</p>');
    editor.view.dispatch(editor.state.tr.insertText('# ', 1));
    expect(firstBlock(editor)).toEqual({ type: 'heading', level: 1 });

    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('文字');
    expect(firstBlock(editor).type).toBe('paragraph');
  });
});
