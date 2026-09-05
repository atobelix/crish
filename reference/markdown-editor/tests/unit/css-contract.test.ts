/**
 * G6 CSS 契约门禁（C2）——静态文本断言版
 *
 * 依据：docs/analysis/03-测试门禁体系.md §7（class-inventory 静态扫描 +
 * style-contract 关键样式契约）与 09 修订 §3；任务书 G6 要点。
 *
 * 实现口径（与设计文档的差异及理由，诚实登记）：
 * - 本文件为「静态文本断言」版：直接读 src/index.css / App.css / 组件源码
 *   文本，断言选择器存在性、关键样式字面量、:root 变量表与颜色字面量门禁；
 *   jsdom 动态求值（getComputedStyle）版归渲染层 RTL（G3）域，不在此处。
 * - 现实修正：组件引用的类中 cursor-caret / truncation-indicator /
 *   selection-rect / a11y-live-region / virtual-row 等 18 个类没有全局 CSS
 *   选择器定义——样式全部由组件内联 style 提供（INLINE_STYLE_EXEMPTIONS
 *   登记表 + G6.3 内联样式证据断言）。故引用覆盖护栏采用
 *   「B − A ⊆ 豁免清单」口径：新增未登记类引用会炸本测试（CSS 清理护栏），
 *   豁免类逐一登记组件与内联证据，防「删了内联样式又没补 CSS」悄悄发生。
 * - 任务书点名的 .cursor-caret/.truncation-indicator/.selection-rect/
 *   .a11y-live-region 即为豁免登记对象（样式在内联 style 中），若未来
 *   迁移进 index.css，应同步从豁免清单移出（G6.3 证据断言会提示）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_DIR = path.resolve(__dirname, '../../src');
const INDEX_CSS = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf-8');
const APP_CSS = fs.readFileSync(path.join(SRC_DIR, 'App.css'), 'utf-8');
const CSS_FILES: Array<[string, string]> = [
  ['index.css', INDEX_CSS],
  ['App.css', APP_CSS],
];

/** 扫描 src 下全部 tsx 文件（含子目录），拼接 className 静态引用点文本 */
function readComponentSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx'))
        out.push([entry.name, fs.readFileSync(full, 'utf-8')]);
    }
  };
  walk(SRC_DIR);
  return out;
}
const COMPONENT_SOURCES = readComponentSources();

/** 提取 CSS 文本中的类选择器（.xxx-* 形态；排除数值/版本号误匹配如 .015em） */
function extractClassSelectors(cssText: string): Set<string> {
  const set = new Set<string>();
  for (const m of cssText.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)(?=\s*[{:,.>~+])/g)) {
    set.add(m[1]);
  }
  return set;
}

/** 收集 index.css + App.css + 组件内 <style> 块的全部类选择器 → 集合 A */
function collectDefinedClasses(): Set<string> {
  const all: string[] = CSS_FILES.map(([, text]) => text);
  for (const [, text] of COMPONENT_SOURCES) {
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      all.push(m[1]);
    }
  }
  const set = new Set<string>();
  for (const text of all) {
    for (const c of extractClassSelectors(text)) set.add(c);
  }
  return set;
}

