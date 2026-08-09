/**
 * CommonMark 投影器自测：黄金判定对（人工验证的投影输出断言）
 *
 * 黄金判定对的选取原则：
 * - 每个用例的期望投影均经人工逐行核对引擎 AST 行为后手工写出，
 *   再由真实引擎 parser 解析验证（开发期跑分工具已复核）；
 * - 覆盖行级结构（段落 / 标题 / 分隔线 / 引用 / 围栏代码 / 列表）、
 *   内联结构（加粗 / 代码 / 链接 / 图片）与「不支持语法不补偿」用例；
 * - 第 10 对（Setext 标题）原为防作弊样例（R0-B 时代引擎不支持 Setext，
 *   必须如实投影为两个段落）。R1 轮引擎已原生支持 Setext（heading 行 +
 *   下划线行零输出），该对随引擎现状转为正向断言，期望 <h1>。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import { astToHtml, normalizeHtml } from './astToHtml';

/** 黄金判定对：markdown → 手工核对的投影输出 */
const GOLDEN: { name: string; markdown: string; html: string }[] = [
  {
    name: '纯文本段落',
    markdown: 'hello world',
    html: '<p>hello world</p>',
  },
  {
    name: 'ATX 标题',
    markdown: '# Heading 1',
    html: '<h1>Heading 1</h1>',
  },
  {
    name: '主题分隔线',
    markdown: '---',
    html: '<hr />',
  },
  {
    name: '引用块',
    markdown: '> quoted text',
    html: '<blockquote><p>quoted text</p></blockquote>',
  },
  {
    name: '围栏代码块',
    markdown: '```\nconst a = 1;\n```',
    html: '<pre><code>const a = 1;\n</code></pre>',
  },
  {
    name: '无序列表',
    markdown: '- item one\n- item two',
    html: '<ul><li>item one</li><li>item two</li></ul>',
  },
  {
    name: '有序列表',
    markdown: '1. first\n2. second',
    html: '<ol><li>first</li><li>second</li></ol>',
  },
  {
    name: '行内加粗与代码',
    markdown: '**bold** and `code`',
    html: '<p><strong>bold</strong> and <code>code</code></p>',
  },
  {
    name: '链接与图片（含 title 拆分与 alt 提取）',
    markdown: '[link](/url "title") and ![alt](/img.png)',
    html:
      '<p><a href="/url" title="title">link</a> and ' +
      '<img src="/img.png" alt="alt" /></p>',
  },
  {
    // 防作弊样例（R0-B 时代：Setext 标题引擎不支持 → 必须如实投影为两个段落，
    // 不得补 <h1>）。R1 轮引擎已原生支持 Setext（computeSetextContexts），
    // 该对随引擎现状转为正向断言：下划线行零输出，投影单个 <h1>。
    name: 'Setext 标题（R1 引擎已支持）',
    markdown: 'title\n=====',
    html: '<h1>title</h1>',
  },
];

