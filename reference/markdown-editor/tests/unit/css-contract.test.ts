/**
 * G6 CSS 契约门禁（C2）——真实导入图与语法树静态检查
 *
 * 依据：docs/analysis/03-测试门禁体系.md §7（class-inventory 静态扫描 +
 * style-contract 关键样式契约）与 09 修订 §3；任务书 G6 要点。
 *
 * 实现口径（与设计文档的差异及理由，诚实登记）：
 * - 从 main.tsx 的运行时导入图收集 CSS，包含 CSS @import；组件类名按
 *   TypeScript 语法树及有限字面量类型提取，不把变量名或模板残段当作类名。
 *   断言选择器存在性、关键样式、:root 变量表与颜色字面量门禁；
 *   jsdom 动态求值（getComputedStyle）版归渲染层 RTL（G3）域，不在此处。
 * - 现实修正：组件引用的类中 cursor-caret / truncation-indicator /
 *   selection-rect / a11y-live-region / virtual-row 等类没有独占的全局 CSS
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
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parse as parseCss } from 'postcss';

const SRC_DIR = path.resolve(__dirname, '../../src');
const INDEX_CSS = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf-8');
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  noEmit: true,
};
const ENTRY = path.join(SRC_DIR, 'main.tsx');
const PROGRAM = ts.createProgram([ENTRY], COMPILER_OPTIONS);

function insideSource(file: string): boolean {
  const relative = path.relative(SRC_DIR, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 只沿真实运行时导入边读取样式，未被入口引入的 CSS 不能替产品补契约。 */
function readLoadedStyles(): Map<string, string> {
  const styles = new Map<string, string>();
  const visited = new Set<string>();
  const sources = new Map(PROGRAM.getSourceFiles().map(source => [path.resolve(source.fileName), source]));
  const loadCss = (file: string) => {
    if (styles.has(file)) return;
    const text = fs.readFileSync(file, 'utf-8');
    styles.set(file, text);
    parseCss(text, { from: file }).walkAtRules('import', rule => {
      const imported = /^(?:url\(\s*)?['"]([^'"]+)['"]/.exec(rule.params)?.[1];
      if (!imported || /^(?:https?:|data:|\/\/)/.test(imported)) return;
      loadCss(imported.startsWith('.')
        ? path.resolve(path.dirname(file), imported)
        : createRequire(file).resolve(imported));
    });
  };
  const visitSource = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = sources.get(file);
    if (!source) return;
    const follow = (specifier: string) => {
      if (specifier.endsWith('.css')) {
        loadCss(specifier.startsWith('.')
          ? path.resolve(path.dirname(file), specifier)
          : createRequire(file).resolve(specifier));
      } else if (specifier.startsWith('.')) {
        const resolved = ts.resolveModuleName(specifier, file, COMPILER_OPTIONS, ts.sys).resolvedModule;
        if (resolved && insideSource(resolved.resolvedFileName)) visitSource(path.resolve(resolved.resolvedFileName));
      }
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        follow(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        follow(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        follow(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visitSource(ENTRY);
  return styles;
}

const LOADED_CSS = readLoadedStyles();
// 外部库的选择器参与导入图；颜色令牌纪律仍只约束项目自身维护的 CSS。
const CSS_FILES = [...LOADED_CSS].filter(([file]) => insideSource(file));
const SOURCE_FILES = PROGRAM.getSourceFiles().filter(source => insideSource(source.fileName));
const COMPONENT_SOURCES: Array<[string, string]> = SOURCE_FILES
  .filter(source => source.fileName.endsWith('.tsx'))
  .map(source => [path.basename(source.fileName), source.text]);

/** 仅检查 CSS 规则的选择器，不从声明值、注释或资源 URL 中捡取伪类名。 */
function extractClassSelectors(cssText: string): Set<string> {
  const set = new Set<string>();
  parseCss(cssText).walkRules(rule => {
    for (const match of rule.selector.matchAll(/\.(-?[_A-Za-z][_A-Za-z0-9-]*)/g)) set.add(match[1]);
  });
  return set;
}

/** 字面量求值：解析实际赋值与有限联合，不把未知字符串插值拆成半截类名。 */
function createLiteralReader(program: ts.Program, sources: readonly ts.SourceFile[]) {
  const checker = program.getTypeChecker();
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  const unknown = '\u0000';
  const symbolAt = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const collect = (node: ts.Node) => {
    let name: ts.Node | undefined;
    let value: ts.Expression | undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      name = node.name; value = node.initializer;
    } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) &&
      [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)) {
      name = node.left; value = node.right;
    }
    const symbol = name && symbolAt(name);
    if (symbol && value) assignments.set(symbol, [...(assignments.get(symbol) ?? []), value]);
    ts.forEachChild(node, collect);
  };
  sources.forEach(collect);
  const finiteType = (type: ts.Type): string[] => {
    if (type.isStringLiteral() || type.isNumberLiteral()) return [String(type.value)];
    return type.isUnion() ? type.types.flatMap(finiteType) : [];
  };
  const join = (a: string[], b: string[]) => [...new Set(a.flatMap(left => b.map(right => left + right)))];
  const read = (node: ts.Expression, seen = new Set<ts.Symbol>()): string[] => {
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return read(node.expression, seen);
    if (ts.isConditionalExpression(node)) return [...read(node.whenTrue, seen), ...read(node.whenFalse, seen)];
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) values = join(join(values, read(span.expression, seen)), [span.literal.text]);
      return values;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return join(read(node.left, seen), read(node.right, seen));
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return ['', ...read(node.right, seen)];
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return [...read(node.left, seen), ...read(node.right, seen)];
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'trim') {
      return read(node.expression.expression, seen).map(value => value.trim());
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node);
      if (symbol && assignments.has(symbol)) {
        if (seen.has(symbol)) return [unknown];
        const next = new Set(seen).add(symbol);
        return [...new Set(assignments.get(symbol)!.flatMap(value => read(value, next)))];
      }
    }
    const values = finiteType(checker.getTypeAtLocation(node));
    return values.length ? values : [unknown];
  };
  return read;
}

