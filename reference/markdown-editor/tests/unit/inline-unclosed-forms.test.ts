// tests/unit/inline-unclosed-forms.test.ts
// 未闭合行内标记的解析契约（W3-3 处置：由 _scratch-a2 探索文件转正——
// 内容含未闭合 strike/math/mark 回退文本等既有测试未覆盖的行为契约，
// 探索性 console.log 剔除，断言补强为 type + raw + content 全量校验）。
//
// 契约：
// 1. 未闭合强调/代码/数学/删除线/高亮（`**bold`/`*italic`/`` `code ``/
//    `$eq`/`~~del`/`==hi`）→ 整行回退单 text token，raw 与 content 原样
//    保留（不吞字符、不产生半开结构 token）；
// 2. 闭合形式不受影响（`**bold**` → bold）；
// 3. 半闭合 `**bold*`（开 2 闭 1）→ 整体回退 text（run 长度不匹配）；
// 4. `**bold **`（闭合符前有尾随空格）→ 合法闭合 bold（content 含空格）；
// 5. 行首 `* item` → 列表标记（list_bullet），不参与强调判定；
// 6. 多行混合未闭合（`**a\n*b\n`c`）→ 各行均为 body，不跨行结构。

import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';

/** 取单行 inline token 摘要（type/raw/content，与渲染路径同源） */
function tokensOf(line: string) {
  const doc = MarkdownParser.parse(line);
  const ln = doc.lines[0];
  const inline = (ln as { inlineTokens?: unknown[] }).inlineTokens ?? [];
  return inline.map((t) => ({
    type: (t as { type: string }).type,
    raw: (t as { raw: string }).raw,
    content: (t as { content: string }).content,
  }));
}

describe('未闭合行内标记回退文本（inline unclosed forms）', () => {
  it.each([
    ['**bold', '强调（bold）'],
    ['*italic', '强调（italic）'],
    ['`code', '行内代码'],
    ['$eq', '行内数学'],
    ['~~del', '删除线'],
    ['==hi', '高亮'],
  ] as const)('%s 未闭合 → 整行回退 text，raw/content 原样保留（%s）', (md) => {
    expect(tokensOf(md)).toEqual([{ type: 'text', raw: md, content: md }]);
  });

  it('闭合形式不受影响：`**bold**` → bold', () => {
    expect(tokensOf('**bold**')).toEqual([
      { type: 'bold', raw: '**bold**', content: 'bold' },
    ]);
  });

  it('半闭合 `**bold*`（开 2 闭 1，run 长度不匹配）→ 整体回退 text', () => {
    expect(tokensOf('**bold*')).toEqual([
      { type: 'text', raw: '**bold*', content: '**bold*' },
    ]);
  });

  it('`**bold **`（闭合符前尾随空格）→ 合法闭合 bold（content 含空格）', () => {
    expect(tokensOf('**bold **')).toEqual([
      { type: 'bold', raw: '**bold **', content: 'bold ' },
    ]);
  });

  it('行首 `* item` → 列表标记 list_bullet（不参与强调判定）', () => {
    expect(tokensOf('* item')).toEqual([
      { type: 'list_bullet', raw: '* ', content: expect.any(String) },
      { type: 'text', raw: 'item', content: 'item' },
    ]);
  });

  it('多行混合未闭合（`**a\\n*b\\n`c`）→ 各行均为 body，不跨行结构', () => {
    const doc = MarkdownParser.parse('**a\n*b\n`c');
    expect(doc.lines.map((l) => l.type)).toEqual(['body', 'body', 'body']);
  });
});
