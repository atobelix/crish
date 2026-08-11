/**
 * W2-5（docs/streaming-render/00 总方案，S-T-2-08）：高亮按 fence lang
 * 分发关键字表（python/sql/bash 基础关键字；保持启发式定位）。
 *
 * - lang 由 computeLineOffsets 的围栏扫描从 fence_start 行 info 串提取，
 *   经 parseLine 传入 parseCodeLine（缓存键含 lang——同文本行在不同语言
 *   围栏内产出不同 keyword/comment token）；
 * - 未知/无语言围栏回退 JS 关键字集（现状行为不变）；
 * - 多行注释跨行不连续为已知边界（C6 登记，不修），此处固化现状；
 * - 行级渲染路径（LineItem 不传 lang）保持 JS 集（见 parseLine 末例）。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import type { LineNode } from '../../src/core/ast';

/** 覆盖守恒断言（与 parser-regression 同语义）：token raw 拼接 == 行 raw */
function assertLineCoverage(line: LineNode, ctx: string): void {
  const joined = line.inlineTokens.map((t) => t.raw).join('');
  expect(joined, `${ctx}：行 token 拼接 != 行 raw`).toBe(line.raw);
}

/** 全量 parse 中第 lineIdx 行的 inline tokens（含围栏内容行） */
function tokensOf(md: string, lineIdx = 0): LineNode['inlineTokens'] {
  const doc = MarkdownParser.parse(md);
  const line = doc.lines[lineIdx];
  assertLineCoverage(line, md);
  return line.inlineTokens;
}

/** 第 lineIdx 行指定类型 token 的内容列表 */
function tokensOfType(md: string, lineIdx: number, type: string): string[] {
  return tokensOf(md, lineIdx)
    .filter((t) => t.type === type)
    .map((t) => t.content);
}

