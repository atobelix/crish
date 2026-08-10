/**
 * B8c（CommonMark 最后批次）parser 行为固化：
 * 代码 span run 语义 / 硬换行标记 / Raw HTML 严格文法 / 块引用 3 空格
 * 缩进上限 / 围栏缩进门——每项对应 spec 用例编号，防止回退。
 *
 * 覆盖守恒断言复用 parser-regression 的语义：顶层 token raw 拼接 == 行 raw。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import type { LineNode } from '../../src/core/ast';

function assertLineCoverage(line: LineNode, ctx: string): void {
  const joined = line.inlineTokens.map((t) => t.raw).join('');
  expect(joined, `${ctx}：行 token 拼接 != 行 raw`).toBe(line.raw);
}

function tokensOf(md: string, lineIdx = 0): LineNode['inlineTokens'] {
  const doc = MarkdownParser.parse(md);
  const line = doc.lines[lineIdx];
  assertLineCoverage(line, md);
  return line.inlineTokens;
}

describe('B8c：代码 span run 语义（CommonMark 6.1）', () => {
  it('等长 run 闭合：开括 1 反引号跳过 2-run 内容（spec 例 330/331/340）', () => {
    expect(tokensOf('` `` `')).toEqual([
      expect.objectContaining({ type: 'code', content: '``' }),
    ]);
    expect(tokensOf('`  ``  `')).toEqual([
      expect.objectContaining({ type: 'code', content: ' `` ' }),
    ]);
    expect(tokensOf('` foo `` bar `')).toEqual([
      expect.objectContaining({ type: 'code', content: 'foo `` bar' }),
    ]);
  });

  it('无等长闭合回退文本（spec 例 347）', () => {
    expect(tokensOf('```foo``')).toEqual([
      expect.objectContaining({ type: 'text', content: '```foo``' }),
    ]);
  });

  it('run 长度精确匹配：开 1 关 2 不算闭合（spec 例 349）', () => {
    const toks = tokensOf('`foo``bar``');
    expect(toks).toEqual([
      expect.objectContaining({ type: 'text', content: '`foo' }),
      expect.objectContaining({ type: 'code', content: 'bar' }),
    ]);
  });

  it('code span 优先于链接（spec 例 342）', () => {
    const toks = tokensOf('[not a `link](/foo`)');
    expect(toks).toEqual([
      expect.objectContaining({ type: 'text', content: '[not a ' }),
      expect.objectContaining({ type: 'code', content: 'link](/foo' }),
      expect.objectContaining({ type: 'text', content: ')' }),
    ]);
  });

  it('label 内代码 span 不终止链接（spec 例 525/537）', () => {
    const toks = tokensOf('[foo`](/uri)`');
    expect(toks[0]).toEqual(
      expect.objectContaining({ type: 'text', content: '[foo' })
    );
    expect(toks[1]).toEqual(
      expect.objectContaining({ type: 'code', content: '](/uri)' })
    );
  });

  it('代码 span 内容首尾空格归一化（首尾各剥一个，全空格保留）', () => {
    expect(tokensOf('` foo `')[0]).toEqual(
      expect.objectContaining({ type: 'code', content: 'foo' })
    );
    expect(tokensOf('` `')[0]).toEqual(
      expect.objectContaining({ type: 'code', content: ' ' })
    );
  });
});

describe('B8c：硬换行标记（CommonMark 6.13）', () => {
  it('行尾 2+ 空格 → hard_break（段落中段，spec 例 633/635）', () => {
    const toks = tokensOf('foo  \nbaz', 0);
    expect(toks).toEqual([
      expect.objectContaining({ type: 'text', content: 'foo' }),
      expect.objectContaining({ type: 'hard_break', content: '', raw: '  ' }),
    ]);
  });

  it('行尾反斜杠 → hard_break（spec 例 634）', () => {
    const toks = tokensOf('foo\\\nbaz', 0);
    expect(toks).toEqual([
      expect.objectContaining({ type: 'text', content: 'foo' }),
      expect.objectContaining({ type: 'hard_break', raw: '\\' }),
    ]);
  });

  it('块末尾行尾空白/反斜杠保持文本语义（spec 例 644/645）', () => {
    expect(tokensOf('foo\\', 0)[0]).toEqual(
      expect.objectContaining({ type: 'text', content: 'foo\\' })
    );
    expect(tokensOf('foo  ', 0)[0]).toEqual(
      expect.objectContaining({ type: 'text', content: 'foo  ' })
    );
  });

  it('单个尾随空格是软换行（不产生 hard_break）', () => {
    expect(tokensOf('foo \nbaz', 0).some((t) => t.type === 'hard_break')).toBe(
      false
    );
  });

  it('标题行尾空白不产生 hard_break（spec 例 647）', () => {
    const toks = tokensOf('### foo  ', 0);
    expect(toks.some((t) => t.type === 'hard_break')).toBe(false);
  });
});

describe('B8c：Raw HTML 严格文法（CommonMark 6.11）', () => {
  it('非法属性名 / 引号值 / 闭合带属性 → 文本转义（spec 例 619/620/622/624/632）', () => {
    expect(tokensOf('<a h*#ref="hi">')).toEqual([
      expect.objectContaining({ type: 'text', content: '<a h*#ref="hi">' }),
    ]);
    expect(tokensOf('<a href="hi\'> <a href=hi\'>')).toEqual([
      expect.objectContaining({ type: 'text' }),
    ]);
    expect(tokensOf('<a href=\'bar\'title=title>')).toEqual([
      expect.objectContaining({ type: 'text' }),
    ]);
    expect(tokensOf('</a href="foo">')).toEqual([
      expect.objectContaining({ type: 'text', content: '</a href="foo">' }),
    ]);
    expect(tokensOf('<a href="\\"">')).toEqual([
      expect.objectContaining({ type: 'text' }),
    ]);
  });

  it('注释 / PI / 声明 / CDATA 原样透传（spec 例 626-629）', () => {
    expect(tokensOf('foo <!--> foo -->')[1]).toEqual(
      expect.objectContaining({ type: 'html_tag', raw: '<!-->' })
    );
    expect(tokensOf('foo <?php echo $a; ?>')[1]).toEqual(
      expect.objectContaining({ type: 'html_tag', raw: '<?php echo $a; ?>' })
    );
    expect(tokensOf('foo <!ELEMENT br EMPTY>')[1]).toEqual(
      expect.objectContaining({ type: 'html_tag', raw: '<!ELEMENT br EMPTY>' })
    );
    expect(tokensOf('foo <![CDATA[>&<]]>')[1]).toEqual(
      expect.objectContaining({ type: 'html_tag', raw: '<![CDATA[>&<]]>' })
    );
  });

  it('自定义标签名允许连字符（spec 例 617）', () => {
    expect(tokensOf('Foo <responsive-image src="foo.jpg" />')[1]).toEqual(
      expect.objectContaining({ type: 'html_tag' })
    );
  });

  it('非法标签行不再是 type-7 HTML 块（按段落文本处理）', () => {
    const doc = MarkdownParser.parse('<a h*#ref="hi">\n');
    expect(doc.lines[0].type).toBe('body');
  });
});

describe('B8c：块引用前缀 3 空格缩进上限（spec 例 231）', () => {
  it('4 空格缩进的 > 行是缩进代码块，不是块引用', () => {
    const doc = MarkdownParser.parse('    > # Foo\n    > bar\n');
    expect(doc.lines[0].type).toBe('code');
    expect(doc.lines[0].blockquoteLevel).toBeUndefined();
    expect(doc.lines[1].type).toBe('code');
  });

  it('≤3 空格缩进的 > 行仍是块引用', () => {
    const doc = MarkdownParser.parse(' > foo\n> bar\n');
    expect(doc.lines[0].type).toBe('body');
    expect(doc.lines[0].blockquoteLevel).toBe(1);
    expect(doc.lines[1].blockquoteLevel).toBe(1);
  });

  it('`> >     > Even` 剥成 2 层（4 空格处截断，非 CommonMark 旧行为 3 层）', () => {
    const doc = MarkdownParser.parse('> >     > Even deeper plain text\n');
    expect(doc.lines[0].blockquoteLevel).toBe(2);
  });
});

describe('B8c：围栏开/闭行缩进门（spec 例 134/137）', () => {
  it('4 空格缩进的 ``` 行是缩进代码块（spec 例 134）', () => {
    const doc = MarkdownParser.parse('    ```\n    aaa\n    ```\n');
    expect(doc.lines.every((l) => l.type === 'code')).toBe(true);
  });

  it('围栏内 4 空格缩进的 ``` 行是内容，不闭合围栏（spec 例 137）', () => {
    const doc = MarkdownParser.parse('```\naaa\n    ```\n');
    expect(doc.lines[0].type).toBe('code_fence_start');
    expect(doc.lines[1].type).toBe('code');
    expect(doc.lines[2].type).toBe('code');
  });

  it('≤3 空格缩进的围栏开/闭行合法（spec 例 131）', () => {
    const doc = MarkdownParser.parse(' ```\n aaa\naaa\n```\n');
    expect(doc.lines[0].type).toBe('code_fence_start');
    expect(doc.lines[3].type).toBe('code_fence_end');
  });
});
