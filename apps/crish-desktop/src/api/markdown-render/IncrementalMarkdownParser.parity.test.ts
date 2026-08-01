// @vitest-environment jsdom
/**
 * 增量态 ↔ 完成态 parity 测试（PE-02 T02.4 验收锚点）。
 *
 * 链路说明：
 *   - 完成态权威 = Rust `core_md_render`（syntect + ammonia）；前端测试环境中以
 *     `parseMarkdownToHtml`（TS 同步渲染器）作为结构 SoT 参照——该渲染器与 Rust
 *     的结构 parity 由 markdownRender.parity.test.ts ↔ crates/conex-markdown/
 *     tests/integration.rs 双向锁定（同 tag 序列、同 class 集合、文本实体一致）。
 *   - 本文件断言三层：
 *     (a) 增量等价：逐帧 push（每帧携带累计全文，与组件 D3 驱动一致）的最终
 *         块结构与「最终全文一次 push」完全一致；
 *     (b) 结构契约：增量最终 HTML 满足共享 PARITY_FIXTURES 的 mustContain/
 *         mustMatch/counts（即 Rust 完成态 SoT 的 CSS 契约：md-p/md-h1/
 *         md-code-block/md-table…）；
 *     (c) 文本实体：增量最终 DOM 与 parseMarkdownToHtml 输出的 textContent 一致
 *         （fence 内部高亮 span 差异放行——DOM 文本对比天然忽略 tag 差异）。
 *
 * 已知语义差异（放行项，与 Rust↔TS INTENTIONAL_DIFFERENCES 同源）：
 *   - 嵌套列表：增量解析器扁平化到一级（实现约束），完成态 Rust 渲染嵌套结构；
 *   - 引用块：增量解析器按段落处理（保留文本实体）；
 *   - 表格 lookahead：解析器需 header+sep 两行同帧可见；跨帧拆分会退化为段落，
 *     完成态由 Rust finalize 收敛为表格（帧切分在本测试中不拆分 lookahead 对）。
 */
import { describe, expect, it } from 'vitest';
import {
  IncrementalMarkdownParser,
  type BlockNode,
} from './IncrementalMarkdownParser';
import { parseMarkdownToHtml } from '../markdownRender';
import { PARITY_FIXTURES } from '../fixtures/markdown-parity-cases';
import { isTableRowLine, isTableSepLine } from './markdownTable';

// ── 工具 ───────────────────────────────────────────────────────────────────

/**
 * 把全文切成「自然帧」逐帧 push（模拟流式帧）。
 * 帧边界规则：
 *   - 空行闭合当前帧（保留双换行的块分隔语义；连续空行归一）；
 *   - 表格 header+sep 相邻对不跨帧拆分——解析器表格识别需要 1 行 lookahead，
 *     两行必须同帧可见；跨帧拆分会退化为段落（解析器已知流式局限，完成态
 *     由 Rust finalize 收敛为表格）。
 */
function naturalFrames(fullText: string): string[] {
  const lines = fullText.split('\n');
  const frames: string[] = [];
  let acc = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.trim() === '') {
      if (acc) {
        // 空行结束当前帧：\n\n 保持块分隔语义
        acc = `${acc}\n\n`;
        frames.push(acc);
        acc = '';
      }
      continue;
    }
    acc = acc ? `${acc}\n${line}` : line;
    if (
      isTableRowLine(line) &&
      next !== undefined &&
      isTableSepLine(next)
    ) {
      // header + sep 同帧：lookahead 可见
      acc = `${acc}\n${next}`;
      i += 1;
    }
  }
  if (acc) frames.push(acc);
  return frames;
}

/**
 * 按帧逐帧 push（与组件 D3 驱动一致：每帧携带累计全文 push(fullText)，
 * 解析器内部按 finalizedLineCount 增量处理）。
 */
function pushByFrames(fullText: string): {
  finalizedBlocks: BlockNode[];
  tailBlock: BlockNode | null;
} {
  const parser = new IncrementalMarkdownParser();
  let accumulated = '';
  let last: ReturnType<IncrementalMarkdownParser['push']> | null = null;
  for (const frame of naturalFrames(fullText)) {
    accumulated += frame;
    last = parser.push(accumulated);
  }
  return {
    finalizedBlocks: [...parser.finalizedBlocks],
    tailBlock: last?.tailBlock ?? null,
  };
}

/** 最终形态 HTML：finalized 块 + tail 块（与 IncrementalDomRenderer 的 DOM 布局一致） */
function finalHtmlOf(result: {
  finalizedBlocks: BlockNode[];
  tailBlock: BlockNode | null;
}): string {
  return [
    ...result.finalizedBlocks.map((b) => b.html),
    result.tailBlock?.html ?? '',
  ].join('');
}

/**
 * DOM 文本实体归一化：去除全部 whitespace（块边界换行 / <br> / CJK wbr 拆字
 * 差异放行；只比对实体序列，与「归一化 whitespace 后比较」口径一致）。
 */
function textEntitiesOf(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, '');
}