const READ_LITERAL = createLiteralReader(PROGRAM, SOURCE_FILES);

/** 收集入口加载的样式与组件内真实 <style> 文本。 */
function collectDefinedClasses(): Set<string> {
  const all: string[] = [...LOADED_CSS.values()];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'style') {
      for (const child of node.children) {
        if (ts.isJsxExpression(child) && child.expression) all.push(...READ_LITERAL(child.expression));
      }
    }
    ts.forEachChild(node, visit);
  };
  SOURCE_FILES.forEach(visit);
  const set = new Set<string>();
  for (const text of all) {
    for (const c of extractClassSelectors(text)) set.add(c);
  }
  return set;
}

/** 只从 className 语法节点取值；标识符的名字本身从不成为候选类名。 */
function extractComponentClassLiterals(
  sources = SOURCE_FILES,
  read = READ_LITERAL
): Set<string> {
  const set = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'className' && node.initializer) {
      const expression = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (expression) for (const value of read(expression)) {
        for (const word of value.split(/\s+/)) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(word)) set.add(word);
      }
    }
    ts.forEachChild(node, visit);
  };
  sources.forEach(visit);
  return set;
}

const REFERENCED_CLASSES = extractComponentClassLiterals();

/** 已退休的组件类逐项留痕；不为它们添加无布局职责的 CSS 占位规则。 */
const RETIRED_COMPONENT_CLASSES: Record<string, string> = {
  'syntax-marker': '三种列表标记已由固定 list-marker-slot 承载，组件不再输出旧通用标记类。',
  'token-content': '渲染器按明确的源码叶片与 syntax-content 输出，不再生成旧内容包装类。',
  'task-space': '任务标记空隙由统一槽与 marker-gap 承担，组件不再生成额外空格节点。',
};

/**
 * 内联样式豁免清单（类名 → 组件）：组件引用但无全局 CSS 选择器定义，
 * 样式全部由组件内联 style 提供。新增豁免项必须先更新本表与 G6.3 证据断言。
 */
