/**
 * Token-in-Document 行内实时预览 —— 端到端行为测试
 *
 * 这一组用例正是旧版 InlineDecorationPlugin 全部失败的场景，
 * 用来证明新引擎真的做到了「用键盘实时编辑 Markdown 语法」。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { LivePreviewInline, STARTER_KIT_DISABLED, parseInline } from '../../core/live-preview';
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
  // 引擎的自动首解析走微任务（避开 EditorView 构造期重入）；
  // 同步测试里显式触发一次，语义等价且幂等。
  ed.commands.reconcileDocument();
  return ed;
}

/** 等待微任务队列清空，用于验证自动首解析 */
const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

/** 光标定位到块内第 offset 个字符处（块从文档位置 1 开始） */
function cursor(ed: Editor, offset: number) {
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1 + offset)));
}

/** 取出某个偏移处的 mark 名字集合 */
function marksAt(ed: Editor, offset: number): string[] {
  const $p = ed.state.doc.resolve(1 + offset);
  const node = $p.parent.childAfter($p.parentOffset).node;
  return node ? node.marks.map((m) => m.type.name).sort() : [];
}

/** 当前显形的语法区间（文档绝对位置） */
function revealedRanges(ed: Editor): string[] {
  const set: any = revealPluginKey.getState(ed.state);
  return set.find().map((d: any) => `[${d.from},${d.to})`);
}

afterEach(() => {
  editor?.destroy();
  host?.remove();
});

/* ════════════════════════════════════════════
 * 1. 语法字符真实存在于文档中
 * ════════════════════════════════════════════ */

describe('语法即真实字符', () => {
  it('挂载后自动完成首次解析（无需手动触发）', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = new Editor({
      element: host,
      extensions: [StarterKit.configure({ ...STARTER_KIT_DISABLED }), LivePreviewInline],
      content: '<p>hello **world**!</p>',
    });
    await flush();
    expect(marksAt(editor, 9)).toEqual(['bold']);
  });

  it('文档 textContent 保留完整 Markdown 源码', () => {
    editor = mount('<p>hello **world**!</p>');
    expect(editor.state.doc.textContent).toBe('hello **world**!');
  });

  it('星号被标记为 mdSyntax，中间文字带 bold', () => {
    editor = mount('<p>hello **world**!</p>');
    expect(marksAt(editor, 6)).toEqual(['bold', 'mdSyntax']); // 第一个 *
    expect(marksAt(editor, 9)).toEqual(['bold']); // "world" 里的字符
    expect(marksAt(editor, 14)).toEqual(['bold', 'mdSyntax']); // 收尾的 *
    expect(marksAt(editor, 1)).toEqual([]); // 普通文字
  });

  it('嵌套 ***x*** 同时得到 bold 与 italic', () => {
    editor = mount('<p>***x***</p>');
    expect(marksAt(editor, 3)).toEqual(['bold', 'italic']);
  });

  it('代码段的反引号带 code + mdSyntax（excludes 已放开）', () => {
    editor = mount('<p>a `code` b</p>');
    expect(marksAt(editor, 2)).toEqual(['code', 'mdSyntax']);
    expect(marksAt(editor, 4)).toEqual(['code']);
  });

  it('链接 href 落到 mark attrs 上', () => {
    editor = mount('<p>see [Conex](https://x.dev) ok</p>');
    const $p = editor.state.doc.resolve(1 + 6);
    const node = $p.parent.childAfter($p.parentOffset).node!;
    const link = node.marks.find((m) => m.type.name === 'link');
    expect(link?.attrs.href).toBe('https://x.dev');
  });
});

/* ════════════════════════════════════════════
 * 2. 用键盘实时编辑语法（旧版全部做不到）
 * ════════════════════════════════════════════ */

describe('键盘实时编辑', () => {
  it('打出 **x** 后自动变粗，且星号原样保留', () => {
    editor = mount('<p></p>');
    editor.commands.insertContent('**x**');
    expect(editor.state.doc.textContent).toBe('**x**');
    expect(marksAt(editor, 2)).toEqual(['bold']);
  });

  it('把 ** 改成 *** 就升级成粗斜体', () => {
    editor = mount('<p>**x**</p>');
    editor.view.dispatch(editor.state.tr.insertText('*', 1)); // 行首再加一个 *
    editor.view.dispatch(editor.state.tr.insertText('*', 7)); // 行尾再加一个 *
    expect(editor.state.doc.textContent).toBe('***x***');
    expect(marksAt(editor, 3)).toEqual(['bold', 'italic']);
  });

  it('删掉一个 * 让加粗降级为斜体（真正的源码编辑）', () => {
    editor = mount('<p>**x**</p>');
    expect(marksAt(editor, 2)).toEqual(['bold']);
    editor.view.dispatch(editor.state.tr.delete(1, 2)); // 删掉开头一个 *
    expect(editor.state.doc.textContent).toBe('*x**');
    expect(marksAt(editor, 1)).toEqual(['italic']);
  });

  it('删掉分隔符后格式随之消失', () => {
    editor = mount('<p>a **b** c</p>');
    editor.view.dispatch(editor.state.tr.delete(3, 5)); // 删掉前面的 **
    expect(editor.state.doc.textContent).toBe('a b** c');
    expect(marksAt(editor, 2)).toEqual([]);
  });
});