/** 断言 HTML 的文本实体包含目标文本（两侧均去除 whitespace） */
function textContainsEntity(html: string, text: string): void {
  expect(textEntitiesOf(html)).toContain(textEntitiesOf(text));
}

function assertStructural(
  html: string,
  fixture: {
    mustContain: string[];
    mustNotContain: string[];
    mustMatch: string[];
    counts: Array<{ needle: string; exact?: number; min?: number }>;
  },
  id: string
): void {
  for (const s of fixture.mustContain) {
    expect(html, `${id} must contain ${JSON.stringify(s)}`).toContain(s);
  }
  for (const s of fixture.mustNotContain) {
    expect(html, `${id} must not contain ${JSON.stringify(s)}`).not.toContain(s);
  }
  for (const pat of fixture.mustMatch) {
    expect(html, `${id} must match /${pat}/`).toMatch(new RegExp(pat));
  }
  for (const c of fixture.counts) {
    const n = countSubstr(html, c.needle);
    if (c.exact !== undefined) {
      expect(n, `${id} count(${c.needle})`).toBe(c.exact);
    }
    if (c.min !== undefined) {
      expect(n, `${id} min count(${c.needle})`).toBeGreaterThanOrEqual(c.min);
    }
  }
}

function countSubstr(hay: string, needle: string): number {
  if (!needle) return hay.length;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

// ── 扩展 fixture（≥16 类：段落/标题/列表/嵌套/表格/fence 含未闭合/引用/混合长文） ──

interface IncParityCase {
  id: string;
  md: string;
  /** 结构断言（CSS 契约骨架） */
  asserts?: (html: string) => void;
  /** 是否参与文本实体对比（默认 true；已知差异项显式放行） */
  textParity?: boolean;
}

const EXTRA_CASES: IncParityCase[] = [
  {
    id: 'paragraphs',
    md: '第一段\n\n第二段 with **bold** and `code`\n\n第三段',
    asserts: (h) => {
      expect(countSubstr(h, 'md-p')).toBeGreaterThanOrEqual(3);
      expect(h).toContain('<strong>bold</strong>');
    },
  },
  {
    id: 'headings',
    md: '# H1\n\n## H2\n\n### H3\n\n#### H4',
    asserts: (h) => {
      expect(h).toContain('<h1 class="md-h1">H1</h1>');
      expect(h).toContain('<h2 class="md-h2">H2</h2>');
      expect(h).toContain('<h3 class="md-h3">H3</h3>');
      expect(h).toContain('<h4 class="md-h4">H4</h4>');
    },
  },
  {
    id: 'list_ul',
    md: '- alpha\n- beta\n- gamma',
    asserts: (h) => {
      expect(countSubstr(h, '<ul')).toBe(1);
      expect(countSubstr(h, '<li')).toBe(3);
      expect(h).toContain('md-ul');
      expect(h).toContain('md-li');
    },
  },
  {
    id: 'list_ol',
    md: '1. first\n2. second\n3. third',
    asserts: (h) => {
      expect(countSubstr(h, '<ol')).toBe(1);
      expect(h).toContain('md-ol');
      expect(h).toContain('start="1"');
    },
  },
  {
    id: 'list_task',
    md: '- [ ] todo\n- [x] done',
    asserts: (h) => {
      expect(h).toContain('md-task-item');
      expect(h).toContain('md-task-box');
    },
  },
  {
    // 嵌套列表：增量扁平化（已知差异，不参与严格结构断言，
    // 但文本实体仍应一致——父子项文本都在）
    id: 'list_nested',
    md: '- parent\n  - child',
    asserts: (h) => {
      expect(h).toContain('parent');
      expect(h).toContain('child');
    },
  },
  {
    // 引用：增量按段落处理，文本实体与完成态一致
    id: 'quote',
    md: '> 引用第一行\n> 引用第二行\n\n后文',
    asserts: (h) => {
      expect(h).toContain('引用第一行');
      expect(h).toContain('引用第二行');
      expect(h).toContain('后文');
    },
  },
  {
    id: 'table_basic',
    md: '| H1 | H2 |\n| --- | --- |\n| a | b |\n\n结尾段落',
    asserts: (h) => {
      expect(h).toContain('md-table');
      expect(h).toContain('<thead>');
      expect(h).toContain('<tbody>');
      expect(h).toContain('H1');
      expect(h).toContain('a');
      expect(h).toContain('b');
      expect(h).toContain('结尾段落');
    },
  },
  {
    id: 'table_align',
    md: '| L | C | u |\n| :--- | :---: | ---: |\n| a | b | c |',
    asserts: (h) => {
      expect(h).toContain('class="left"');
      expect(h).toContain('class="center"');
      expect(h).toContain('class="right"');
    },
  },
  {
    // 表格未闭合（无收尾行）→ tail 软渲染
    id: 'table_unclosed_tail',
    md: '| H1 | H2 |\n| --- | --- |\n| a | b |',
    asserts: (h) => {
      expect(h).toContain('md-table');
      expect(h).toContain('>a<');
    },
  },
  {
    id: 'fence_closed',
    md: '```ts\nconst x = 1;\n```',
    asserts: (h) => {
      expect(h).toContain('md-code-block');
      expect(h).toContain('language-typescript');
    },
  },
  {
    // 未闭合 fence 软渲染：内容可见、外壳完整（T02.2 G1 验收锚点）
    id: 'fence_unclosed',
    md: '```typescript\nconst a = 1;\nlet b = 2;',
    asserts: (h) => {
      expect(h).toContain('md-code-block');
      // hljs 行级高亮拆 span → 文本实体断言源码可见
      textContainsEntity(h, 'const a = 1;');
      textContainsEntity(h, 'let b = 2;');
    },
  },
  {
    id: 'fence_file_path',
    md: '```ts file="src/a.ts"\nconst a = 1;\n```',
    textParity: false,
    asserts: (h) => {
      expect(h).toContain('md-code-block');
      textContainsEntity(h, 'const a = 1;');
    },
  },
  {
    id: 'inline_styles',
    md: '**bold** *italic* `code` [link](https://example.com)',
    asserts: (h) => {
      expect(h).toContain('<strong>bold</strong>');
      expect(h).toContain('<em>italic</em>');
      expect(h).toContain('md-a');
    },
  },
  {
    id: 'hr_and_blocks',
    md: '前文\n\n---\n\n后文',
    asserts: (h) => {
      expect(h).toContain('前文');
      expect(h).toContain('后文');
      // HR 不产生块
      expect(h).not.toContain('<hr');
    },
  },
  {
    // 混合长文：标题 + 列表 + fence + 表格 + 段落（≥30 行）
    id: 'mixed_long',
    md: [
      '# 混合长文',
      '',
      '引言段落，包含 **加粗** 与 `行内码`。',
      '',
      '## 列表',
      '',
      '- 项目 A',
      '- 项目 B',
      '- 项目 C',
      '',
      '## 代码',
      '',
      '```rust',
      'fn main() {',
      '    println!("hello");',
      '}',
      '```',
      '',
      '## 表格',
      '',
      '| 名称 | 数量 |',
      '| --- | ---: |',
      '| 苹果 | 3 |',
      '| 香蕉 | 5 |',
      '',
      '## 结尾',
      '',
      '最后一段正文，确认整体结构一致。',
      '',
    ].join('\n'),
    asserts: (h) => {
      expect(countSubstr(h, 'md-h1')).toBe(1);
      expect(countSubstr(h, 'md-h2')).toBe(4);
      expect(countSubstr(h, '<ul')).toBe(1);
      expect(countSubstr(h, '<li')).toBe(3);
      expect(countSubstr(h, 'md-code-block')).toBe(1);
      expect(countSubstr(h, 'md-table')).toBe(1);
      expect(countSubstr(h, 'md-p')).toBeGreaterThanOrEqual(2);
    },
  },
  {
    id: 'empty_and_whitespace',
    md: '  首行带缩进  \n\n\n\n结尾',
    asserts: (h) => {
      expect(h).toContain('首行带缩进');
      expect(h).toContain('结尾');
    },
  },
];

// ── 测试 ───────────────────────────────────────────────────────────────────

describe('IncrementalMarkdownParser parity（增量态 ↔ 完成态）', () => {
  describe('共享 PARITY_FIXTURES：增量最终 HTML 满足 Rust SoT 结构契约', () => {
    for (const fixture of PARITY_FIXTURES) {
      it(`fixture ${fixture.id}`, () => {
        const incremental = pushByFrames(fixture.md);
        const html = finalHtmlOf(incremental);
        expect(html.length).toBeGreaterThan(0);
        assertStructural(html, fixture, fixture.id);
        // 文本实体与全量渲染器一致
        expect(textEntitiesOf(html)).toBe(
          textEntitiesOf(parseMarkdownToHtml(fixture.md))
        );
      });
    }
  });

  describe('增量等价：逐帧 push == 最终全文一次 push', () => {
    const cases = [
      ...EXTRA_CASES.map((c) => ({ id: c.id, md: c.md })),
      ...PARITY_FIXTURES.map((f) => ({ id: f.id, md: f.md })),
    ];
    for (const c of cases) {
      it(`${c.id}`, () => {
        const inc = pushByFrames(c.md);
        const oneShot = new IncrementalMarkdownParser().push(c.md);
        expect(inc.finalizedBlocks.map((b) => b.type)).toEqual(
          oneShot.finalizedBlocks.map((b) => b.type)
        );
        expect(inc.finalizedBlocks.map((b) => b.html)).toEqual(
          oneShot.finalizedBlocks.map((b) => b.html)
        );
        expect(inc.tailBlock?.html).toBe(oneShot.tailBlock?.html);
        expect(inc.finalizedBlocks.length).toBe(oneShot.blockCount);
      });
    }
  });

  describe('结构骨架 + 文本实体与全量渲染器（Rust SoT 参照）一致', () => {
    for (const c of EXTRA_CASES) {
      it(`${c.id}`, () => {
        const html = finalHtmlOf(pushByFrames(c.md));
        c.asserts?.(html);
        if (c.textParity !== false) {
          expect(textEntitiesOf(html)).toBe(
            textEntitiesOf(parseMarkdownToHtml(c.md))
          );
        }
      });
    }
  });
});