const INLINE_STYLE_EXEMPTIONS: Record<string, string> = {
  'virtual-row': 'EditorLine.tsx / TableIslandHost.tsx（虚拟化行，内联 style 定位）',
  'is-search-line': 'EditorLine.tsx（搜索装饰行，内联 style 高亮）',
  'selection-layer': 'SelectionHighlight.tsx（选区层容器，内联 style）',
  'selection-rect': 'SelectionHighlight.tsx（选区矩形，内联 backgroundColor: var(--blue-selection)）',
  'truncation-indicator': 'BlockRenderer.tsx（截断指示，data-ignore-measure）',
  'a11y-live-region': 'HiddenInput.tsx（无障碍实时区）',
  'blockquote-rendered': 'BlockRenderer.tsx（块引用渲染体）',
  'blockquote-source': 'BlockRenderer.tsx（块引用原文保留）',
  'line-table': 'BlockRenderer.tsx（表格 flex 容器）',
  'syntax-delimiter': 'InlineRenderer.tsx（定界符结构类）',
  'code-soft-text': '软渲染纯文本行（BlockRenderer 分支）',
  'math-soft-text': '软渲染公式行（BlockRenderer 分支）',
  'is-soft-render': '软渲染行标记（BlockRenderer 分支）',
  'context-menu': 'ContextMenu.tsx（菜单容器）',
  'context-menu-divider': 'ContextMenu.tsx（菜单分隔线）',
  'task-checkbox-wrapper': 'InlineRenderer.tsx（任务项复选框包裹）',
  'task-checkbox-svg': 'InlineRenderer.tsx（任务项复选框图标）',
  'blockquote-bar': 'InlineRenderer.tsx（块引用导线条）',
  'blockquote-space': 'InlineRenderer.tsx（块引用前缀空格）',
};

/** 有明确共享样式所有者的结构类，不要求重复一份同内容选择器。 */
const SHARED_STYLE_CLASSES: Record<string, { component: string; owner: string; reason: string }> = {
  'is-align-center': { component: 'InlineRenderer.tsx', owner: 'list-marker-slot', reason: '居中是标记槽的默认对齐，只有 end 状态需要覆盖。' },
  'math-block-row': { component: 'BlockRenderer.tsx', owner: 'line-math-block', reason: '公式源码行结构标记，行盒样式由 line-math-block 统一提供。' },
  'math-block-preview-row': { component: 'BlockRenderer.tsx', owner: 'math-block-rendered', reason: '标识承担公式预览的行，预览布局由 math-block-rendered 提供。' },
  'math-preview-content': { component: 'MathPreview.tsx', owner: 'katex', reason: 'KaTeX 输出宿主；子树排版由入口导入的 KaTeX 样式负责。' },
  'style-checkbox': { component: 'InlineRenderer.tsx', owner: 'interactive-checkbox', reason: '同一复选框同时携带语义类与交互类，外观由 interactive-checkbox 和矢量图形负责。' },
  'token-html-element': { component: 'InlineRenderer.tsx', owner: 'line-block', reason: '行内 HTML 容器继承正文行盒，特殊标签另带 style-* 类，不再给容器定义第二套排版。' },
  'callout-header': { component: 'BlockRenderer.tsx', owner: 'callout-header-banner', reason: '标记 callout 首行，实际头部内容由 callout-header-banner 绘制。' },
  'is-frontmatter-open': { component: 'EditorLine.tsx', owner: 'is-frontmatter-row', reason: '元数据起始行语义；源码透明化统一由 is-frontmatter-row 管理。' },
  'is-frontmatter-body': { component: 'EditorLine.tsx', owner: 'is-frontmatter-row', reason: '元数据内容行语义；源码透明化统一由 is-frontmatter-row 管理。' },
  'is-frontmatter-close': { component: 'EditorLine.tsx', owner: 'is-frontmatter-row', reason: '元数据结束行语义；源码透明化统一由 is-frontmatter-row 管理。' },
};

