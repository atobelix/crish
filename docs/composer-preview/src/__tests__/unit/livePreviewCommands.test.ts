/**
 * 格式命令测试
 *
 * 核心不变式：菜单/快捷键产生的格式，与用户手打语法产生的格式
 * 在文档里必须是**同一个东西**——都是真实的分隔符字符。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { LivePreviewInline, STARTER_KIT_DISABLED } from '../../core/live-preview';

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

/** 选中块内 [from, to) 区间的文字 */
function select(ed: Editor, from: number, to: number) {
  ed.view.dispatch(
    ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1 + from, 1 + to)),
  );
}

const text = () => editor.state.doc.textContent;

afterEach(() => {
  editor?.destroy();
  host?.remove();
});

/* ═══════════════════════════════════════════
 * 行内格式：加
 * ════════════════════════════════════════════ */

describe('行内格式命令 — 添加', () => {
  it('加粗把 ** 真的写进文本', () => {
    editor = mount('<p>hello world</p>');
    select(editor, 6, 11);
    editor.commands.toggleBold();
    expect(text()).toBe('hello **world**');
    expect(editor.isActive('bold')).toBe(true);
  });

  it('选区在加粗后仍然覆盖原来的文字', () => {
    editor = mount('<p>hello world</p>');
    select(editor, 6, 11);
    editor.commands.toggleBold();
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe('world');
  });

  it('斜体 / 删除线 / 高亮 / 行内代码各用各的分隔符', () => {
    const cases: Array<[() => boolean, string]> = [
      [() => editor.commands.toggleItalic(), '*ab*'],
      [() => editor.commands.toggleStrike(), '~~ab~~'],
      [() => editor.commands.toggleHighlight(), '==ab=='],
      [() => editor.commands.toggleCode(), '`ab`'],
    ];
    for (const [run, expected] of cases) {
      editor?.destroy();
      host?.remove();
      editor = mount('<p>ab</p>');
      select(editor, 0, 2);
      run();
      expect(text()).toBe(expected);
    }
  });

  it('空选区插入一对分隔符并把光标放中间', () => {
    editor = mount('<p></p>');
    editor.commands.toggleBold();
    expect(text()).toBe('****');
    expect(editor.state.selection.from).toBe(1 + 2);
    // 接着打字即可得到加粗文本
    editor.commands.insertContent('x');
    expect(text()).toBe('**x**');
    expect(editor.isActive('bold')).toBe(true);
  });
});

/* ═════════════════════════════════════════════════════════
 * 行内格式：去
 * ════════════════════════════════════════════ */

describe('行内格式命令 — 取消', () => {
  it('对已加粗的选区再次执行会删掉两侧星号', () => {
    editor = mount('<p>a **b** c</p>');
    select(editor, 4, 5); // 选中 "b"
    editor.commands.toggleBold();
    expect(text()).toBe('a b c');
    expect(editor.isActive('bold')).toBe(false);
  });

  it('取消后选区仍然覆盖原文字', () => {
    editor = mount('<p>a **bcd** e</p>');
    select(editor, 4, 7);
    editor.commands.toggleBold();
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe('bcd');
  });

  it('加了再取消回到完全相同的文本', () => {
    editor = mount('<p>hello world</p>');
    const before = text();
    select(editor, 6, 11);
    editor.commands.toggleBold();
    editor.commands.toggleBold();
    expect(text()).toBe(before);
  });

  it('嵌套时只取消最内层', () => {
    editor = mount('<p>***x***</p>');
    select(editor, 3, 4);
    editor.commands.toggleBold();
    expect(text()).toBe('*x*');
  });
});

/* ═════════════════════════════════════════════════════════
 * 与手打语法等价
 * ════════════════════════════════════════════ */

describe('命令与手打等价', () => {
  it('命令加粗与手打星号得到完全相同的文档', () => {
    editor = mount('<p>ab</p>');
    select(editor, 0, 2);
    editor.commands.toggleBold();
    const viaCommand = JSON.stringify(editor.state.doc.toJSON());

    editor.destroy();
    host.remove();
    editor = mount('<p>**ab**</p>');
    const viaTyping = JSON.stringify(editor.state.doc.toJSON());

    expect(viaCommand).toBe(viaTyping);
  });
});

/* ═════════════════════════════════════════════════════════
 * 链接
 * ════════════════════════════════════════════ */

describe('链接命令', () => {
  it('给选区加链接', () => {
    editor = mount('<p>点这里</p>');
    select(editor, 0, 3);
    editor.commands.setMarkdownLink('https://x.dev');
    expect(text()).toBe('[点这里](https://x.dev)');
    expect(editor.isActive('link')).toBe(true);
  });

  it('对已有链接改写 URL', () => {
    editor = mount('<p>[t](https://old.dev)</p>');
    select(editor, 1, 2);
    editor.commands.setMarkdownLink('https://new.dev');
    expect(text()).toBe('[t](https://new.dev)');
  });

  it('取消链接保留文字', () => {
    editor = mount('<p>a [t](https://x.dev) b</p>');
    select(editor, 3, 4);
    editor.commands.unsetMarkdownLink();
    expect(text()).toBe('a t b');
  });
});

/* ═════════════════════════════════════════════════════════
 * 标题级别
 * ════════════════════════════════════════════ */

describe('标题级别命令', () => {
  it('给段落设置二级标题会写入 "## "', () => {
    editor = mount('<p>标题</p>');
    editor.commands.setHeadingLevel(2);
    expect(text()).toBe('## 标题');
    expect(editor.state.doc.firstChild!.type.name).toBe('heading');
    expect(editor.state.doc.firstChild!.attrs.level).toBe(2);
  });

  it('改级别时替换井号数量', () => {
    editor = mount('<p>## 标题</p>');
    editor.commands.setHeadingLevel(4);
    expect(text()).toBe('#### 标题');
    expect(editor.state.doc.firstChild!.attrs.level).toBe(4);
  });

  it('对当前级别再次执行会退回段落', () => {
    editor = mount('<p>### 标题</p>');
    editor.commands.setHeadingLevel(3);
    expect(text()).toBe('标题');
    expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
  });

  it('传 0 直接退回段落', () => {
    editor = mount('<p># 标题</p>');
    editor.commands.setHeadingLevel(0);
    expect(text()).toBe('标题');
  });
});

/* ═════════════════════════════════════════════════════════
 * 撤销
 * ════════════════════════════════════════════ */

describe('命令的撤销行为', () => {
  it('一次撤销即可回退整个格式操作', () => {
    editor = mount('<p>hello world</p>');
    select(editor, 6, 11);
    editor.commands.toggleBold();
    expect(text()).toBe('hello **world**');
    editor.commands.undo();
    expect(text()).toBe('hello world');
  });
});