/** 补充投影断言（黄金对之外的边界行为） */
const EXTRA: { name: string; markdown: string; html: string }[] = [
  {
    name: '围栏代码带语言信息',
    markdown: '```js\nconst a = 1;\n```',
    html: '<pre><code class="language-js">const a = 1;\n</code></pre>',
  },
  {
    name: '有序列表非起始序号 → start 属性',
    markdown: '3. first\n4. second',
    html: '<ol start="3"><li>first</li><li>second</li></ol>',
  },
  {
    name: '斜体与加粗斜体（bold_italic 按参考实现惯例 em>strong）',
    markdown: '*em* and ***both***',
    html: '<p><em>em</em> and <em><strong>both</strong></em></p>',
  },
  {
    name: '行内原始 HTML 原样透传',
    markdown: '<span class="x">hi</span>',
    html: '<p><span class="x">hi</span></p>',
  },
  {
    name: '嵌套引用（同一引用层级连续行合并容器）',
    markdown: '> > deep\n> > # h',
    html:
      '<blockquote><blockquote><p>deep</p><h1>h</h1>' +
      '</blockquote></blockquote>',
  },
  {
    name: '代码块内高亮令牌不影响内容（按行原文投影）',
    markdown: '```\n// 注释\nconst x = 1;\n```',
    html: '<pre><code>// 注释\nconst x = 1;\n</code></pre>',
  },
  {
    // R1-A2d：缩进代码块（引擎 codeBlockState='indent_code' 产 code 行）。
    // CommonMark 缩进代码块是整块语义：连续 code 行合并为单个 <pre><code>，
    // 每行剥 4 列缩进（6 空格行 → 内容残留 2 空格），按 \n 连接并以 \n 结尾。
    name: '缩进代码块合并 + 剥 4 列缩进',
    markdown: '    a simple\n      indented code block\n',
    html: '<pre><code>a simple\n  indented code block\n</code></pre>',
  },
  {
    // R1-A2d：块内空行属于代码块（引擎 inIndentCode 保持语义），
    // 空白行剥缩进后不足 4 列的部分原样保留（spec 例 111/112 形态）。
    name: '缩进代码块内空行与空白行保留（剥缩进后残留）',
    markdown: '    chunk1\n\n    chunk2\n  \n    chunk3\n',
    html: '<pre><code>chunk1\n\nchunk2\n\nchunk3\n</code></pre>',
  },
  {
    // R1-A2d：块尾空白行（trim 后为空）不属于块内容，剔除（spec 例 117）；
    // 超过 4 列的缩进保留进内容（spec 例 116）。
    name: '缩进代码块尾空白行剔除 + 超列缩进保留',
    markdown: '    foo\n        bar\n    \n',
    html: '<pre><code>foo\n    bar\n</code></pre>',
  },
  {
    // R1-A2d 防误并：围栏内 code 行由 renderFencedBlock 消费，
    // 围栏后的缩进代码行独立成块，不得与围栏内容合并。
    name: '围栏代码与缩进代码不误合并',
    markdown: '```\nconst a = 1;\n```\n    indented\n',
    html:
      '<pre><code>const a = 1;\n</code></pre>' +
      '<pre><code>indented\n</code></pre>',
  },
];

describe('CommonMark 投影器黄金判定对（10 例，人工验证）', () => {
  for (const g of GOLDEN) {
    it(`黄金对: ${g.name}`, () => {
      const doc = MarkdownParser.parse(g.markdown);
      expect(astToHtml(doc)).toBe(g.html);
    });
  }
});

describe('CommonMark 投影器补充断言', () => {
  for (const g of EXTRA) {
    it(`补充: ${g.name}`, () => {
      const doc = MarkdownParser.parse(g.markdown);
      expect(astToHtml(doc)).toBe(g.html);
    });
  }
});

describe('归一化（渲染等价性）', () => {
  it('空白折叠：块间换行与空格等价', () => {
    expect(normalizeHtml('<p>a</p>\n<p>b</p>')).toBe(
      normalizeHtml('<p>a</p> <p>b</p>')
    );
  });

  it('属性排序 + 单双引号统一', () => {
    expect(normalizeHtml(`<a title='x' href="y">t</a>`)).toBe(
      '<a href="y" title="x">t</a>'
    );
  });

  it('自闭合标签统一为 " />"', () => {
    expect(normalizeHtml('<hr/>')).toBe('<hr />');
  });

  it('<pre> 块内容不被折叠（换行与缩进是语义）', () => {
    expect(normalizeHtml('<pre><code>  a\nb\n</code></pre>')).toBe(
      '<pre><code>  a\nb\n</code></pre>'
    );
  });

  it('文本段边缘空白剔除（HTML 渲染塌陷等价）', () => {
    expect(normalizeHtml('<p> foo </p>')).toBe('<p>foo</p>');
  });
});
