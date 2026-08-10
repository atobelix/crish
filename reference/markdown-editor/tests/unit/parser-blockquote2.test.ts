import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import type { LineNode } from '../../src/core/ast';

/**
 * B8a：CommonMark 块引用语义提升（P2 轮 1）——spec 例 228-252 专项断言。
 * 覆盖五个语义项：懒延续（Laziness）/ 空引用行 / 引用内列表 /
 * 引用内 fence-math / 嵌套引用边界。与 tests/commonmark/run-compliance.mjs
 * 的投影配合跑分互补（本文件只做 AST 层断言，投影层由跑分验证）。
 * 已知边界：spec 例 236/237 的完整 HTML 投影依赖 B8b 域投影器
 * （collectIndentCode 按 blockquoteLevel 分组 / renderFencedBlock 遇
 * 非 code 行终止），引擎 AST 层已正确，此处按引擎语义断言。
 */

/** 便捷断言辅助：取行的 type / bq / listIndent / headingLevel 快照 */
function snap(line: LineNode) {
  return {
    type: line.type,
    bq: line.blockquoteLevel,
    listIndent: line.listIndent,
    listContinuation: line.listContinuation,
    headingLevel: line.headingLevel,
  };
}

describe('B8a 块引用语义：懒延续（spec 5.2 Laziness 规则 2）', () => {
  it('`> bar` 后无标记行继承块引用层级（例 247）', () => {
    const r = MarkdownParser.parse('> bar\nbaz\n');
    // 第二行无标记：懒延续到 1 层容器，blockquoteLevel 继承为 1
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('懒延续与非懒延续混合（例 233：`> bar\nbaz\n> foo`）', () => {
    const r = MarkdownParser.parse('> bar\nbaz\n> foo\n');
    // 三行全部并入同一 1 层容器段落
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('标题行后的懒延续（例 232：`> # Foo\n> bar\nbaz`）', () => {
    const r = MarkdownParser.parse('> # Foo\n> bar\nbaz\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'heading', headingLevel: 1, bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('空行阻断懒延续（例 248：`> bar\n\nbaz`）', () => {
    const r = MarkdownParser.parse('> bar\n\nbaz\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'empty' });
    // 空行后首行不懒延续：无块引用层级（文档根段落）
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: undefined });
  });

  it('hr 块结构不懒延续（例 234：`> foo\n---`）', () => {
    const r = MarkdownParser.parse('> foo\n---\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(r.lines[1].type).toBe('hr');
    expect(r.lines[1].blockquoteLevel).toBeUndefined();
  });

  it('列表块结构不懒延续（例 235：`> - foo\n- bar`）', () => {
    const r = MarkdownParser.parse('> - foo\n- bar\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    // 无标记列表行是块结构（非段落延续文本）：开新列表，不继承层级
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: undefined });
    expect(
      r.lines[1].inlineTokens?.some((t) => t.type === 'list_bullet')
    ).toBe(true);
  });

  it('三级嵌套懒延续（例 250：`> > > foo\nbar`）', () => {
    const r = MarkdownParser.parse('> > > foo\nbar\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 3 });
    // 无标记行懒延续到最内层（3 层）容器
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 3 });
  });

  it('标记层数不足仍懒延续（例 251：`>>> foo\n> bar\n>>baz`）', () => {
    const r = MarkdownParser.parse('>>> foo\n> bar\n>>baz\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 3 });
    // `> bar` 自身 1 层、`>>baz` 自身 2 层：均不足 3 层，懒延续继承 3 层
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 3 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 3 });
  });

  it('标记层数充足时不懒延续（`> q\n> > deep` 第二行自身 2 层）', () => {
    const r = MarkdownParser.parse('> q\n> > deep\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 2 });
  });

  it('4 空格缩进行是段落延续文本（例 238：`> foo\n    - bar`）', () => {
    const r = MarkdownParser.parse('> foo\n    - bar\n');
    // 缩进代码块不能打断段落：4 空格行懒延续为段落文本，
    // 不产出列表 token（spec 说明：「- bar 缩进过深无法开列表」）
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 1 });
    expect(
      r.lines[1].inlineTokens?.some((t) => t.type === 'list_bullet')
    ).toBe(false);
    expect(
      r.lines[1].inlineTokens?.some((t) => t.type === 'text' && t.content.includes('- bar'))
    ).toBe(true);
  });
});

describe('B8a 块引用语义：空引用行（例 239-241/244/249）', () => {
  it('空引用行分隔同容器两段落（例 244：`> foo\n>\n> bar`）', () => {
    const r = MarkdownParser.parse('> foo\n>\n> bar\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    // 纯标记行输出 empty（投影器据此阻断段落合并，产出两个 <p>）
    expect(snap(r.lines[1])).toMatchObject({ type: 'empty', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('单行空引用（例 239：`>`）', () => {
    const r = MarkdownParser.parse('>\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'empty', bq: 1 });
  });

  it('空引用行不阻断后续文档根段落（例 249：`> bar\n>\nbaz`）', () => {
    const r = MarkdownParser.parse('> bar\n>\nbaz\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'empty', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: undefined });
  });

  it('纯标记行 raw 保留原文（覆盖守恒）', () => {
    const r = MarkdownParser.parse('>  \n');
    expect(r.lines[0].type).toBe('empty');
    expect(r.lines[0].raw).toBe('>  ');
  });
});

describe('B8a 块引用语义：引用内列表', () => {
  it('`> - foo` 列表判定在引用前缀剥离后（例 235 前半）', () => {
    const r = MarkdownParser.parse('> - foo\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1, listIndent: 0 });
    expect(
      r.lines[0].inlineTokens?.some((t) => t.type === 'list_bullet')
    ).toBe(true);
  });

  it('引用内任务列表（`> - [x] done`）', () => {
    const r = MarkdownParser.parse('> - [x] done\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(
      r.lines[0].inlineTokens?.some((t) => t.type === 'list_task' && t.isChecked)
    ).toBe(true);
  });

  it('引用内有序列表（`> 1. one`）', () => {
    const r = MarkdownParser.parse('> 1. one\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(
      r.lines[0].inlineTokens?.some((t) => t.type === 'list_number')
    ).toBe(true);
  });
});

describe('B8a 块引用语义：引用内围栏与数学块', () => {
  it('引用内围栏完整开闭（`> ```\n> code\n> ```）', () => {
    const r = MarkdownParser.parse('> ```\n> code\n> ```\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'code_fence_start', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'code', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'code_fence_end', bq: 1 });
  });

  it('引用内开栏后无标记行：围栏随容器终止（例 237 引擎 AST）', () => {
    const r = MarkdownParser.parse('> ```\nfoo\n```\n');
    // 引擎 AST：开栏在 1 层容器、foo 是文档根段落（不懒延续——前一行
    // 是 fence 块非段落）、``` 是文档根新围栏（EOF 隐式关闭）。
    // 完整 HTML 投影（<p>foo</p> 与第二个空 <pre><code>）依赖 B8b 域
    // 投影器 renderFencedBlock 遇非 code 行终止。
    expect(snap(r.lines[0])).toMatchObject({ type: 'code_fence_start', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: undefined });
    expect(snap(r.lines[2])).toMatchObject({ type: 'code_fence_start', bq: undefined });
  });

  it('引用内开栏后无标记行：围栏内容止于容器（spec Fenced code 章节实证）', () => {
    // spec 用例：`> ```\n> aaa\n\nbbb` —— 空行随容器终止，fence 内容只有 aaa
    const r = MarkdownParser.parse('> ```\n> aaa\n\nbbb\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'code_fence_start', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'code', bq: 1 });
    // 空行被回写为 none（不属于 fence 内容）
    expect(snap(r.lines[2])).toMatchObject({ type: 'empty', bq: undefined });
    // bbb 是文档根段落
    expect(snap(r.lines[3])).toMatchObject({ type: 'body', bq: undefined });
  });

  it('引用内数学块完整开闭', () => {
    const r = MarkdownParser.parse('> $$\n> E=mc^2\n> $$\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'math_fence_start', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'math_block', bq: 1 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'math_fence_end', bq: 1 });
  });

  it('引用内数学块随容器终止（`> $$\nfoo\n$$）', () => {
    const r = MarkdownParser.parse('> $$\nfoo\n$$\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'math_fence_start', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: undefined });
    expect(snap(r.lines[2])).toMatchObject({ type: 'math_fence_start', bq: undefined });
  });

  it('引用内缩进代码止于容器变化（例 252 引擎 AST）', () => {
    const r = MarkdownParser.parse('>     code\n\n>    not code\n');
    // L0：引用内缩进代码（1 层）；L1：空行不属代码块（随容器终止）；
    // L2：新容器的 body 行。完整投影（两个 <blockquote>）由 B8b 域
    // 投影器 collectIndentCode 按 blockquoteLevel 分组保证。
    expect(snap(r.lines[0])).toMatchObject({ type: 'code', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'empty', bq: undefined });
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('同容器缩进代码延续保持（`>     a\n>     b`）', () => {
    const r = MarkdownParser.parse('>     a\n>     b\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'code', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'code', bq: 1 });
  });

  it('文档级缩进代码跨空行保持（`    a\n\n    b`）', () => {
    const r = MarkdownParser.parse('    a\n\n    b\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'code' });
    expect(snap(r.lines[1])).toMatchObject({ type: 'code' });
    expect(snap(r.lines[2])).toMatchObject({ type: 'code' });
  });
});

describe('B8a 块引用语义：嵌套引用边界', () => {
  it('层级递减切换（`> > foo\n> bar`：2 层容器内懒延续）', () => {
    const r = MarkdownParser.parse('> > foo\n> bar\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 2 });
    // `> bar` 自身 1 层 < 段落 2 层：懒延续继承 2 层（cmark 语义——
    // bar 并入最内层段落，而非降级到 1 层容器）
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 2 });
  });

  it('层级递增切换（`> foo\n> > bar`：1 层 → 2 层）', () => {
    const r = MarkdownParser.parse('> foo\n> > bar\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 2 });
  });

  it('无空格嵌套标记（`>>> foo` 与 `>>baz` 懒延续）', () => {
    const r = MarkdownParser.parse('>>> foo\n>>baz\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 3 });
    // `>>baz` 自身 2 层 < 段落 3 层：懒延续继承 3 层（例 251 同构）
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 3 });
  });

  it('懒延续不跨容器升降：hr 后新容器（例 246：`> aaa\n***\n> bbb`）', () => {
    const r = MarkdownParser.parse('> aaa\n***\n> bbb\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    expect(r.lines[1].type).toBe('hr');
    expect(snap(r.lines[2])).toMatchObject({ type: 'body', bq: 1 });
  });

  it('Setext 下划线不误伤懒延续（`> bar\nbaz\n---` 的 baz 不升级为标题）', () => {
    const r = MarkdownParser.parse('> bar\nbaz\n---\n');
    expect(snap(r.lines[0])).toMatchObject({ type: 'body', bq: 1 });
    // baz 是懒延续行：不参与 Setext 判定（level 保持 0，type 保持 body）
    expect(snap(r.lines[1])).toMatchObject({ type: 'body', bq: 1, headingLevel: 0 });
    expect(snap(r.lines[2])).toMatchObject({ type: 'hr' });
  });
});
