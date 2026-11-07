/**
 * apps/crish-desktop/src/components/markdown/markdownTypographyG2.contract.test.ts
 *
 * G² 第二波丙 · markdown 族形状迁移定向契约。
 *
 * 排版层（styles/markdown-typography.css）全部 16 条 border-radius 声明
 * 逐项有落点：11 条由 markdownG2Shapes 适配器按实测尺寸挂 G² clip-path
 * （只换形状不换值），5 条登记在案不纳入（行内码/mark 待裁决 #1、
 * 伪元素无法量测、胶囊/有意直角按程序口径排除）。
 * 本文件只做源码级断言，不渲染组件；新增/删除/改值任一条声明都会
 * 在此处失败，逼迫登记先于施工。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_G2_SHAPE_EXCLUSIONS,
  MARKDOWN_G2_SHAPE_SELECTORS,
} from './markdownG2Shapes';

const STYLES = resolve(__dirname, '../../styles');

/** 读取 CSS 并剥离注释（注释内的反例文本不得被误判为真实声明） */
function readCss(...segments: string[]): string {
  const raw = readFileSync(resolve(...segments), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 抽取全部 border-radius 声明：{ 规范化选择器， 值 }（选择器空白折叠） */
function extractRadiusDeclarations(css: string): Array<{
  selector: string;
  value: string;
}> {
  const out: Array<{ selector: string; value: string }> = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const body = m[2] ?? '';
    if (!body.includes('border-radius:')) continue;
    const value = /border-radius:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
    const selector = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    out.push({ selector, value });
  }
  return out;
}

const SCOPE = ':is(.conex-markdown, .md-rendered)';

/**
 * 期望清单（16 条，与扫描 1 §2 清单 A 逐面核对；行号以本测试抽取为准，
 * 不钉行号——行号漂移不改语义）。
 * adapter：适配器选择器表中的对应条目；exclusion：未纳入登记表中的对应条目。
 */
const EXPECTED: Array<{
  selector: string;
  value: string;
  adapter?: string;
  exclusion?: string;
}> = [
  {
    selector: `${SCOPE} .md-task-checkbox`,
    value: 'var(--md-task-box-radius)',
    adapter: '.md-task-checkbox',
  },
  {
    selector: `${SCOPE} :is(blockquote, .md-quote)`,
    value: '0 var(--radius-s) var(--radius-s) 0',
    adapter: 'blockquote, .md-quote',
  },
  {
    selector: `${SCOPE} .md-callout`,
    value: 'var(--radius-m)',
    adapter: '.md-callout',
  },
  {
    selector: `${SCOPE} .md-callout-title::before`,
    value: 'var(--radius-pill)',
    exclusion: '.md-callout-title::before',
  },
  {
    selector: `${SCOPE} :is(code, .md-inline-code):not(pre code)`,
    value: 'var(--md-code-inline-radius)',
    exclusion: 'code, .md-inline-code',
  },
  {
    selector: `${SCOPE} :is(kbd, .md-kbd)`,
    value: 'var(--radius-s)',
    adapter: 'kbd, .md-kbd',
  },
  {
    selector: `${SCOPE} mark`,
    value: 'var(--radius-s)',
    exclusion: 'mark',
  },
  {
    selector: `${SCOPE} .md-path-link`,
    value: '0',
    exclusion: '.md-path-link',
  },
  {
    selector: `${SCOPE} :is(img, .md-img)`,
    value: 'var(--radius-xl)',
    adapter: 'img, .md-img',
  },
  {
    selector: `${SCOPE} details`,
    value: 'var(--radius-m)',
    adapter: 'details',
  },
  {
    selector: `${SCOPE} .md-table-wrap`,
    value: 'var(--md-table-radius)',
    adapter: '.md-table-wrap',
  },
  {
    selector: `${SCOPE} .md-code-block`,
    value: 'var(--md-code-block-radius)',
    adapter: '.md-code-block',
  },
  {
    selector: `${SCOPE} .md-code-lang`,
    value: 'var(--radius-s)',
    adapter: '.md-code-lang',
  },
  {
    selector: `${SCOPE} :is(.md-code-copy, .md-code-wrap, .md-code-fold)`,
    value: 'var(--radius-s)',
    adapter: '.md-code-copy, .md-code-wrap, .md-code-fold',
  },
  {
    selector: `${SCOPE} .md-code-actions [data-tooltip]:hover::after`,
    value: 'var(--radius-s)',
    exclusion: '.md-code-actions [data-tooltip]:hover::after',
  },
  {
    selector: `${SCOPE} .md-math-block`,
    value: 'var(--radius-m)',
    adapter: '.md-math-block',
  },
];

const mdCss = readCss(STYLES, 'markdown-typography.css');
const tokensRadius = readCss(STYLES, 'tokens-radius.css');
const tokensComponents = readCss(STYLES, 'tokens-components.css');

describe('G² 第二波丙 · markdown 族形状迁移', () => {
  it('排版层 border-radius 声明恰为 16 条，逐项值与落点与期望表一致', () => {
    const actual = extractRadiusDeclarations(mdCss);
    expect(actual).toHaveLength(EXPECTED.length);
    for (const expected of EXPECTED) {
      const hit = actual.find((a) => a.selector === expected.selector);
      expect(hit, `缺失声明：${expected.selector}`).toBeDefined();
      expect(hit?.value).toBe(expected.value);
    }
    const unexpected = actual.filter(
      (a) => !EXPECTED.some((e) => e.selector === a.selector)
    );
    expect(unexpected).toEqual([]);
  });

  it('适配面 11 条：选择器表与期望表双向一致（无孤儿选择器、无漏面）', () => {
    const adapted = EXPECTED.filter((e) => e.adapter !== undefined).map(
      (e) => e.adapter as string
    );
    expect(adapted).toHaveLength(11);
    expect([...MARKDOWN_G2_SHAPE_SELECTORS].sort()).toEqual(
      [...adapted].sort()
    );
  });

  it('未纳入面 5 条：登记表与期望表双向一致', () => {
    const excluded = EXPECTED.filter((e) => e.exclusion !== undefined).map(
      (e) => e.exclusion as string
    );
    expect(excluded).toHaveLength(5);
    expect(
      [...MARKDOWN_G2_SHAPE_EXCLUSIONS.map((e) => e.selector)].sort()
    ).toEqual([...excluded].sort());
    for (const entry of MARKDOWN_G2_SHAPE_EXCLUSIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('列表容器无 border-radius：无漏登记的列表面', () => {
    const actual = extractRadiusDeclarations(mdCss);
    const listHits = actual.filter((a) =>
      /(^|[\s>(])ul\b|(^|[\s>(])ol\b|(^|[\s>(])li\b/.test(a.selector)
    );
    expect(listHits).toEqual([]);
  });

  it('档位真值：行 6 / 控件 8 / 块档 8 / 图 16', () => {
    expect(tokensRadius).toMatch(/--radius-row:\s*6px/);
    expect(tokensRadius).toMatch(/--radius-control:\s*8px/);
    expect(tokensRadius).toMatch(/--radius-m:\s*8px/);
    expect(tokensRadius).toMatch(/--radius-s:\s*var\(--radius-row\)/);
    expect(tokensRadius).toMatch(/--radius-xl:\s*16px/);
  });

  it('markdown 专属 token 指向对应档（两作用域各一份）', () => {
    for (const [token, target] of [
      ['--md-code-block-radius', '--radius-control'],
      ['--md-table-radius', '--radius-control'],
      ['--md-task-box-radius', '--radius-row'],
      ['--md-code-inline-radius', '--radius-row'],
    ] as const) {
      const hits =
        tokensComponents.match(
          new RegExp(`${token}:\\s*var\\(${target}\\)`, 'g')
        ) ?? [];
      expect(hits, token).toHaveLength(2);
    }
  });
});