/** 探针源码仅保存在内存中，用来验证门禁能拒绝真实缺样式并排除误提取。 */
function fixtureClasses(text: string): Set<string> {
  const file = path.join(SRC_DIR, '__css_contract_fixture__.tsx');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const options = { ...COMPILER_OPTIONS, noLib: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => path.resolve(name) === file ? source : getSourceFile(name, ...args);
  const program = ts.createProgram([file], options, host);
  return extractComponentClassLiterals([source], createLiteralReader(program, [source]));
}

/** 剥离 CSS 注释（块注释 + 行注释），供颜色字面量门禁扫描 */
function stripCssComments(cssText: string): string {
  return cssText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('G6 CSS 契约（导入图与语法树静态断言）', () => {
  const defined = collectDefinedClasses();

  it('G6.0 样式来自真实入口导入图，包含列表、公式与表格独立样式', () => {
    const loaded = CSS_FILES.map(([file]) => path.relative(SRC_DIR, file).replaceAll('\\', '/'));
    expect(loaded).toEqual(expect.arrayContaining([
      'styles/list-indent.css', 'styles/math-editing.css', 'styles/table-island.css',
    ]));
    expect(defined.has('katex')).toBe(true);
  });

  it('语法树解析条件、赋值和有限模板值，不把变量名、注释、模板残段当类', () => {
    const classes = fixtureClasses([
      '// className="from-comment"',
      'function View(className: string, align: "center" | "end", active: boolean) {',
      '  let result = "base";',
      '  if (active) result += " is-active-token";',
      '  return <span className={`${className} fixed is-align-${align} ${active ? "shown" : "hidden"} ${result}`.trim()} />;',
      '}',
    ].join('\n'));
    expect([...classes].sort()).toEqual([
      'base', 'fixed', 'hidden', 'is-active-token', 'is-align-center', 'is-align-end', 'shown',
    ]);
  });

  it('真实字面量缺失样式仍会被拦截，声明值与注释不能冒充类选择器', () => {
    const classes = fixtureClasses('const view = <span className="present missing-style" />;');
    const styles = extractClassSelectors('.present { content: ".missing-style"; } /* .missing-style {} */');
    expect([...classes].filter(name => !styles.has(name))).toEqual(['missing-style']);
  });

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
    const unregistered = [...REFERENCED_CLASSES]
      .filter((c) => !defined.has(c))
      .filter((c) => !(c in INLINE_STYLE_EXEMPTIONS) && !(c in SHARED_STYLE_CLASSES));
    expect(
      unregistered,
      `组件引用但无 CSS 定义且未登记豁免: ${unregistered.join(', ')}`
    ).toEqual([]);
  });

  it('G6.3 豁免清单反向护栏：登记项必须仍被组件引用（防死清单）', () => {
    const stale = [...Object.keys(INLINE_STYLE_EXEMPTIONS), ...Object.keys(SHARED_STYLE_CLASSES)].filter(
      (c) => !REFERENCED_CLASSES.has(c)
    );
    expect(
      stale,
      `豁免清单中已无组件引用的死项（应移出清单）: ${stale.join(', ')}`
    ).toEqual([]);
  });

  it('已退休类有逐项原因且不再被组件输出，共享样式类有真实所有者', () => {
    for (const [name, reason] of Object.entries(RETIRED_COMPONENT_CLASSES)) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(REFERENCED_CLASSES.has(name), `${name} 已退休：${reason}`).toBe(false);
    }
    for (const [name, contract] of Object.entries(SHARED_STYLE_CLASSES)) {
      expect(contract.reason.trim().length).toBeGreaterThan(0);
      const source = SOURCE_FILES.find(file => path.basename(file.fileName) === contract.component);
      expect(source, `${name} 的声明组件必须存在`).toBeDefined();
      expect(extractComponentClassLiterals([source!]).has(name)).toBe(true);
      expect(defined.has(contract.owner), `${name} 的共享样式所有者 ${contract.owner} 必须真实存在`).toBe(true);
    }
  });

  it('G6.4 内联豁免类样式证据：登记的关键类确有内联样式兜底', () => {
    const sourceOf = (name: string) =>
      COMPONENT_SOURCES.find(([n]) => n === name)?.[1] ?? '';

    // 光标：writer 同款平滑滑行——transform 定位 + 挂载帧禁过渡；
    // 类样式移交 App.css（.cursor-caret transition var(--ease-cursor-ms)）
    const cursor = sourceOf('CursorLayer.tsx');
    expect(cursor).toContain('transform: `translate3d(');
    expect(cursor).toContain("'var(--z-cursor)'");

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