describe('W2-5：围栏语言关键字表分发（S-T-2-08）', () => {
  it('```python 块：def/import 命中 keyword，# 注释命中 comment', () => {
    const md = '```python\ndef foo(import x):  # 注释\n```';
    const toks = tokensOf(md, 1);
    expect(toks).toEqual([
      expect.objectContaining({ type: 'keyword', content: 'def' }),
      expect.objectContaining({ type: 'text', content: ' foo(' }),
      expect.objectContaining({ type: 'keyword', content: 'import' }),
      expect.objectContaining({ type: 'text', content: ' x):  ' }),
      expect.objectContaining({ type: 'comment', content: '# 注释' }),
    ]);
  });

  it('python 关键字集命中（class/if/return/self），引号串内关键字不拆', () => {
    const toks = tokensOf('```python\nclass A:\n    if x: return self\n```', 2);
    expect(
      toks.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['if', 'return', 'self']);
    const toks2 = tokensOf('```python\ns = "def 不是关键字"\n```', 1);
    expect(
      toks2.filter((t) => t.type === 'string').map((t) => t.content)
    ).toEqual(['"def 不是关键字"']);
    expect(toks2.filter((t) => t.type === 'keyword')).toEqual([]);
  });

  it('```sql 块：SELECT/FROM 命中 keyword（大小写不敏感），-- 命中 comment', () => {
    const md = '```sql\nSELECT a, b FROM t  -- 查询\n```';
    const toks = tokensOf(md, 1);
    expect(
      toks.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['SELECT', 'FROM']);
    expect(
      toks.filter((t) => t.type === 'comment').map((t) => t.content)
    ).toEqual(['-- 查询']);
    // 小写同样命中（sql 表带 'i' 标志）
    expect(tokensOfType('```sql\nselect * from t\n```', 1, 'keyword')).toEqual([
      'select',
      'from',
    ]);
  });

  it('```bash 块：if/then/echo 命中 keyword，# 命中 comment', () => {
    const md = '```bash\nif [ -f x ]; then echo hi  # 注释\n```';
    const toks = tokensOf(md, 1);
    expect(
      toks.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['if', 'then', 'echo']);
    expect(
      toks.filter((t) => t.type === 'comment').map((t) => t.content)
    ).toEqual(['# 注释']);
  });

  it('波浪线围栏同样分发（~~~sql）；py 别名归一化到 python', () => {
    expect(tokensOfType('~~~sql\nSELECT 1\n~~~', 1, 'keyword')).toEqual([
      'SELECT',
    ]);
    expect(tokensOfType('```py\nimport x\n```', 1, 'keyword')).toEqual([
      'import',
    ]);
  });

  it('围栏内空行不中断语言继承', () => {
    const md = '```python\nimport a\n\nreturn None\n```';
    expect(tokensOfType(md, 1, 'keyword')).toEqual(['import']);
    // 空行之后语言仍继承
    expect(tokensOfType(md, 3, 'keyword')).toEqual(['return', 'None']);
  });

  it('缓存键隔离：同文本行在不同语言围栏内产出不同 token', () => {
    const py = tokensOf('```python\nreturn None\n```', 1);
    const js = tokensOf('```js\nreturn None\n```', 1);
    expect(
      py.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['return', 'None']);
    expect(
      js.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['return']);
    // js 中 None 不是关键字，保持文本（精确断言：间隙式文本 token 合并
    // 尾随段，与 W2-5 之前的 JS 行为一致——`return None` → text ' None'）
    expect(js.filter((t) => t.type === 'text').map((t) => t.content)).toEqual([
      ' None',
    ]);
    // 无语言围栏与 js 围栏同为 JS 关键字集
    const plain = tokensOf('```\nreturn None\n```', 1);
    expect(
      plain.filter((t) => t.type === 'keyword').map((t) => t.content)
    ).toEqual(['return']);
  });

  it('JS 现状行为回归：```js 与无语言围栏的 token 结构一致', () => {
    const js = tokensOf('```js\nconst x = "a"; // 注释\n```', 1);
    expect(js).toEqual([
      expect.objectContaining({ type: 'keyword', content: 'const' }),
      expect.objectContaining({ type: 'text', content: ' x = ' }),
      expect.objectContaining({ type: 'string', content: '"a"' }),
      expect.objectContaining({ type: 'text', content: '; ' }),
      expect.objectContaining({ type: 'comment', content: '// 注释' }),
    ]);
    const plain = tokensOf('```\nconst x = "a"; // 注释\n```', 1);
    expect(js.map((t) => ({ type: t.type, content: t.content }))).toEqual(
      plain.map((t) => ({ type: t.type, content: t.content }))
    );
  });

  it('未识别 lang 回退 JS 关键字集（rust）：let/function 命中、def/# 不命中', () => {
    const toks = tokensOf('```rust\ndef foo() { let x = 1; } // c\n```', 1);
    const keywords = toks
      .filter((t) => t.type === 'keyword')
      .map((t) => t.content);
    expect(keywords).toContain('let');
    expect(keywords).not.toContain('def');
    expect(
      toks.filter((t) => t.type === 'comment').map((t) => t.content)
    ).toEqual(['// c']);
  });

  it('多行注释跨行不连续为已知边界（C6 登记，不修）：单行未闭合 /* 按文本', () => {
    const toks = tokensOf('```js\n/* 未闭合\n```', 1);
    expect(toks.filter((t) => t.type === 'comment')).toEqual([]);
    expect(toks.map((t) => t.content)).toEqual(['/* 未闭合']);
    // 对照：python 的 # 单行注释命中；JS 的 # 不是注释
    expect(tokensOfType('```python\n# 注释\n```', 1, 'comment')).toEqual([
      '# 注释',
    ]);
    expect(tokensOfType('```js\n# 不是注释\n```', 1, 'comment')).toEqual([]);
  });

  it('parseLine 行级调用（渲染路径）不传 lang 保持现状：python 词按文本', () => {
    const node = MarkdownParser.parseLine('def foo():  # 注释', 0, 'code');
    expect(node.inlineTokens.filter((t) => t.type === 'keyword')).toEqual([]);
    expect(node.inlineTokens.filter((t) => t.type === 'comment')).toEqual([]);
    assertLineCoverage(node, 'parseLine 行级调用');
  });

  it('parseLine 显式 lang 参数（全量 parse 同路径）：def 命中 keyword', () => {
    const node = MarkdownParser.parseLine(
      'def foo():  # 注释',
      0,
      'code',
      0,
      null,
      false,
      null,
      null,
      false,
      'python'
    );
    expect(
      node.inlineTokens
        .filter((t) => t.type === 'keyword')
        .map((t) => t.content)
    ).toEqual(['def']);
    expect(
      node.inlineTokens
        .filter((t) => t.type === 'comment')
        .map((t) => t.content)
    ).toEqual(['# 注释']);
    assertLineCoverage(node, 'parseLine lang 参数');
  });
});
