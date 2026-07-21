import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearMarkdownHtmlCache,
  parseMarkdownToHtml,
  stripThoughtPlaceholders,
} from './markdownRender';

describe('parseMarkdownToHtml lists & tables', () => {
  beforeEach(() => {
    clearMarkdownHtmlCache();
  });

  it('renders a tight priority list as a single ul', () => {
    const html = parseMarkdownToHtml(
      '### 改进建议优先级\n\n- **P0** 先修 markdown 重复列表\n- **P1** 表格窄屏换行\n- **P2** 其他 polish',
    );
    expect(html).toContain('<h3 class="md-h3">改进建议优先级</h3>');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain('<strong>P0</strong>');
    // 不得把 li 再包进 p（浏览器会重排成重影列表）
    expect(html).not.toMatch(/<p[^>]*>\s*<li/);
    expect(html).not.toMatch(/<p[^>]*>[\s\S]*<ul/);
  });

  it('merges loose list items with blank lines into one list', () => {
    const html = parseMarkdownToHtml(`### 改进建议优先级

- **P0 · 必须**

  修复 markdown 重复列表与重叠

- **P1 · 应该**

  表格窄屏 overflow

- **P2 · 可以**

  细节优化
`);
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain('修复 markdown 重复列表与重叠');
    expect(html).toContain('表格窄屏 overflow');
    // 续行应并入 li，而不是拆成段落后再开新列表
    expect(html).toMatch(
      /<li class="md-li"><strong>P0 · 必须<\/strong><br \/>修复 markdown/,
    );
  });

  it('merges ordered list items with indented continuations', () => {
    const html = parseMarkdownToHtml(`## 改进建议优先级

1. **高**
   修复列表重复渲染问题
2. **中**
   改进表格在窄屏下的表现
3. **低**
   细节 polish
`);
    expect((html.match(/<ol/g) || []).length).toBe(1);
    expect((html.match(/<ul/g) || []).length).toBe(0);
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain('修复列表重复渲染问题');
  });

  it('does not let italic * eat asterisk list markers', () => {
    const html = parseMarkdownToHtml(
      '* **P0**：修复 *markdown* 列表重复\n* **P1**：改进 *table* 样式',
    );
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(2);
    expect(html).toContain('<em>markdown</em>');
    expect(html).toContain('<em>table</em>');
    // 不得留下残片 `markdown*` / 整行被 em 吞掉
    expect(html).not.toContain('markdown*');
    expect(html).not.toMatch(/<em>\s*<strong>P0/);
  });

  it('keeps dash lists with italic intact', () => {
    const html = parseMarkdownToHtml('- **P0** 先修 *重复* 列表\n- **P1** 表格');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect(html).toContain('<em>重复</em>');
  });

  it('splits mixed ul/ol into separate lists (not one ol)', () => {
    const html = parseMarkdownToHtml('- a\n- b\n1. c\n2. d');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<ol/g) || []).length).toBe(1);
    expect(html).toContain('md-ul');
    expect(html).toContain('md-ol');
  });

  it('renders task lists inside one ul', () => {
    const html = parseMarkdownToHtml('- [ ] todo one\n- [x] done two\n- normal three');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect(html).toContain('md-task-item');
    expect(html).toContain('md-task-box checked');
  });

  it('does not convert dash lines inside fenced code into lists', () => {
    const html = parseMarkdownToHtml('code:\n\n```\n- a\n- b\n```\n\n- real list\n- item 2');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(2);
    expect(html).toContain('md-code-block');
    // 代码块内的 "- a/b" 不得变成 <li>（高亮可能包 span）
    expect(html).toContain('md-code-copy');
    expect(html).not.toContain('data-copy=');
    const codeInner = html.match(/<code class="language-">([\s\S]*?)<\/code>/)?.[1] ?? '';
    expect(codeInner).toContain('-');
    expect(codeInner).not.toContain('<li');
  });

  it('renders GFM tables with wrap and inline bold in cells', () => {
    const html = parseMarkdownToHtml(`### 改进建议优先级

| 优先级 | 建议 | 说明 |
| --- | --- | --- |
| **P0** | 重复列表 | 必须 |
| P1 | 窄屏表格 | 应该 |
`);
    expect(html).toContain('md-table-wrap');
    expect(html).toContain('md-table');
    expect(html).toContain('<strong>P0</strong>');
    expect((html.match(/<table/g) || []).length).toBe(1);
  });

  it('does not emit duplicate list markers for priority section', () => {
    const raw = `**改进建议优先级**

1. **P0**：修复 markdown 助手「改进建议优先级」重复渲染（大列表 + 小浮层列表）
2. **P1**：表格在窄屏下边框重叠、灰块过重
3. **P2**：列表在窄容器内换行撕裂
`;
    const html = parseMarkdownToHtml(raw);
    expect((html.match(/<ol/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
    // 每条正文只出现一次
    expect(html.split('大列表 + 小浮层列表').length - 1).toBe(1);
    expect(html.split('边框重叠').length - 1).toBe(1);
  });

  it('applies GFM column alignment from separator', () => {
    const html = parseMarkdownToHtml(`| L | C | R |
|:---|:---:|---:|
| a | b | c |
`);
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:right');
    // left is default — no style attr required
    expect(html).toContain('md-table');
    expect(html).toContain('scope="col"');
  });

  it('stripes alternating table body rows', () => {
    const html = parseMarkdownToHtml(`| A | B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |
| 5 | 6 |
`);
    expect(html).toContain('md-tr-alt');
    // 仅偶数索引行（1-based 第 2 行）带 alt：3 行体 → 1 条 alt
    expect((html.match(/md-tr-alt/g) || []).length).toBe(1);
  });

  it('renders fenced code with language badge', () => {
    const html = parseMarkdownToHtml('```ts\nconst x = 1;\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-code-lang');
    // highlight.js 可能把 ts 规范为 typescript；徽章与 class 同源
    expect(html).toMatch(/md-code-lang"[^>]*>(ts|typescript)</);
    expect(html).toMatch(/data-lang="(ts|typescript)"/);
    expect(html).toMatch(/language-(ts|typescript)/);
    // 无语言 fence 不画空徽章
    const plain = parseMarkdownToHtml('```\nplain\n```');
    expect(plain).toContain('md-code-block');
    expect(plain).not.toContain('md-code-lang');
  });

  it('nests indented child list under parent item', () => {
    const html = parseMarkdownToHtml(`- parent
  - child a
  - child b
- sibling
`);
    expect(html).toContain('md-ul-nested');
    expect((html.match(/<li/g) || []).length).toBe(4);
    // nested ul sits inside first li
    expect(html).toMatch(/<li class="md-li">parent<ul class="md-ul md-ul-nested">/);
  });

  it('nests multi-level indented lists (grandchildren)', () => {
    const html = parseMarkdownToHtml(`- root
  - child
    - grand
  - child2
- sibling
`);
    expect((html.match(/md-ul-nested/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/<li/g) || []).length).toBe(5);
    expect(html).toContain('grand');
    // grand 应在 child 的嵌套 ul 内，而不是与 child 同级
    expect(html).toMatch(
      /<li class="md-li">child<ul class="md-ul md-ul-nested"><li class="md-li">grand<\/li><\/ul>/,
    );
  });

  it('strips 本轮总结 heading noise before render', () => {
    const html = parseMarkdownToHtml('## 本轮总结\n\n实际正文内容');
    expect(html).not.toContain('本轮总结');
    expect(html).toContain('实际正文内容');
  });

  it('strips reinforced 本轮总结 variants (colon / brackets / bold / bare / EN)', () => {
    const variants = [
      '## 本轮总结：',
      '### 本轮小结',
      '**本轮回顾**',
      '**本轮总结：**',
      '【本轮总结】',
      '本轮总结',
      '本轮小结：',
      '## 本轮工作总结',
      '### 本回合小结 ·',
      '本轮内容回顾：',
      '## Round summary',
      '## Session summary:',
      '## Turn summary',
      '**Round summary**',
      'Round summary:',
    ];
    for (const line of variants) {
      const stripped = stripThoughtPlaceholders(`${line}\n\n保留正文`);
      expect(stripped, `should strip: ${line}`).not.toMatch(
        /本轮|本回合|Round\s+summary|Session\s+summary|Turn\s+summary/i,
      );
      expect(stripped).toContain('保留正文');
    }
    // 正文里提到「本轮总结」不应被整段清空
    const keep = stripThoughtPlaceholders('请在文末写本轮总结段落，不要省略细节。');
    expect(keep).toContain('本轮总结段落');
  });

  it('renders plus-sign unordered lists', () => {
    const html = parseMarkdownToHtml('+ alpha\n+ beta\n+ gamma');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain('alpha');
    expect(html).toContain('gamma');
  });

  it('parses fence info string first token as language', () => {
    const html = parseMarkdownToHtml('```ts title="demo"\nconst n = 1;\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('language-typescript');
    expect(html).toContain('>typescript<');
    expect(html).toContain('md-code-copy');
    expect(html).not.toContain('data-copy=');
  });

  it('renders trailing unclosed fence as code block (streaming)', () => {
    const html = parseMarkdownToHtml('intro\n\n```js\nconsole.log(1);\nconst x = 2;');
    expect(html).toContain('md-code-block');
    expect(html).toContain('language-javascript');
    expect(html).toContain('md-code-copy');
    expect(html).not.toContain('data-copy=');
    // 未闭合时不应把代码行当正文列表/段落泄漏成裸 ```
    expect(html).not.toContain('```');
  });

  it('maps c++ fence alias to cpp language id', () => {
    const html = parseMarkdownToHtml('```c++\nint main() {}\n```');
    expect(html).toContain('language-cpp');
    expect(html).toContain('md-code-lang');
  });

  it('does not treat a horizontal rule as a table separator', () => {
    const html = parseMarkdownToHtml('before\n\n---\n\nafter');
    expect(html).not.toContain('md-table');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('pads short table body rows to header column count', () => {
    const html = parseMarkdownToHtml(`| A | B | C |
| --- | --- | --- |
| only |
`);
    expect(html).toContain('md-table');
    // 一行仍有 3 个 td
    const row = html.match(/<tbody><tr class="md-tr">([\s\S]*?)<\/tr><\/tbody>/)?.[1] ?? '';
    expect((row.match(/<td/g) || []).length).toBe(3);
  });

  it('escapes raw HTML in markdown body (no script injection)', () => {
    const html = parseMarkdownToHtml('hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('hello');
  });

  it('blocks javascript: and data: links (unsafe scheme → span, no href)', () => {
    const js = parseMarkdownToHtml('[click](javascript:alert(1))');
    expect(js).not.toMatch(/href\s*=\s*["']?javascript:/i);
    expect(js).toContain('md-a-unsafe');
    expect(js).toContain('click');
    expect(js).not.toContain('<a class="md-a"');

    const data = parseMarkdownToHtml('[x](data:text/html,<script>alert(1)</script>)');
    // data: 且 URL 含空格时正则可能截断；若匹配到则不得成可点链
    if (data.includes('md-a') || data.includes('href')) {
      expect(data).not.toMatch(/href\s*=\s*["']?data:/i);
    }

    const vbs = parseMarkdownToHtml('[v](vbscript:msgbox(1))');
    expect(vbs).not.toMatch(/href\s*=\s*["']?vbscript:/i);
    expect(vbs).toContain('md-a-unsafe');
  });

  it('allows http(s) and mailto links', () => {
    const http = parseMarkdownToHtml('[web](https://example.com/a)');
    expect(http).toContain('href="https://example.com/a"');
    expect(http).toContain('rel="noreferrer"');
    const mail = parseMarkdownToHtml('[me](mailto:a@b.com)');
    expect(mail).toContain('href="mailto:a@b.com"');
  });

  it('blocks dangerous image src (javascript / non-image data)', () => {
    const jsImg = parseMarkdownToHtml('![x](javascript:alert(1))');
    expect(jsImg).not.toMatch(/src\s*=\s*["']?javascript:/i);
    expect(jsImg).not.toContain('<img');

    const badData = parseMarkdownToHtml('![y](data:text/html,hi)');
    expect(badData).not.toContain('<img');
    expect(badData).not.toMatch(/src\s*=\s*["']?data:text\/html/i);
  });

  it('escapes HTML special chars inside table cells', () => {
    const html = parseMarkdownToHtml(`| A | B |
| --- | --- |
| <b>x</b> | a&b |
`);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('a&amp;b');
  });

  it('normalizes CRLF list lines into one ul', () => {
    const html = parseMarkdownToHtml('- a\r\n- b\r\n- c');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
  });

  it('nests ordered list under unordered parent', () => {
    const html = parseMarkdownToHtml(`- parent
  1. one
  2. two
- sibling
`);
    expect(html).toContain('md-ol-nested');
    expect((html.match(/<li/g) || []).length).toBe(4);
    expect(html).toMatch(
      /<li class="md-li">parent<ol class="md-ol md-ol-nested">/,
    );
  });

  it('strips 正在思考占位 without wiping following body', () => {
    const stripped = stripThoughtPlaceholders('正在思考中…\n\n正文来了');
    expect(stripped).not.toMatch(/正在思考/);
    expect(stripped).toContain('正文来了');
    const html = parseMarkdownToHtml('正在处理...\n\n- item');
    expect(html).not.toContain('正在处理');
    expect(html).toContain('<li');
  });

  it('returns empty string for empty / whitespace-only after strip', () => {
    expect(parseMarkdownToHtml('')).toBe('');
    expect(parseMarkdownToHtml('正在思考中…')).toBe('');
    expect(stripThoughtPlaceholders('')).toBe('');
  });

  it('renders code fence copy button without data-copy payload', () => {
    const html = parseMarkdownToHtml("```\nconst s = 'hi';\n```");
    // 正文在 pre 内；复制钮不再塞 data-copy，避免属性截断/误显
    expect(html).toContain('md-code-copy');
    expect(html).not.toContain('data-copy=');
    expect(html).toContain('md-code-pre');
    expect(html).toMatch(/const|hljs-keyword/);
  });

  it('truncates wide table body rows to header column count', () => {
    const html = parseMarkdownToHtml(`| A | B |
| --- | --- |
| 1 | 2 | 3 | 4 |
`);
    const row = html.match(/<tbody><tr class="md-tr">([\s\S]*?)<\/tr><\/tbody>/)?.[1] ?? '';
    expect((row.match(/<td/g) || []).length).toBe(2);
    expect(html).not.toContain('>3<');
    expect(html).not.toContain('>4<');
  });

  it('renders empty task checkbox and checked X variants', () => {
    const html = parseMarkdownToHtml('- [ ] open\n- [X] done caps\n- [x] done lower');
    expect((html.match(/md-task-item/g) || []).length).toBe(3);
    expect((html.match(/md-task-box checked/g) || []).length).toBe(2);
    expect((html.match(/md-task-item done/g) || []).length).toBe(2);
  });

  it('does not treat bare pipe prose as a table without separator', () => {
    const html = parseMarkdownToHtml('a | b | c\nnot a table line');
    expect(html).not.toContain('md-table');
    expect(html).toContain('a | b | c');
  });

  // ── empty input ──────────────────────────────────────────────
  it('returns empty for whitespace-only and nullish-like blanks', () => {
    expect(parseMarkdownToHtml('')).toBe('');
    expect(parseMarkdownToHtml('   ')).toBe('');
    expect(parseMarkdownToHtml('\n\n\t\n')).toBe('');
    expect(parseMarkdownToHtml('   \r\n  \r\n')).toBe('');
    expect(stripThoughtPlaceholders('   \n\t  ')).toBe('');
    expect(stripThoughtPlaceholders('---')).toBe('---'); // strip 不剥 HR；render 会
    expect(parseMarkdownToHtml('---')).toBe('');
    expect(parseMarkdownToHtml('***')).toBe('');
    expect(parseMarkdownToHtml('___')).toBe('');
  });

  // ── XSS-safe escapes ─────────────────────────────────────────
  it('blocks zero-width / bidi-smuggled javascript: hrefs', () => {
    // U+200B between letters
    const zw = parseMarkdownToHtml(`[x](java\u200bscript:alert(1))`);
    expect(zw).not.toMatch(/href\s*=/i);
    expect(zw).toContain('md-a-unsafe');

    // BOM prefix
    const bom = parseMarkdownToHtml(`[x](\ufeffjavascript:alert(1))`);
    expect(bom).not.toMatch(/href\s*=\s*["']?javascript:/i);
    expect(bom).toContain('md-a-unsafe');

    // bidi override
    const bidi = parseMarkdownToHtml(`[x](\u202ejavascript:alert(1))`);
    expect(bidi).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it('escapes quotes and angle brackets in link text and URL attrs', () => {
    const html = parseMarkdownToHtml(`[say "hi" <ok>](https://ex.com/a?q="b"&c='d')`);
    expect(html).toContain('href="https://ex.com/a?q=&quot;b&quot;&amp;c=&#39;d&#39;"');
    expect(html).toContain('say &quot;hi&quot; &lt;ok&gt;');
    expect(html).not.toContain('say "hi"');
  });

  it('blocks data:image/svg+xml but allows raster data:image/png', () => {
    const svg = parseMarkdownToHtml('![x](data:image/svg+xml;base64,PHN2Zy9+)');
    expect(svg).not.toContain('<img');
    expect(svg).not.toMatch(/src\s*=\s*["']?data:image\/svg/i);

    const png = parseMarkdownToHtml('![ok](data:image/png;base64,iVBOR)');
    expect(png).toContain('<img');
    expect(png).toContain('src="data:image/png;base64,iVBOR"');
    expect(png).toContain('alt="ok"');
  });

  it('escapes raw HTML in list items and headings', () => {
    const li = parseMarkdownToHtml('- <img src=x onerror=alert(1)>\n- **<em>x</em>**');
    expect(li).not.toContain('<img src=x');
    expect(li).toContain('&lt;img');
    expect(li).toContain('<strong>&lt;em&gt;x&lt;/em&gt;</strong>');

    const h = parseMarkdownToHtml('## Title <script>x</script>');
    expect(h).toContain('<h2');
    expect(h).toContain('&lt;script&gt;');
    expect(h).not.toContain('<script>x</script>');
  });

  // ── CJK wrapping ─────────────────────────────────────────────
  it('inserts wbr between CJK and Latin for narrow wrap', () => {
    const html = parseMarkdownToHtml('修复markdown列表重复问题');
    // CJK|Latin and Latin|CJK boundaries
    expect(html).toContain('复<wbr>m');
    expect(html).toContain('n<wbr>列');
    // wbr must not appear inside tag attributes
    expect(html).not.toMatch(/class="[^"]*<wbr>/);
  });

  it('inserts wbr in long pure-CJK runs (table cells + paragraphs)', () => {
    // 20 CJK chars → at least one break every 10
    const long = '这是一段很长的中文用于测试窄屏表格单元格断行效果如何';
    expect(long.replace(/[^\u4e00-\u9fff]/g, '').length).toBeGreaterThan(10);
    const para = parseMarkdownToHtml(long);
    expect(para).toContain('<wbr>');
    expect((para.match(/<wbr>/g) || []).length).toBeGreaterThanOrEqual(1);

    const table = parseMarkdownToHtml(`| 列 | 值 |
| --- | --- |
| ${long} | 短 |
`);
    expect(table).toContain('md-td');
    expect(table).toContain('<wbr>');
    // 属性里不得被插入 wbr
    expect(table).not.toMatch(/class="md-td"[^>]*<wbr>/);
  });

  it('CJK wrap does not break bold/code around mixed text', () => {
    const html = parseMarkdownToHtml('代码`const x`与**粗体Text**混排');
    expect(html).toContain('<code class="md-inline-code">const x</code>');
    expect(html).toContain('<strong>');
    expect(html).toContain('粗体');
    expect(html).toContain('Text');
  });

  // ── table edge cases ─────────────────────────────────────────
  it('keeps escaped pipes inside a single table cell', () => {
    const html = parseMarkdownToHtml(`| A | B |
| --- | --- |
| a \\| b | c |
`);
    expect(html).toContain('md-table');
    const row = html.match(/<tbody><tr class="md-tr">([\s\S]*?)<\/tr><\/tbody>/)?.[1] ?? '';
    expect((row.match(/<td/g) || []).length).toBe(2);
    expect(row).toContain('a | b');
    expect(row).toContain('>c<');
  });

  it('renders header-only tables with empty tbody', () => {
    const html = parseMarkdownToHtml(`| H1 | H2 |
| --- | --- |
`);
    expect(html).toContain('md-table');
    expect(html).toContain('<th class="md-th"');
    expect(html).toContain('<tbody></tbody>');
    expect(html).toContain('H1');
    expect(html).toContain('H2');
  });

  it('pads alignment when separator has fewer columns than header', () => {
    const html = parseMarkdownToHtml(`| A | B | C |
|:---|---:|
| 1 | 2 | 3 |
`);
    expect(html).toContain('md-table');
    // 用 <th\b 避免误计 <thead
    expect((html.match(/<th\b/g) || []).length).toBe(3);
    expect((html.match(/<td\b/g) || []).length).toBe(3);
    // first col left (from :---), second right; third defaults left (no style)
    expect(html).toContain('text-align:right');
  });

  it('renders empty middle cells without dropping columns', () => {
    const html = parseMarkdownToHtml(`| A | B | C |
| --- | --- | --- |
| x |  | z |
`);
    const row = html.match(/<tbody><tr class="md-tr">([\s\S]*?)<\/tr><\/tbody>/)?.[1] ?? '';
    expect((row.match(/<td/g) || []).length).toBe(3);
    expect(row).toContain('>x<');
    expect(row).toContain('>z<');
    expect(row).toMatch(/<td class="md-td"><\/td>/);
  });

  // ── list edge cases ──────────────────────────────────────────
  it('emits start attribute for ordered lists beginning above 1', () => {
    const html = parseMarkdownToHtml('5. fifth\n6. sixth');
    expect(html).toContain('<ol class="md-ol" start="5">');
    expect((html.match(/<li/g) || []).length).toBe(2);
    expect(html).toContain('fifth');
    // start at 1 should not emit start=
    const fromOne = parseMarkdownToHtml('1. a\n2. b');
    expect(fromOne).toContain('<ol class="md-ol">');
    expect(fromOne).not.toContain('start=');
  });

  it('keeps empty list items as li nodes', () => {
    const html = parseMarkdownToHtml('- \n- b\n- ');
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain('>b<');
  });

  it('nests lists when child is tab-indented', () => {
    const html = parseMarkdownToHtml('- parent\n\t- child tab\n- sibling');
    expect(html).toContain('md-ul-nested');
    expect(html).toContain('child tab');
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toMatch(
      /<li class="md-li">parent<ul class="md-ul md-ul-nested"><li class="md-li">child tab<\/li><\/ul>/,
    );
  });

  it('renders adjacent table then list without fusing', () => {
    const html = parseMarkdownToHtml(`| A | B |
| --- | --- |
| 1 | 2 |

- item one
- item two
`);
    expect((html.match(/<table/g) || []).length).toBe(1);
    expect((html.match(/<ul/g) || []).length).toBe(1);
    expect((html.match(/<li/g) || []).length).toBe(2);
    // table wrap before list
    expect(html.indexOf('md-table-wrap')).toBeLessThan(html.indexOf('md-ul'));
  });

  it('does not turn table rows into list items when cell has dashes', () => {
    const html = parseMarkdownToHtml(`| 项 | 说明 |
| --- | --- |
| - 不是列表 | 值 |
`);
    expect(html).toContain('md-table');
    expect(html).not.toContain('<ul');
    expect(html).toContain('- 不是列表');
  });

  // ── HX residuals after DE (XSS / inline / images) ─────────────
  it('keeps mid-line images as img (placeholder through escape)', () => {
    const html = parseMarkdownToHtml('see ![a](https://ex.com/a.png) here');
    expect(html).toContain('<img class="md-img"');
    expect(html).toContain('src="https://ex.com/a.png"');
    expect(html).not.toContain('&lt;img');
    // 不得被裸路径正则拆碎 src
    expect(html).not.toContain('md-path-link');
  });

  it('does not apply italic inside inline code or href attributes', () => {
    const code = parseMarkdownToHtml('x `a*b*c` y');
    expect(code).toContain('<code class="md-inline-code">a*b*c</code>');
    expect(code).not.toMatch(/<code[^>]*>[\s\S]*<em>/);

    const href = parseMarkdownToHtml('[t](https://ex.com/a*b*c)');
    expect(href).toContain('href="https://ex.com/a*b*c"');
    expect(href).not.toMatch(/href="[^"]*<em>/);
  });

  it('blocks percent-encoded and angle-bracket javascript: destinations', () => {
    const pct = parseMarkdownToHtml('[x](javascript%3Aalert(1))');
    expect(pct).not.toMatch(/href\s*=/i);
    expect(pct).toContain('md-a-unsafe');

    const tabPct = parseMarkdownToHtml('[x](java%09script:alert(1))');
    expect(tabPct).not.toMatch(/href\s*=/i);
    expect(tabPct).toContain('md-a-unsafe');

    const angle = parseMarkdownToHtml('[x](<javascript:alert(1)>)');
    expect(angle).not.toMatch(/href\s*=/i);
    expect(angle).toContain('md-a-unsafe');
    // 尖括号目标整段消费，不残留 `>)`
    expect(angle).not.toMatch(/\)\s*<\/p>/);
  });

  it('allows angle-bracket http destinations with embedded parentheses', () => {
    const html = parseMarkdownToHtml('[x](<https://ex.com/foo(bar)>)');
    expect(html).toContain('href="https://ex.com/foo(bar)"');
    expect(html).toContain('rel="noreferrer"');
  });

  it('still inserts CJK wbr in link text without touching href', () => {
    const html = parseMarkdownToHtml('[修复markdown](https://ex.com/path)');
    expect(html).toContain('<wbr>');
    expect(html).toContain('href="https://ex.com/path"');
    expect(html).not.toMatch(/href="[^"]*<wbr>/);
  });

  it('escapes script tag XSS payload in markdown body', () => {
    const html = parseMarkdownToHtml('hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('hello');
    expect(html).toContain('world');
  });

  it('passes img tags through (DOMPurify sanitizes event handlers at component level)', () => {
    const html = parseMarkdownToHtml('<img onerror=alert(1) src=x>');
    expect(html).toContain('<img');
  });
});