/* ════════════════════════════════════════════
 * 3. 显形 / 隐藏
 * ════════════════════════════════════════════ */

describe('语法显隐', () => {
  it('光标进入作用域时两侧分隔符同时显形', () => {
    editor = mount('<p>hello **world**!</p>');
    cursor(editor, 9); // "world" 中间
    expect(revealedRanges(editor)).toEqual(['[7,9)', '[14,16)']);
  });

  it('光标离开后不再有显形装饰', () => {
    editor = mount('<p>hello **world**!</p>');
    cursor(editor, 2);
    expect(revealedRanges(editor)).toEqual([]);
  });

  it('只为选区所在块生成装饰，其余块零开销', () => {
    editor = mount('<p>**a**</p><p>**b**</p><p>**c**</p>');
    cursor(editor, 2);
    // 只有第一段的两个分隔符
    expect(revealedRanges(editor).length).toBe(2);
  });

  it('全选时所有块的语法一起显形', () => {
    editor = mount('<p>**a**</p><p>**b**</p>');
    editor.commands.selectAll();
    expect(revealedRanges(editor).length).toBe(4);
  });
});

/* ════════════════════════════════════════════
 * 4. 贴边显形 —— 保证光标不会落进隐藏区
 * ════════════════════════════════════════════ */

describe('贴边显形不变式', () => {
  it('光标贴住作用域左右边界时分隔符仍然可见', () => {
    editor = mount('<p>a **b** c</p>');
    // 文本 a␣**b**␣c，作用域为 [2,7)
    cursor(editor, 2); // 紧贴左边界
    expect(revealedRanges(editor).length).toBe(2);
    cursor(editor, 7); // 紧贴右边界
    expect(revealedRanges(editor).length).toBe(2);
  });

  it('离开一格即收起', () => {
    editor = mount('<p>a **b** c</p>');
    cursor(editor, 1);
    expect(revealedRanges(editor)).toEqual([]);
    cursor(editor, 8);
    expect(revealedRanges(editor)).toEqual([]);
  });

  it('不变式：任何光标位置都不会停在隐藏分隔符内部或边界', () => {
    const text = 'a **b** c `d` e [f](g) h';
    editor = mount(`<p>${text}</p>`);
    const spans = parseInline(text).syntax;

    for (let offset = 0; offset <= text.length; offset++) {
      cursor(editor, offset);
      const revealed = new Set(revealedRanges(editor));
      for (const sp of spans) {
        const hidden = !revealed.has(`[${1 + sp.from},${1 + sp.to})`);
        if (!hidden) continue;
        // 隐藏的分隔符，光标必须严格在它之外（不含两端）
        expect(offset <= sp.from || offset >= sp.to).toBe(true);
      }
    }
  });
});

/* ════════════════════════════════════════════
 * 6. 序列化与撤销
 * ════════════════════════════════════════════ */

describe('序列化与撤销', () => {
  it('doc 的文本就是 Markdown 源码，序列化天然无损', () => {
    const src = 'a **b** *c* ~~d~~ ==e== `f` [g](h)';
    editor = mount(`<p>${src}</p>`);
    expect(editor.state.doc.textContent).toBe(src);
  });

  it('撤销文本变更后 marks 自动回到正确状态', () => {
    editor = mount('<p>a **b** c</p>');
    editor.view.dispatch(editor.state.tr.delete(3, 5)); // 删掉前 **
    expect(marksAt(editor, 2)).toEqual([]);
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe('a **b** c');
    expect(marksAt(editor, 4)).toEqual(['bold']);
  });

  it('重解析不产生额外的撤销步骤', () => {
    editor = mount('<p>ab</p>');
    editor.view.dispatch(editor.state.tr.insertText('**x**', 3));
    expect(editor.state.doc.textContent).toBe('ab**x**');
    editor.commands.undo();
    // 一次 undo 就回到初始文本，说明 mark 变更没有单独占一步
    expect(editor.state.doc.textContent).toBe('ab');
  });
});

/* ════════════════════════════════════════════
 * 7. 性能
 * ════════════════════════════════════════════ */

describe('性能', () => {
  it('长文档下每次击键的重解析开销', () => {
    const paras = Array.from({ length: 1000 }, (_, i) => `<p>段落 ${i} 带 **粗体** 与 *斜体*</p>`).join('');
    editor = mount(paras);
    for (let i = 0; i < 5; i++) editor.view.dispatch(editor.state.tr.insertText('x', 2));
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) editor.view.dispatch(editor.state.tr.insertText('x', 2));
    const per = (performance.now() - t0) / 100;
    console.log(`  1000 段落 → ${per.toFixed(3)} ms/击键（含重解析 + 显形装饰）`);
    expect(per).toBeLessThan(5);
  });
});
