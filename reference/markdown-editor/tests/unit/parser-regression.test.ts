/**
 * Parser R1 修复回归固化（R1-E：R1 正确性轮·测试矩阵固化）
 *
 * R1 轮 parser 大改清单（本文件逐项固化，防止回退）：
 * - 2^n 指数复杂度修复（未闭合链接链 / 强调符号链 / HTML 标签链）；
 * - 缓存 id 唯一性（`aaa\naaa` 同文本多行不得共享 id）；
 * - token 覆盖守恒（拼接 == raw 断言器，实体解码只发生在 content）；
 * - fence 边界 3-in-4（3 反引号开、4 反引号闭；2 反引号不闭；marker 校验）；
 * - `<u>` 非 sub（CommonMark raw HTML 语义，不得映射为下标）；
 * - 自动链接（URI / 邮件 / mailto，scheme 长度与裸域名反例）；
 * - 实体解码（命名 / 数字 / 十六进制，code span 内字面保留）；
 * - 引用链接（直接 / 折叠 / 完整 / 未定义回退 / label 归一化）；
 * - `_` 强调族围挡校验（intraword 限制、标点围挡）；
 * - 链接目标校验（非法目标 / 双 title 回退、尖括号目标、转义还原）。
 */
import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '../../src/core/parser';
import type { LineNode } from '../../src/core/ast';

// —— 工具：token 覆盖守恒断言器（拼接 == raw） ——
// 语义：每行顶层 token 的 raw 按序拼接必须等于行 raw（行级守恒）；
// 各行 raw 按 `\n` 拼接必须等于输入原文（文档级守恒）。
// 实体解码只改写 content、raw 永远保留原文，因此守恒是"不丢字"的硬不变量。

function assertLineCoverage(line: LineNode, ctx: string): void {
  const joined = line.inlineTokens.map((t) => t.raw).join('');
  expect(joined, `${ctx}：行 token 拼接 != 行 raw`).toBe(line.raw);
}

function assertDocumentCoverage(md: string, ctx: string): void {
  const doc = MarkdownParser.parse(md);
  const joinedLines = doc.lines.map((l) => l.raw).join('\n');
  expect(joinedLines, `${ctx}：文档行拼接 != 输入原文`).toBe(md);
  doc.lines.forEach((l, i) => assertLineCoverage(l, `${ctx}：第 ${i} 行`));
}

describe('R1 回归：2^n 指数复杂度修复（性能门槛）', () => {
  // 修复前：未闭合链接链 / 强调符号链 / HTML 起止标签链在行内扫描中呈
  // 指数回退（parser-redos 事故），现均坍缩为每位置至多一次的失败记忆。
  // 断言用 performance.now 包夹单次解析 < 50ms（预算远低于帧预算）。
  // 说明：测量前用一段短文本暖机，消除 vitest 首次调用模块的 JIT 冷启动
  // 开销（冷启动可达数百 ms 与算法复杂度无关）；暖机文本与测量输入不同，
  // 不会命中行级 LRU 缓存，测量值仍是真实解析耗时。
  const CASES: { name: string; input: string }[] = [
    {
      name: '未闭合链接链（`[`×1500 + `a`×6000）',
      input: '['.repeat(1500) + 'a'.repeat(6000),
    },
    {
      name: '强调符号链（`*`×10000）',
      input: '*'.repeat(10000) + 'text',
    },
    {
      name: 'HTML 标签链（`<b>`×10000 不闭合）',
      input: '<b>'.repeat(10000) + 'x',
    },
  ];

  for (const c of CASES) {
    it(`2^n 修复: ${c.name}`, () => {
      MarkdownParser.parse('JIT 暖机文本，与测量输入不同');
      const start = performance.now();
      const doc = MarkdownParser.parse(c.input);
      const duration = performance.now() - start;
      expect(duration, `解析耗时 ${duration.toFixed(1)}ms 超过 50ms 预算`).toBeLessThan(50);
      expect(doc.lines.length).toBe(1);
    });
  }
});

