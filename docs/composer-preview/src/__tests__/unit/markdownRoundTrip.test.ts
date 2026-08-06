/**
 * Markdown 往返保真测试
 *
 * 这组用例正是旧方案（tiptap-markdown）失败的那批：
 * 表格被压成 `ab12`、图片变成空串、`$$…$$` 里的 `\,` 变成 `,`、
 * `> [!NOTE]` 被转义成 `> \[!NOTE\]`……
 *
 * 新架构下行内语法是文档里的真字符，序列化就是取 textContent，
 * 因此这些「靠 mark 反推分隔符」时才会出现的损坏从原理上消失了。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { LivePreviewInline, STARTER_KIT_DISABLED } from '../../core/live-preview';
import { TABLE_EXTENSIONS } from '../../extensions/TableExtension';
import { docToMarkdown, markdownToDoc } from '../../core/serializer/markdown';

let editor: Editor;
let host: HTMLElement;

function makeEditor(): Editor {
  host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [
      StarterKit.configure({ ...STARTER_KIT_DISABLED }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ...TABLE_EXTENSIONS,
      LivePreviewInline,
    ],
    content: '',
  });
}

/** 走完整链路：markdown → doc → 重解析 → markdown */
function roundTrip(md: string): string {
  const ed = editor;
  const doc = markdownToDoc(md, ed.schema);
  ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, doc.content));
  ed.commands.reconcileDocument();
  return docToMarkdown(ed.state.doc).trim();
}

afterEach(() => {
  editor?.destroy();
  host?.remove();
});

describe('往返保真 — 行内语法', () => {
  const cases: Array<[string, string]> = [
    ['粗体与斜体', '**bold** and *italic*'],
    ['嵌套强调', '***bold italic***'],
    ['删除线', '~~struck~~ text'],
    ['高亮', 'a ==highlighted== word'],
    ['行内代码含管道符', 'use `a || b` here'],
    ['链接', '[text](https://example.com)'],
    ['行内公式', 'euler $e^{i\\pi}+1=0$ done'],
    ['LaTeX 反斜杠', 'integral $\\int_0^1 x\\,dx$ end'],
    ['WikiLink', 'see [[Some Page]] please'],
    ['标签', 'tagged #project here'],
    ['脚注引用', 'text[^1] here'],
    ['转义星号', 'a \\* literal star'],
    ['下划线词内不变形', 'snake_case_name stays'],
    ['HTML 下划线', 'plain <u>underlined</u> text'],
    ['图片', '![alt](img.png)'],
    ['裸链接', 'visit https://example.com now'],
    ['Windows 路径', 'open C:\\Users\\name\\file.txt'],
    ['正则字面量', 'match /^a+b*$/ pattern'],
  ];

  for (const [name, md] of cases) {
    it(name, () => {
      editor = makeEditor();
      expect(roundTrip(md)).toBe(md);
    });
  }
});

describe('往返保真 — 块级结构', () => {
  const cases: Array<[string, string]> = [
    ['标题', '## A heading'],
    ['多级标题', '# H1\n\n### H3\n\n###### H6'],
    ['标题含格式', '## 带 **粗体** 的标题'],
    ['代码块', '```ts\nconst a = 1;\n```'],
    ['代码块含反斜杠', '```\npath\\to\\file\n```'],
    ['代码块含 LaTeX', '```latex\n\\frac{1}{2}\n```'],
    ['无序列表', '- a\n- b\n- c'],
    ['有序列表', '1. one\n2. two'],
    ['任务列表', '- [ ] todo\n- [x] done'],
    ['引用', '> quoted line'],
    ['Callout 语法', '> [!NOTE]\n> body line'],
    ['分割线', 'para\n\n---\n\npara2'],
    ['段落与标题混排', '# Title\n\nbody **text**\n\n## Sub\n\nmore'],
  ];

  for (const [name, md] of cases) {
    it(name, () => {
      editor = makeEditor();
      expect(roundTrip(md)).toBe(md);
    });
  }
});

describe('往返保真 — GFM 表格', () => {
  const cases: Array<[string, string]> = [
    ['基础表格', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['列对齐', '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'],
    ['单元格含行内格式', '| **粗** | `码` |\n| --- | --- |\n| *斜* | [链](u) |'],
    ['转义竖线', '| a \\| b | c |\n| --- | --- |\n| 1 | 2 |'],
    ['空单元格', '| a |  |\n| --- | --- |\n|  | 2 |'],
    ['多行表体', '| h |\n| --- |\n| 1 |\n| 2 |\n| 3 |'],
    ['与段落混排', '前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文'],
    ['表格含公式', '| 公式 |\n| --- |\n| $e^{i\\pi}$ |'],
  ];

  for (const [name, md] of cases) {
    it(name, () => {
      editor = makeEditor();
      expect(roundTrip(md)).toBe(md);
    });
  }
});

describe('往返保真 — 幂等性', () => {
  it('二次往返结果与一次往返完全一致', () => {
    editor = makeEditor();
    const src = [
      '# 文档标题',
      '',
      '正文含 **粗体**、*斜体*、`代码` 与 [链接](https://x.dev)。',
      '',
      '## 列表',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```ts',
      'const x: number = 1;',
      '```',
      '',
      '> 引用内容',
      '',
      '---',
    ].join('\n');

    const once = roundTrip(src);
    const twice = roundTrip(once);
    expect(once).toBe(src);
    expect(twice).toBe(once);
  });
});

describe('往返保真 — 覆盖率汇总', () => {
  it('统计通过率', () => {
    editor = makeEditor();
    const all = [
      '**bold**', '*italic*', '~~s~~', '==h==', '`c`', '[t](u)',
      '$x^2$', '$$\\int$$', '[[wiki]]', '#tag', 'a\\*b', 'x_y_z',
      '<u>u</u>', '![a](b)', '## H', '- a', '1. a', '- [x] a',
      '> q', '> [!NOTE]', '---', '```js\nx\n```',
    ];
    let ok = 0;
    const failed: string[] = [];
    for (const md of all) {
      try {
        if (roundTrip(md) === md) ok++;
        else failed.push(md);
      } catch {
        failed.push(md);
      }
    }
    console.log(`  往返无损: ${ok}/${all.length}`);
    if (failed.length) console.log('  失败项:', JSON.stringify(failed));
    expect(ok).toBe(all.length);
  });
});