/** 提取组件 className 字面量（含模板拼接的静态段）→ 集合 B 的一部分 */
function extractComponentClassLiterals(): Set<string> {
  const set = new Set<string>();
  for (const [, text] of COMPONENT_SOURCES) {
    // 双引号字面量（无模板）：className="line-block"
    for (const m of text.matchAll(/className="([^"]*)"/g)) {
      for (const w of m[1].matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) set.add(w[0]);
    }
    // 模板字面量：className={`a ${cond ? 'b' : 'c'} d`}（允许 `.trim()` 等后缀）——
    // ${...} 动态段整体移除（动态类单独登记），静态段词元保留
    for (const m of text.matchAll(/className=\{`([^`]*)`[^}]*\}/g)) {
      const lit = m[1].replace(/\$\{[^}]*\}/g, ' ');
      for (const w of lit.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) set.add(w[0]);
    }
  }
  return set;
}

/**
 * 动态拼接 / 映射表产出的类（不在 className 字面量里直写，任务书 G6 要点 2）：
 * - is-active-line：MarkdownEngine 模板 `virtual-row ${activeState ? 'is-active-line' : ''}`
 * - is-active-token：InlineRenderer/BlockRenderer checkIsActive 拼接产物
 * - is-search-line：搜索装饰行标记
 * - table-header-row：表格表头行标记
 */
const DYNAMIC_COMPONENT_CLASSES = [
  'is-active-line',
  'is-active-token',
  'is-search-line',
  'table-header-row',
] as const;

/**
 * 内联样式豁免清单（类名 → 组件）：组件引用但无全局 CSS 选择器定义，
 * 样式全部由组件内联 style 提供。新增豁免项必须先更新本表与 G6.3 证据断言。
 */
const INLINE_STYLE_EXEMPTIONS: Record<string, string> = {
  'virtual-row': 'MarkdownEngine.tsx（虚拟化行，内联 style 定位）',
  'is-search-line': 'MarkdownEngine.tsx（搜索装饰行，内联 style 高亮）',
  'selection-layer': 'SelectionHighlight.tsx（选区层容器，内联 style）',
  'selection-rect': 'SelectionHighlight.tsx（选区矩形，内联 backgroundColor: var(--blue-selection)）',
  'truncation-indicator': 'BlockRenderer.tsx（截断指示，data-ignore-measure）',
  'cursor-caret': 'CursorLayer.tsx（光标，内联 backgroundColor: var(--black)）',
  'a11y-live-region': 'HiddenInput.tsx（无障碍实时区）',
  'blockquote-rendered': 'BlockRenderer.tsx（块引用渲染体）',
  'blockquote-source': 'BlockRenderer.tsx（块引用原文保留）',
  'line-table': 'BlockRenderer.tsx（表格 flex 容器）',
  'syntax-delimiter': 'InlineRenderer.tsx（定界符结构类）',
  'syntax-marker': 'InlineRenderer.tsx（列表标记结构类）',
  'token-content': 'InlineRenderer.tsx（token 内容结构类）',
  'code-soft-text': '软渲染纯文本行（BlockRenderer 分支）',
  'math-soft-text': '软渲染公式行（BlockRenderer 分支）',
  'is-soft-render': '软渲染行标记（BlockRenderer 分支）',
  'context-menu': 'ContextMenu.tsx（菜单容器）',
  'context-menu-divider': 'ContextMenu.tsx（菜单分隔线）',
  'task-checkbox-wrapper': 'InlineRenderer.tsx（任务项复选框包裹）',
  'task-checkbox-svg': 'InlineRenderer.tsx（任务项复选框图标）',
  'task-space': 'InlineRenderer.tsx（任务项前缀空格）',
  'blockquote-bar': 'InlineRenderer.tsx（块引用导线条）',
  'blockquote-space': 'InlineRenderer.tsx（块引用前缀空格）',
};

/** 剥离 CSS 注释（块注释 + 行注释），供颜色字面量门禁扫描 */
function stripCssComments(cssText: string): string {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('G6 CSS 契约（静态文本断言版）', () => {
  const defined = collectDefinedClasses();

  it('G6.1 关键契约类必须存在于 CSS 定义集合（选择器存在性扫描）', () => {
    // 任务书点名的核心契约类：.line-block / .line-heading 系 / .token-* 系 /
    // .is-active-line / .is-active-token —— 这些必须在 CSS 中有选择器定义
    const keyClasses = [
      'line-block',
      // 标题系
      'line-h1', 'line-h2', 'line-h3', 'line-h4', 'line-h5', 'line-h6',
      // token 系（行内 token → class 映射产物）
      'token-keyword', 'token-string', 'token-comment',
      'token-table-cell', 'token-table-pipe', 'token-list-bullet',
      'token-list-number', 'token-list-task', 'token-heading-prefix',
      'token-blockquote-prefix', 'token-math-wrapper', 'token-html-tag',
      // 激活/选区/空态契约
      'is-active-line', 'is-active-token', 'is-selected-token',
      'is-empty-token', 'is-cell-selected', 'is-cell-editing',
      'is-selection-bottom-right',
      // 语法结构类（定界符隐藏契约）
      'syntax-hidden', 'syntax-indent', 'syntax-content', 'syntax-source',
      // 块渲染类
      'hr-rendered', 'code-lang-pill', 'code-fence-rendered',
      'code-fence-source', 'math-block-rendered', 'math-preview',
      'line-table-row', 'table-header-row', 'blockquote-guide',
      'blockquote-wrapper', 'blockquote-content',
      // 行内样式族
      'style-bold', 'style-italic', 'style-bold-italic', 'style-strike',
      'style-mark', 'style-kbd', 'style-sub', 'style-sup', 'style-spoiler',
      'style-inline-code', 'style-image', 'style-footnote', 'style-math',
    ];
    const missing = keyClasses.filter((c) => !defined.has(c));
    expect(missing, `缺失关键契约类选择器: ${missing.join(', ')}`).toEqual([]);
  });

  it('G6.2 引用覆盖护栏：组件 className ⊆ CSS 定义 ∪ 内联豁免清单', () => {
    // B − A − 豁免 = ∅：删除 class 会先炸本测试（CSS 清理护栏）
    const referenced = new Set([
      ...extractComponentClassLiterals(),
      ...DYNAMIC_COMPONENT_CLASSES,
    ]);
    const unregistered = [...referenced]
      .filter((c) => !defined.has(c))
      .filter((c) => !(c in INLINE_STYLE_EXEMPTIONS));
    expect(
      unregistered,
      `组件引用但无 CSS 定义且未登记豁免: ${unregistered.join(', ')}`
    ).toEqual([]);
  });

  it('G6.3 豁免清单反向护栏：登记项必须仍被组件引用（防死清单）', () => {
    const referenced = new Set([
      ...extractComponentClassLiterals(),
      ...DYNAMIC_COMPONENT_CLASSES,
    ]);
    const stale = Object.keys(INLINE_STYLE_EXEMPTIONS).filter(
      (c) => !referenced.has(c)
    );
    expect(
      stale,
      `豁免清单中已无组件引用的死项（应移出清单）: ${stale.join(', ')}`
    ).toEqual([]);
  });

  it('G6.4 内联豁免类样式证据：登记的关键类确有内联样式兜底', () => {
    const sourceOf = (name: string) =>
      COMPONENT_SOURCES.find(([n]) => n === name)?.[1] ?? '';

    // 光标：内联 backgroundColor: var(--black)（CursorLayer）
    const cursor = sourceOf('CursorLayer.tsx');
    expect(cursor).toContain('className="cursor-caret custom-cursor-blink"');
    expect(cursor).toContain("backgroundColor: 'var(--black)'");

    // 选区矩形：内联 backgroundColor: var(--blue-selection)（SelectionHighlight）
    const sel = sourceOf('SelectionHighlight.tsx');
    expect(sel).toContain('className="selection-rect"');
    expect(sel).toContain("backgroundColor: 'var(--blue-selection)'");

    // 截断指示：data-ignore-measure 语义（不计入测量，BlockRenderer）
    const block = sourceOf('BlockRenderer.tsx');
    expect(block).toContain('className="truncation-indicator" data-ignore-measure');

    // 无障碍实时区（HiddenInput）
    expect(sourceOf('HiddenInput.tsx')).toContain('className="a11y-live-region"');

    // 虚拟化行（MarkdownEngine）
    expect(sourceOf('MarkdownEngine.tsx')).toContain('virtual-row');
  });

  it('G6.5 行高关键值：--grid-size: 28px 变量 + min-height 28px/var()', () => {
    // 行高模型契约（03 §7 / G8 scroll-throughput 的 28px 基准）：
    // CSS 侧必须保留 28px 或 var(--grid-size) 的行高定义
    expect(INDEX_CSS).toMatch(/--grid-size:\s*28px/);
    expect(INDEX_CSS).toMatch(/min-height:\s*(?:28px|var\(--grid-size\))/);
    // line-block 容器定义存在
    expect(INDEX_CSS).toMatch(/\.line-block\s*\{/);
  });

  it('G6.6 :root 变量表完整性（逐一声明存在性）', () => {
    const requiredVars = [
      '--bg-theme', '--white', '--black',
      '--text-primary', '--text-secondary', '--text-muted',
      '--gray-45', '--gray-70', '--gray-90',
      '--yellow-text', '--yellow-tint-2',
      '--selection-bg', '--blue-selection',
      '--border-subtle', '--border-medium', '--border-focus',
      '--scrollbar-track', '--scrollbar-thumb', '--scrollbar-thumb-hover',
      '--font-mono', '--grid-size',
    ];
    const missing = requiredVars.filter((v) => !INDEX_CSS.includes(`${v}:`));
    expect(missing, `:root 缺失变量: ${missing.join(', ')}`).toEqual([]);
    // 关键变量必须参与选择器引用（抽查：选区背景与焦点边框）。
    // 注：--blue-selection 在 index.css 仅声明、无引用——实际消费方是
    // SelectionHighlight 的内联 style（见 G6.4 证据断言），故此处抽查
    // CSS 侧真实引用的 --selection-bg（编辑器 ::selection）与 --border-focus。
    expect(INDEX_CSS).toContain('var(--selection-bg)');
    expect(INDEX_CSS).toContain('var(--border-focus)');
  });

  it('G6.7 颜色字面量门禁（CSS 侧抽查）：无 hex / rgb() / 逗号式 hsl() / hsla()', () => {
    // 与 colorAdaptor 策略一致（color-gate 已管源码，此处补 CSS 文件侧：
    // 颜色必须走空格分隔 hsl() 或 var() 变量，禁硬编码 hex 与旧式字面量）
    for (const [name, css] of CSS_FILES) {
      const code = stripCssComments(css);
      const hexHits = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
      const rgbHits = [...code.matchAll(/rgba?\(/g)].map((m) => m[0]);
      const hslCommaHits = [...code.matchAll(/hsla?\(\s*\d+\s*,/g)].map((m) => m[0]);
      expect(hexHits, `${name}: 禁硬编码 hex 字面量`).toEqual([]);
      expect(rgbHits, `${name}: 禁 rgb()/rgba() 字面量`).toEqual([]);
      expect(hslCommaHits, `${name}: 禁逗号分隔 hsl()/hsla() 字面量`).toEqual([]);
    }
  });
});