describe('R1 回归：缓存 id 唯一性', () => {
  it('同文本多行 id 互不相同（`aaa\naaa` 经缓存复用结构后仍逐行重发 id）', () => {
    const doc = MarkdownParser.parse('aaa\naaa');
    const ids = doc.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('重复解析相同文档（缓存命中路径）id 依旧全局唯一', () => {
    const doc1 = MarkdownParser.parse('aaa\naaa');
    const doc2 = MarkdownParser.parse('aaa\naaa');
    const allIds = [
      ...doc1.lines.map((l) => l.id),
      ...doc2.lines.map((l) => l.id),
    ];
    expect(new Set(allIds).size).toBe(4);
  });

  it('多行同一行文（fence 内容）id 唯一', () => {
    const doc = MarkdownParser.parse('x\nx\nx');
    const ids = doc.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('R1 回归：token 覆盖守恒（拼接 == raw）', () => {
  // 文档集覆盖 R1 全部改动面 + 既有核心语法，逐一跑守恒断言器
  const DOCS: { name: string; md: string }[] = [
    { name: '纯文本与空行', md: 'hello\n\nworld' },
    { name: '标题（ATX + Setext）', md: '# H\n\nsetext\n===' },
    { name: 'hr 与转义', md: '---\n\\*x\\* ***' },
    { name: '列表与任务', md: '- a\n- [x] done\n  - b\n1. n' },
    { name: '表格', md: '| a | b |\n| - | - |\n| 1 | 2 |' },
    { name: '块引用嵌套', md: '> q\n> > deep\n> cont' },
    { name: 'fence 与缩进代码', md: '```js\nlet x = 1;\n```\n    ind\n        deep' },
    { name: 'fence 3-in-4 边界', md: '```\na\n````\nb\n``' },
    { name: '数学与行内代码', md: '$x$ `c` $$$' },
    { name: '强调族混排', md: '**b** _i_ foo_bar_baz ***bi*** ~~s~~ ==m==' },
    { name: '自动链接与 HTML', md: '<http://x> <foo@bar.com> <u>u</u> <b>b</b>' },
    { name: 'HTML 块级', md: '<div>\nraw\n</div>' },
    { name: '实体解码', md: '&amp; &#35; &#x22; &ampx;' },
    { name: '引用链接', md: '[foo]: /url "t"\n\n[foo] [bar][foo] [missing][nope]' },
    { name: '链接与图片', md: '[a](/ok) ![alt](/img.png) [a](bad url)' },
    { name: '脚注与转义标点', md: '[^1] \\* \\b \\`' },
  ];

  for (const d of DOCS) {
    it(`守恒: ${d.name}`, () => {
      assertDocumentCoverage(d.md, d.name);
    });
  }
});

describe('R1 回归：fence 边界（3-in-4）', () => {
  it('3 反引号开头、4 反引号结尾：闭合（长度 ≥ 3）', () => {
    const doc = MarkdownParser.parse('```\na\n````');
    expect(doc.lines.map((l) => l.type)).toEqual([
      'code_fence_start',
      'code',
      'code_fence_end',
    ]);
  });

  it('3 反引号开头、2 反引号结尾：不闭合（长度 < 3），末行保持 code', () => {
    const doc = MarkdownParser.parse('```\na\n``');
    expect(doc.lines.map((l) => l.type)).toEqual([
      'code_fence_start',
      'code',
      'code',
    ]);
  });

  it('反引号开 fence 用波浪线闭：marker 不同不闭合', () => {
    const doc = MarkdownParser.parse('```\na\n~~~');
    expect(doc.lines.map((l) => l.type)).toEqual([
      'code_fence_start',
      'code',
      'code',
    ]);
  });

  it('波浪线开 fence 波浪线闭：正常闭合', () => {
    const doc = MarkdownParser.parse('~~~\na\n~~~');
    expect(doc.lines.map((l) => l.type)).toEqual([
      'code_fence_start',
      'code',
      'code_fence_end',
    ]);
  });
});

describe('R1 回归：`<u>` 非 sub（CommonMark raw HTML 语义）', () => {
  it('`<u>x</u>` 产出 html_element（tagName=u），严禁 sub 下标语义', () => {
    const doc = MarkdownParser.parse('<u>x</u>');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('html_element');
    expect(token.tagName).toBe('u');
    expect(token.content).toBe('x');
  });

  it('对照：`<sub>x</sub>` 才走 sub 扩展语义', () => {
    const doc = MarkdownParser.parse('<sub>x</sub>');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('sub');
  });

  it('`<u>` 与文字混排时仍为行内元素', () => {
    const doc = MarkdownParser.parse('<u>x</u>y');
    expect(doc.lines[0].inlineTokens.map((t) => t.type)).toEqual([
      'html_element',
      'text',
    ]);
  });
});

describe('R1 回归：自动链接', () => {
  it('URI 自动链接：`<http://example.com>` → link，url 为原文', () => {
    const doc = MarkdownParser.parse('<http://example.com>');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('link');
    expect(token.url).toBe('http://example.com');
    expect(token.content).toBe('http://example.com');
  });

  it('邮件自动链接：`<foo@bar.com>` → link，url 带 mailto: 前缀', () => {
    const doc = MarkdownParser.parse('<foo@bar.com>');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('link');
    expect(token.url).toBe('mailto:foo@bar.com');
  });

  it('显式 mailto：`<mailto:foo@bar.com>` → link，url 为原文', () => {
    const doc = MarkdownParser.parse('<mailto:foo@bar.com>');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.url).toBe('mailto:foo@bar.com');
  });

  it('反例：scheme 过短 `<m:abc>` / 裸域名 `<www.example.com>` 按文本回退', () => {
    const doc = MarkdownParser.parse('<m:abc> <www.example.com>');
    const types = doc.lines[0].inlineTokens.map((t) => t.type);
    expect(types.every((t) => t === 'text')).toBe(true);
  });
});

describe('R1 回归：实体解码', () => {
  it('命名实体 `&amp;` → content 解码为 `&`，raw 保留原文', () => {
    const doc = MarkdownParser.parse('&amp;');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('text');
    expect(token.content).toBe('&');
    expect(token.raw).toBe('&amp;');
  });

  it('数字与十六进制字符引用：`&#35;` `&#x22;` 解码', () => {
    const doc = MarkdownParser.parse('&#35; &#x22;');
    const [t0] = doc.lines[0].inlineTokens;
    expect(t0.content).toBe('# "');
  });

  it('无效实体（无分号 `&amp` / 未知名 `&ampx;`）原样保留', () => {
    const doc = MarkdownParser.parse('&amp &ampx;');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.content).toBe('&amp &ampx;');
  });

  it('code span 内不解码（CommonMark 字面保留）', () => {
    const doc = MarkdownParser.parse('`&amp;`');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('code');
    expect(token.content).toBe('&amp;');
  });
});

describe('R1 回归：引用链接', () => {
  const REF_DOC = '[foo]: /url "t"\n\n';

  it('直接形式 `[foo]`：查定义表产出 link', () => {
    const doc = MarkdownParser.parse(REF_DOC + '[foo]');
    const last = doc.lines[doc.lines.length - 1];
    const [token] = last.inlineTokens;
    expect(token.type).toBe('link');
    expect(token.url).toBe('/url "t"');
  });

  it('折叠形式 `[foo][]`：ref 缺省为 label 本身', () => {
    const doc = MarkdownParser.parse(REF_DOC + '[foo][]');
    const last = doc.lines[doc.lines.length - 1];
    expect(last.inlineTokens[0].type).toBe('link');
    expect(last.inlineTokens[0].url).toBe('/url "t"');
  });

  it('完整形式 `[bar][foo]`：ref 指向 foo 定义', () => {
    const doc = MarkdownParser.parse(REF_DOC + '[bar][foo]');
    const last = doc.lines[doc.lines.length - 1];
    expect(last.inlineTokens[0].type).toBe('link');
    expect(last.inlineTokens[0].url).toBe('/url "t"');
  });

  it('label 归一化：大小写折叠 + 空白折叠（`[FOO   BAR]` 命中 `[foo bar]: /u`）', () => {
    const doc = MarkdownParser.parse('[foo bar]: /u\n\n[FOO   BAR]');
    const last = doc.lines[doc.lines.length - 1];
    expect(last.inlineTokens[0].type).toBe('link');
    expect(last.inlineTokens[0].url).toBe('/u');
  });

  it('未定义引用整体回退文本（`[a][missing]`）', () => {
    const doc = MarkdownParser.parse(REF_DOC + '[a][missing]');
    const last = doc.lines[doc.lines.length - 1];
    expect(last.inlineTokens[0].type).toBe('text');
  });

  it('定义行零输出（empty 行），raw 保留原文', () => {
    const doc = MarkdownParser.parse('[foo]: /url\n\n[foo]');
    expect(doc.lines[0].type).toBe('empty');
    expect(doc.lines[0].raw).toBe('[foo]: /url');
  });

  it('定义不能打断段落（`line\n[foo]: /u\nnext` 全部按正文）', () => {
    const doc = MarkdownParser.parse('line\n[foo]: /u\nnext');
    expect(doc.lines.every((l) => l.type === 'body')).toBe(true);
  });
});

describe('R1 回归：`_` 强调族围挡校验', () => {
  it('正例：`_i_` `__b__` `___bi___` 分别产出 italic/bold/bold_italic', () => {
    const doc = MarkdownParser.parse('_i_ __b__ ___bi___');
    expect(doc.lines[0].inlineTokens.map((t) => t.type)).toEqual([
      'italic',
      'text',
      'bold',
      'text',
      'bold_italic',
    ]);
  });

  it('词内下划线不强调（intraword 限制：`foo_bar_baz` 按文本）', () => {
    const doc = MarkdownParser.parse('foo_bar_baz');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('text');
    expect(token.content).toBe('foo_bar_baz');
  });

  it('开围挡后跟空白不强调（`_ foo_` 按文本）', () => {
    const doc = MarkdownParser.parse('_ foo_');
    expect(doc.lines[0].inlineTokens[0].type).toBe('text');
  });

  it('标点围挡可成立（`a _"foo"_` 产出 italic）', () => {
    const doc = MarkdownParser.parse('a _"foo"_');
    const types = doc.lines[0].inlineTokens.map((t) => t.type);
    expect(types).toEqual(['text', 'italic']);
  });

  it('对照：`*` 族无 intraword 限制（`foo*bar*baz` 产出 italic）', () => {
    const doc = MarkdownParser.parse('foo*bar*baz');
    const types = doc.lines[0].inlineTokens.map((t) => t.type);
    expect(types).toEqual(['text', 'italic', 'text']);
  });
});

describe('R1 回归：链接目标校验', () => {
  it('裸目标含空白非法：`[a](bad url)` 整体回退文本', () => {
    const doc = MarkdownParser.parse('[a](bad url)');
    expect(doc.lines[0].inlineTokens[0].type).toBe('text');
  });

  it('尖括号目标允许空白：`[a](<http://x y>)` 正常解析', () => {
    const doc = MarkdownParser.parse('[a](<http://x y>)');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.type).toBe('link');
    expect(token.url).toBe('http://x y');
  });

  it('目标内转义还原：`[a](\\*x\\))` → url `*x)`', () => {
    const doc = MarkdownParser.parse('[a](\\*x\\))');
    const [token] = doc.lines[0].inlineTokens;
    expect(token.url).toBe('*x)');
  });

  it('双 title 非法：`[a](/u "tit" "two")` 整体回退文本', () => {
    const doc = MarkdownParser.parse('[a](/u "tit" "two")');
    expect(doc.lines[0].inlineTokens[0].type).toBe('text');
  });

  it('未闭合方括号 label 不解析：`[ref[]` 按文本', () => {
    const doc = MarkdownParser.parse('[ref[]');
    expect(doc.lines[0].inlineTokens[0].type).toBe('text');
  });
});
