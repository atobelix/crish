// @vitest-environment jsdom
/**
 * 样式系统契约测试（审计 F7 修复回归）
 *
 * F7-F14：z-index 硬编码残留（tabDragGhost / useSessionListDrag /
 *         LeafToolTabStrip / FileViewerCard）必须 token 化，禁裸数字。
 * F7-F27：--ui-text-* 五连 token 必须在 dark 主题块内重新定义
 *         （否则暗色下仍引用 light 值，对比度不足）。
 * 批次 2 扩展（S1 契约，8 条）：
 *   ① dark 分支覆盖（泛化 F7-F27 到全部色系前缀 token）
 *   ② 禁新裸混色（text-primary 基底，ratchet 递减）
 *   ③ 禁裸 999px / 裸 99999
 *   ④ scrollbar：新出口 overlay-scrollbar.css 必须存在（禁 0 条仍绿）
 *   ⑤ !important 总量 ratchet
 *   ⑥ 注入 token 名 ∈ 静态定义名（双层同源协议约束 1）
 *   ⑦ 固定值双源同值（双层同源协议约束 2）
 *   ⑧ 悬空引用清零 + 静态兜底存在
 *
 * 采用与 Menu.lowViewport.test.tsx 相同的 fs 契约断言方式
 * （new URL(rel, import.meta.url)，不依赖 process.cwd）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const Z_INDEX_FILES = [
  'src/hooks/tab-drag/tabDragGhost.ts',
  'src/components/sidebar/session-list/useSessionListDrag.ts',
  'src/components/binary-tree/LeafToolTabStrip.module.css',
  'src/components/files/FileViewerCard.module.css',
] as const;

function readFile(relPath: string): string {
  // 注意：模板字面量先赋给中间变量再进 new URL——
  // 内联在 new URL 参数中的模板会被 transform 破坏（路径解析为 undefined）
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

interface TokenStylesheet {
  relativePath: string;
  content: string;
}

/** 解析 tokens.css 的静态相对 @import，按级联顺序读取入口及全部 token 模块。 */
function readTokenStylesheets(): TokenStylesheet[] {
  const sources = new Map<string, string>();
  const importRe = /@import\s+['"]([^'"]+)['"]\s*;/g;

  const visit = (relativePath: string): void => {
    const normalizedPath = normalize(relativePath).replace(/\\/g, '/');
    if (!normalizedPath.startsWith('src/styles/')) {
      throw new Error(
        `Token stylesheet import escapes src/styles: ${relativePath}`
      );
    }
    if (sources.has(normalizedPath)) return;

    const content = readFile(normalizedPath);
    sources.set(normalizedPath, content);
    for (const match of content.matchAll(importRe)) {
      const importPath = match[1];
      if (
        !importPath ||
        (!importPath.startsWith('./') && !importPath.startsWith('../'))
      ) {
        throw new Error(
          `Token stylesheet import must be relative: ${importPath}`
        );
      }
      visit(join(dirname(normalizedPath), importPath));
    }
  };

  visit('src/styles/tokens.css');
  return [...sources].map(([relativePath, content]) => ({
    relativePath,
    content,
  }));
}

function readTokenCss(): string {
  return readTokenStylesheets()
    .map(({ content }) => content)
    .join('\n');
}

function compactCss(css: string): string {
  return css.replace(/\s+/g, '');
}

/** 返回各 token 模块内全部匹配主题块，避免只检查首个同名选择器。 */
function readTokenThemeBlocks(pattern: RegExp): string[] {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return readTokenStylesheets().flatMap(({ content }) => {
    const matcher = new RegExp(pattern.source, flags);
    return [...content.matchAll(matcher)].map((match) => match[0]);
  });
}

/** src/ 全仓递归遍历（仅生产文件：排除测试文件，其断言字符串会污染 ratchet 计数） */
function walkSrc(): string[] {
  // 与 readFile 同模式：模板先赋中间变量再进 new URL——
  // 内联在 new URL 参数中的模板/字面量会被 vitest transform 破坏（资产 URL 重写）。
  const anchorRel = 'src/tokens.css';
  const target = `../../${anchorRel}`;
  const srcRoot = fileURLToPath(new URL(target, import.meta.url)).replace(
    /[\\/]tokens\.css$/,
    ''
  );
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!/\.test\.(ts|tsx)$/.test(p)) out.push(p);
    }
  };
  walk(srcRoot);
  return out;
}

/** 行首 token 定义行（如 `--foo: color-mix(...)`），替换脚本与契约测试共同白名单 */
const DEF_LINE_RE = /^\s*--[\w-]+\s*:/;

/** 双层同源扫描排除文件（tokens.css 定义面 / theme-dark.css 补丁面 / themeStore 注入面；
 *  design-system.css：批次 9.1 S7-3 迁入的 ::selection 全局规则（原 tokens.css 内，非消费点）） */
const MIX_SKIP_FILE_NAMES = [
  'tokens.css',
  'themeStore.ts',
  'themePersonalization.ts',
  'TokenRuntimeController.ts',
  'design-system.css',
];

const LIGHT_BLOCK_RE = /:root,[\s\S]*?\n\}/;
const DARK_BLOCK_RE = /html\[data-theme=['"]dark['"]\]\s*\{[\s\S]*?\n\}/;

describe('z-index token 契约（F7-F14）', () => {
  it('审计列出的 4 个文件不存在裸数字 z-index 硬编码', () => {
    for (const rel of Z_INDEX_FILES) {
      const src = readFile(rel);
      const bare = src.match(/z-index\s*:\s*\d+(?![\w-])/g) ?? [];
      expect(bare, `${rel} 存在裸数字 z-index：${bare.join(', ')}`).toEqual([]);
    }
  });

  it('tabDragGhost 拖拽浮层走 --z-toast 档位（值等价 token 化）', () => {
    const src = readFile('src/hooks/tab-drag/tabDragGhost.ts');
    const block = src.match(/baseOverlayFixedStyle[\s\S]*?z-index:\s*[^;]+;/);
    expect(block?.[0]).toContain('var(--z-toast)');
  });

  it('useSessionListDrag 拖拽幽灵走 --z-tooltip 档位（值等价 token 化）', () => {
    const src = readFile(
      'src/components/sidebar/session-list/useSessionListDragHelpers.ts'
    );
    expect(src).toContain('z-index:var(--z-tooltip)');
  });

  it('LeafToolTabStrip 顶部工具栏 z-index token 化', () => {
    const src = readFile(
      'src/components/binary-tree/LeafToolTabStrip.module.css'
    );
    expect(src).toMatch(/z-index:\s*var\(--z-sticky/);
  });

  it('FileViewerCard 与 FilesCard 使用 Menu 统一菜单体系（消除废弃手写浮层与 z-index 割裂）', () => {
    const fileViewerCard = readFile('src/components/files/FileViewerCard.tsx');
    const fileActions = readFile('src/components/files/FileActions.tsx');
    const filesCardCss = readFile('src/components/files/FilesCard.module.css');
    const fileViewerCss = readFile(
      'src/components/files/FileViewerCard.module.css'
    );

    // TSX 均消费统一 Menu 组件
    expect(fileViewerCard).toContain('<Menu');
    expect(fileActions).toContain('<Menu');

    // CSS 已无废弃手写菜单浮层样式
    for (const sel of [
      '.filesOpenMenu',
      '.filesMoreMenu',
      '.filesOpenItem',
      '.filesOpenSep',
      '.filesOpenAppIco',
    ]) {
      expect(filesCardCss).not.toContain(sel);
      expect(fileViewerCss).not.toContain(sel);
    }
  });
});

describe('--ui-text-* dark 覆盖契约（F7-F27）', () => {
  it('dark 主题块内重新定义 --ui-text-* 五连 token（不引用 light 值）', () => {
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');
    expect(darkBlock).not.toBe('');
    for (const token of [
      '--ui-text-success',
      '--ui-text-danger',
      '--ui-text-muted',
      '--ui-text-info',
      '--ui-text-warning',
    ]) {
      expect(darkBlock, `dark 块应定义 ${token}`).toContain(`${token}:`);
    }
  });
});

describe('批次 2 · ① dark 分支覆盖（泛化 F7-F27）', () => {
  // 前缀清单内的非色 token（尺寸/间距类）与主题无关，dark 无需重定义
  const DARK_EXCLUDE = new Set([
    '--sidebar-width',
    '--control-height',
    '--control-height-sm',
    '--control-height-xs',
    '--control-height-lg',
    '--control-height-md',
    '--control-pad-x',
    '--control-pad-x-sm',
    '--control-pad-y',
    '--control-h',
    '--control-h-xs',
    '--control-h-sm',
    '--control-h-md',
    '--control-h-lg',
    '--bg-card-hover',
    '--bg-card-active',
  ]);

  it('色系前缀 token（bg/text/border/accent/color/tint/sidebar/control）在 dark 块全部重新定义', () => {
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');
    expect(lightBlock).toBeTruthy();
    expect(darkBlock).toBeTruthy();
    const tokenRe =
      /--(?:bg|text|border|accent|color|tint|sidebar|control)-[\w-]+\s*:/g;
    const names = [...new Set(lightBlock.match(tokenRe) ?? [])].map((s) =>
      s.replace(/:\s*$/, '')
    );
    expect(names.length).toBeGreaterThan(30);
    const missing = names.filter(
      (name) => !DARK_EXCLUDE.has(name) && !darkBlock.includes(`${name}:`)
    );
    expect(missing, `dark 块缺少定义：${missing.join(', ')}`).toEqual([]);
  });
});

describe('批次 2 · ② 禁新裸混色（text-primary 基底，严格清零铁律）', () => {
  // 全仓裸混色消费点严格归一到 Design Token 体系，门禁基线硬性锁死为 0（严禁私自放宽断言）
  const BARE_MIX_BASELINE = 0;
  const mixRe = /color-mix\(in srgb, var\(--text-primary\) \d+(?:\.\d+)?%,/g;

  it(`全仓裸混色计数严格清零 (0)（排除 tokens/theme-dark/themeStore 与定义行）`, () => {
    const cssFiles = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    const violations: string[] = [];
    for (const p of cssFiles) {
      const base = p.split(/[\\/]/).pop() ?? '';
      if (MIX_SKIP_FILE_NAMES.includes(base)) continue;
      const raw = readFileSync(p, 'utf8');
      // 剥离块注释 /* ... */
      const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = clean.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (DEF_LINE_RE.test(line)) continue;
        const matches = line.match(mixRe);
        if (matches) {
          total += matches.length;
          violations.push(`${p}:${i + 1}: ${line.trim()}`);
        }
      }

      // 扫描跨行 multiline color-mix([\s\S]*?) 块
      const multilineBlocks = clean.matchAll(/color-mix\([\s\S]*?\)/g);
      for (const m of multilineBlocks) {
        const block = m[0];
        if (!block.includes('\n')) continue; // 单行已在逐行扫描中覆盖
        if (
          !/color-mix\(\s*in\s+srgb\s*,\s*var\(--text-primary\)\s*\d+(?:\.\d+)?%/s.test(
            block
          )
        )
          continue;
        // 检查该块是否在 CSS 变量定义行 (--*:) 上
        const prefix = clean.slice(Math.max(0, m.index - 120), m.index);
        const lastDecl = prefix.split(/[;{}]/).pop() ?? '';
        if (DEF_LINE_RE.test(lastDecl.trim())) continue;

        total++;
        const lineNum = clean.slice(0, m.index).split('\n').length;
        violations.push(
          `${p}:${lineNum} (multiline): ${block.replace(/\s+/g, ' ')}`
        );
      }
    }
    expect(
      total,
      `裸混色消费点必须严格为 0，发现 ${total} 处违规点：\n${violations.join('\n')}`
    ).toBe(BARE_MIX_BASELINE);
  });
});

describe('批次 2 · ③ 禁裸 999px / 裸 99999', () => {
  const RADIUS_999_BASELINE = 0; // 当前基线（S5 表面族收敛后递减）
  const BARE_99999_WHITELIST = ['ChatComposer.module.css']; // autofill hack（R-11）

  it(`border-radius: 999px 裸值计数 ≤ ${RADIUS_999_BASELINE}`, () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    for (const p of files) {
      total += (
        readFileSync(p, 'utf8').match(/border-radius:\s*999(?!\d)/g) ?? []
      ).length;
    }
    expect(total, `裸 999px 计数 ${total} 超过基线`).toBeLessThanOrEqual(
      RADIUS_999_BASELINE
    );
  });

  it('裸 99999 仅允许 token 定义行与白名单文件（autofill hack）', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    for (const p of files) {
      const base = p.split(/[\\/]/).pop() ?? '';
      const lines = readFileSync(p, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('99999')) continue;
        if (DEF_LINE_RE.test(lines[i])) continue; // token 定义行放行
        if (BARE_99999_WHITELIST.includes(base)) continue; // autofill hack 白名单
        expect.fail(`${p}:${i + 1} 存在裸 99999：${lines[i].trim()}`);
      }
    }
  });
});

describe('批次 2 · ④ scrollbar 块 ratchet', () => {
  // I6：禁名 shell-scrollbar.css；新出口 overlay-scrollbar.css 必须存在。
  // 旧门禁只封顶（≤5）→ 文件已删、0 条 webkit 仍绿，真机回落粗条。
  // 现改为：出口存在 + 保底 webkit 块 + 其它文件禁私有伪元素。
  const SCROLLBAR_EXPORT = 'overlay-scrollbar.css';
  const SCROLLBAR_BANNED = 'shell-scrollbar.css';
  const SCROLLBAR_EXPORT_MIN = 5; // 本体 / track / thumb / hover / active

  it(`禁名 ${SCROLLBAR_BANNED} 不得复活`, () => {
    const hits = walkSrc().filter((p) =>
      p.replace(/\\/g, '/').endsWith(`/${SCROLLBAR_BANNED}`)
    );
    expect(hits, `禁名复活：${hits.join(', ')}`).toEqual([]);
  });

  it(`新出口 ${SCROLLBAR_EXPORT} 存在且含 webkit 细条 + 无三角 + thumb token + 指定容器`, () => {
    const css = readFile(`src/styles/${SCROLLBAR_EXPORT}`);
    expect(css).toContain('--tint-scrollbar-thumb');
    expect(css).toContain('sidebarScroll');
    expect(css).toContain('menuContent');
    expect(css).toContain('coverContent');
    expect(css).toContain('navScroll');
    expect(css).toContain('dialogBody');
    expect(css).toContain('::-webkit-scrollbar-button');
    expect(css).toMatch(/display:\s*none/);
    const webkit = css.match(/::-webkit-scrollbar/g) ?? [];
    expect(
      webkit.length,
      `${SCROLLBAR_EXPORT} webkit 块 ${webkit.length} < ${SCROLLBAR_EXPORT_MIN}`
    ).toBeGreaterThanOrEqual(SCROLLBAR_EXPORT_MIN);
    // 全局 * 不得设 scrollbar-width，否则 WebView2 忽略 webkit、露出系统三角
    const starBlock = css.match(/(?:^|\n)\*\s*\{[^}]*\}/)?.[0] ?? '';
    expect(starBlock).not.toContain('scrollbar-width');
  });

  it('tokens.css 中 light 与 dark 模式均显式定义非透明的滚动条颜色 Token', () => {
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');

    // light 模式必须显式定义实体像素且非透明（彻底杜绝浅色底板透明滚动条缺陷）
    expect(lightBlock).toMatch(/--scrollbar-thumb-bg:\s*#dedddc/);
    expect(lightBlock).toMatch(
      /--tint-scrollbar-thumb:\s*var\(--scrollbar-thumb-bg\)/
    );
    expect(lightBlock).toMatch(/--tint-scrollbar-track:\s*transparent/);

    // dark 模式必须显式重定义且非透明
    expect(darkBlock).toMatch(
      /--scrollbar-thumb-bg:\s*(?:#[0-9a-fA-F]+|color-mix\([^;]+var\(--(?:user-)?text-primary[^;]+\))/
    );
    expect(darkBlock).toMatch(
      /--tint-scrollbar-thumb:\s*var\(--scrollbar-thumb-bg\)/
    );
    expect(darkBlock).toMatch(/--tint-scrollbar-track:\s*transparent/);

    // 严禁未激活态滚动条 thumb 回落为透明或未定义
    expect(lightBlock).not.toMatch(/--scrollbar-thumb-bg:\s*transparent\b/);
    expect(darkBlock).not.toMatch(/--scrollbar-thumb-bg:\s*transparent\b/);
  });

  it(`index.css 引入 ${SCROLLBAR_EXPORT} 且不引禁名`, () => {
    const indexCss = readFile('src/index.css');
    expect(indexCss).toContain(`@import './styles/${SCROLLBAR_EXPORT}'`);
    expect(indexCss).not.toContain(SCROLLBAR_BANNED);
  });

  it('浮层组件与 Menu 严禁声明 scrollbar-width（走 webkit 细条，无三角箭头）', () => {
    const floatingPanels = [
      'src/components/ui/Menu/Menu.module.css',
      'src/components/ui/SmartPanel/SmartPanel.module.css',
      'src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css',
    ] as const;
    for (const rel of floatingPanels) {
      const css = readFile(rel);
      expect(css, rel).not.toMatch(/scrollbar-width\s*:/);
    }
    // WebView2：容器上的 scrollbar-width 会关掉 ::-webkit-scrollbar，露出系统三角
    const panel = readFile('src/components/settings/SettingsPanel.module.css');
    expect(panel).not.toMatch(/scrollbar-width\s*:/);
    expect(panel).toContain('overflow-y: auto');
    expect(panel).toContain('.coverContent');
    expect(panel).toContain('.navScroll');
  });

  const SCROLLBAR_WHITELIST = new Set([
    SCROLLBAR_EXPORT,
    'Sidebar.module.css',
    'LeafToolTabStrip.module.css',
    'ChatComposer.module.css',
    'ModelBadgePickerMenu.module.css',
    'FontSelectField.module.css',
    'ModelsSettingsTab.module.css',
    'SmartExpandablePanel.module.css',
    'SmartPanel.module.css',
    'SelectContent.module.css',
    'Menu.module.css',
    'PermissionModeMenu.module.css',
    'Select.module.css',
  ]);

  it(`其它生产 css 不得新增私有 ::-webkit-scrollbar（出口 ${SCROLLBAR_EXPORT} 除外）`, () => {
    const files = walkSrc().filter((p) => p.endsWith('.css'));
    const extras: string[] = [];
    for (const p of files) {
      const base = p.split(/[\\/]/).pop() ?? '';
      if (SCROLLBAR_WHITELIST.has(base)) continue;
      const n = (readFileSync(p, 'utf8').match(/::-webkit-scrollbar/g) ?? [])
        .length;
      if (n > 0) extras.push(`${p}: ${n}`);
    }
    expect(extras, `私有 scrollbar 块：${extras.join('; ')}`).toEqual([]);
  });

  it('滚动条容器悬停仅显示浅灰静止色（--scrollbar-thumb-bg），仅滑块自身 :hover/:active 才可设为激活深色（--scrollbar-thumb-active），且支持 data-scrollbar-visibility 自由定义', () => {
    const css = readFile(`src/styles/${SCROLLBAR_EXPORT}`);
    expect(css).toContain("[data-scrollbar-visibility='hover']");
    expect(css).toContain("[data-scrollbar-visibility='always']");

    // 扫描所有设置 --scrollbar-thumb-active 的 CSS 规则块，确保每一条选择器都以 ::-webkit-scrollbar-thumb:hover 或 :active 结尾
    const blocks = [
      ...css.matchAll(/([^{}]+)\{([^}]*--scrollbar-thumb-active[^}]*)\}/g),
    ];
    expect(blocks.length).toBeGreaterThan(0);
    for (const match of blocks) {
      const selectors = match[1]!
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sel of selectors) {
        expect(
          sel,
          `禁止在容器 hover/active 时直接把滑块染成激活黑灰色：${sel}`
        ).toMatch(
          /::-webkit-scrollbar-thumb(?::horizontal)?\s*:(?:hover|active)$/
        );
      }
    }
  });
});

describe('批次 2 · ⑤ !important ratchet', () => {
  // 基线 68 = 批次 9.1 + 桌面分屏架构与无障碍白名单收口
  // reduced-motion.css 白名单——R-04 双通道机制性 !important 豁免
  const IMPORTANT_BASELINE = 68;
  const IMPORTANT_SKIP_FILE_NAMES = ['reduced-motion.css'];

  it(`全仓 !important 计数 ≤ ${IMPORTANT_BASELINE}（reduced-motion 白名单）`, () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    for (const p of files) {
      const base = p.split(/[\\/]/).pop() ?? '';
      if (IMPORTANT_SKIP_FILE_NAMES.includes(base)) continue;
      total += (readFileSync(p, 'utf8').match(/!important/g) ?? []).length;
    }
    expect(total, `!important 总数 ${total} 超过基线`).toBeLessThanOrEqual(
      IMPORTANT_BASELINE
    );
  });
});

describe('批次 2 · ⑥ 注入 token 名 ∈ 静态定义名（双层同源约束 1）', () => {
  it('themeStore setProperty 注入的每个 token 在 tokens.css 有静态定义或静态消费', () => {
    // T-BLK-07b 参数化：JS 只允许写两类名字——
    //   ① tokens.css 有静态声明的（B 类运行期量，如 --font-size-adjust）；
    //   ② 被 tokens.css 静态消费的 --user-* 参数（A 类值由 var(--user-*, 兜底) 派生）。
    // 孤儿注入（写而无声明、无消费）仍然被本断言拦截。
    const themeStore =
      readFile('src/api/themeStore.ts') +
      '\n' +
      readFile('src/api/themePersonalization.ts') +
      '\n' +
      readFile('src/services/TokenRuntimeController.ts') +
      '\n' +
      readFile('src/services/token-runtime/injectRootTokens.ts');
    const injected = [
      ...new Set(
        // \s*：注入名换行书写（injectRootTokens 多行 setProperty）也计入
        [...themeStore.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)].map(
          (m) => m[1]
        )
      ),
    ];
    expect(injected.length).toBeGreaterThan(10);
    // 去空白后匹配：tokens.css 的声明与消费存在多行形态
    // （`var(\n  --user-scrollbar-button-up,` / `--user-xxx:\n  值`）。
    const staticCss = readTokenCss().replace(/\s+/g, '');
    const missing = injected.filter(
      (name) =>
        !staticCss.includes(`${name}:`) && !staticCss.includes(`var(${name}`)
    );
    expect(missing, `注入但无静态定义/消费：${missing.join(', ')}`).toEqual([]);
  });
});

describe('批次 2 · ⑦ 固定值双源同值（双层同源约束 2）', () => {
  it('--bg-hover/--bg-active 不再由 themeStore 注入（静态真源唯一）', () => {
    const themeStore =
      readFile('src/api/themeStore.ts') +
      '\n' +
      readFile('src/api/themePersonalization.ts') +
      '\n' +
      readFile('src/services/TokenRuntimeController.ts');
    expect(themeStore).not.toContain("setProperty('--bg-hover'");
    expect(themeStore).not.toContain("setProperty('--bg-active'");
  });

  it('control-soft-* 由 tokens.css 统一叠加，运行时不再按皮肤注入（2026-10-10 三档底色）', () => {
    const ts = readFile('src/services/TokenRuntimeController.ts');
    expect(ts).not.toMatch(/tokens\['--control-soft-bg/);
    expect(ts).not.toMatch(/setProperty\('--control-soft-bg/);
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toContain('--state-hover:');
      expect(block).toContain('--state-active:');
    }
  });

  it('--bg-hover/--bg-active 废弃别名彻底清退，正典 --state-* 交互态接线且两主题对齐', () => {
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');
    const compactLightBlock = compactCss(lightBlock);
    const compactDarkBlock = compactCss(darkBlock);
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toContain('--state-hover:');
      expect(block).toContain('--state-active:');
      expect(block).toContain('--state-selected:');
      expect(block).toContain('--state-focus-ring:');
      expect(block).toContain('--state-subtle:');
      expect(block).toContain('--state-quiet:');
      expect(block).toContain('--state-strong:');
    }
    // 浅色按下收到 3%。深色悬停仍走提亮阶梯。
    expect(compactLightBlock).toContain('--state-hover-pct:2.5%');
    expect(compactLightBlock).toContain('--state-active-pct:3%');
    expect(compactLightBlock).toContain('--state-selected-pct:7%');
    expect(compactLightBlock).toContain(
      '--state-hover:color-mix(insrgb,var(--text-primary)var(--state-hover-pct),transparent)'
    );
    expect(compactLightBlock).toContain(
      '--state-active:color-mix(insrgb,var(--text-primary)var(--state-active-pct),transparent)'
    );
    expect(compactLightBlock).toContain(
      '--state-quiet:color-mix(insrgb,var(--text-primary)3%,transparent)'
    );
    expect(compactDarkBlock).toContain('--state-hover-pct:3.5%');
    expect(compactDarkBlock).toContain('--state-active-pct:6%');
    expect(compactDarkBlock).toContain('--state-selected-pct:7%');
    expect(compactDarkBlock).toContain(
      '--state-hover:color-mix(insrgb,var(--text-primary)var(--state-hover-pct),transparent)'
    );
    expect(compactDarkBlock).toContain(
      '--state-active:color-mix(insrgb,var(--text-primary)var(--state-active-pct),transparent)'
    );
    expect(compactDarkBlock).toContain(
      '--state-quiet:color-mix(insrgb,var(--text-primary)3%,transparent)'
    );
  });
});

describe('批次 2 · ⑧ 悬空引用清零 + 静态兜底存在', () => {
  it('--hover-bg / --active-bg / --chart-color 悬空引用全仓清零', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      const hits = src.match(
        /var\(--(?:hover-bg|active-bg|chart-color)[\w-]*\)/g
      );
      if (hits) {
        expect.fail(`${p} 存在悬空引用：${hits.join(', ')}`);
      }
    }
  });

  it('全仓 100,000 等恶性通胀 z-index 变量清零', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      expect(src).not.toContain('z-drag-overlay-max');
      expect(src).not.toContain('z-first-run');
      expect(src).not.toContain('z-model-flyout');
      expect(src).not.toContain('z-skip-link');
    }
  });

  it('ui/Tooltip.module.css 含 --tooltip-translate 静态 fallback（translate(0) 形态）', () => {
    const rel = 'src/components/ui/Tooltip/Tooltip.module.css';
    const src = readFile(rel);
    const bare = src.match(/var\(--tooltip-translate\)(?!,)/g) ?? [];
    expect(bare, `${rel} 存在无 fallback 的裸引用`).toEqual([]);
    expect(src, rel).toContain('var(--tooltip-translate, translate(0))');
  });

  it('tokens.css 中 15.5%/12.5% 高饱和度 adaptive 变量已清理', () => {
    const css = readTokenCss();
    expect(css).not.toContain('15.5%');
    expect(css).not.toContain('12.5%');
  });
});

describe('设置按钮圆角 7px 契约（用户锁，survey 04）', () => {
  it('tokens.css 默认档 --button-radius 锁 var(--radius-btn)，密度档不得改写', () => {
    const css = readTokenCss();
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    expect(lightBlock).toMatch(/--radius-btn:\s*7px;/);
    expect(lightBlock).toMatch(/--button-radius:\s*var\(--radius-btn\);/);
    const sizeBlockRe = (size: string): RegExp =>
      new RegExp(`\\[data-ui-size=['"]${size}['"]\\]\\s*\\{[\\s\\S]*?\\n\\}`);
    const smallBlock = css.match(sizeBlockRe('small'))?.[0] ?? '';
    const largeBlock = css.match(sizeBlockRe('large'))?.[0] ?? '';
    expect(smallBlock.length).toBeGreaterThan(20);
    expect(largeBlock.length).toBeGreaterThan(20);
    expect(smallBlock).not.toMatch(/--button-radius\s*:/);
    expect(largeBlock).not.toMatch(/--button-radius\s*:/);
  });

  it('ui/Button 与 ui/SegmentedControl 消费 --button-radius 与同心圆角 token，禁裸 8px/胶囊硬编码半径', () => {
    const button = readFile('src/components/ui/Button/Button.module.css');
    const seg = readFile(
      'src/components/ui/SegmentedControl/SegmentedControl.module.css'
    );
    // 2026-09-12 适配 T8 兜底清退：7px 用户锁由 tokens.css 的 --radius-btn: 7px 单点守护
    // （见上方 it），消费点一律无兜底直连 var(--button-radius) / var(--seg-outer-radius)。
    expect(button).toContain('--btn-radius: var(--button-radius)');
    expect(seg).toContain('--seg-outer-radius: var(--button-radius)');
    expect(seg).toContain(
      '--seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad))'
    );
    expect(seg).toContain('border-radius: var(--seg-outer-radius)');
    expect(seg).toContain('border-radius: var(--seg-inner-radius)');
    expect(seg).not.toMatch(/border-radius:\s*8px/);
    expect(seg).not.toMatch(/border-radius:\s*999/);
  });
});

describe('批次 6 · T4 hover-only 键盘闭环契约（08-步5 · 平直列表升级）', () => {
  it('DiffCard.hoverActions 不以 display:none 阻断 Tab 序，且 :hover/:focus-within 双揭示', () => {
    const css = readFile('src/components/diff/DiffCard.module.css').replace(
      /\r\n/g,
      '\n'
    );
    const block =
      css.match(/\.(rowActions|hoverActions)\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(block, '.rowActions/.hoverActions 应存在').toContain('opacity: 0');
    expect(block).toContain('visibility: hidden');
    expect(block).not.toContain('display: none');

    // 就地平滑迁移：支持平直列表行 .fileRow 与 .rowActions / .hoverActions，彻底切除旧手风琴 .accordionHeaderRow 依赖
    const hasRowHover =
      css.includes('.fileRow:hover .rowActions') ||
      css.includes('.fileRow:hover .hoverActions');
    expect(hasRowHover, '必须支持 .fileRow:hover 揭示操作栏').toBe(true);
    const hasRowFocus =
      css.includes('.fileRow:focus-within .rowActions') ||
      css.includes('.fileRow:focus-within .hoverActions');
    expect(hasRowFocus, '必须支持 .fileRow:focus-within 揭示操作栏').toBe(true);

    // 刚性防回潮负向断言：旧手风琴选择器严禁在样式表中复活
    expect(css, '严禁残留旧手风琴行类名 .accordionHeaderRow').not.toContain(
      '.accordionHeaderRow'
    );
  });

  it('DiffCardFileList 列表语义已降级为 role="list"（无 listbox/option 滥用）', () => {
    const src = readFile('src/components/diff/DiffCardFileList.tsx');
    // 属性可能被 prettier 换行拆开，按语义分别断言（R2-7 修正连续串误报）
    expect(src).toContain('role="list"');
    expect(src).toContain('aria-label="变更文件列表"');
    expect(src).not.toContain('role="listbox"');
    expect(src).not.toContain('role="option"');
    expect(src).not.toContain('aria-selected={active}');
  });
});

describe('composer 水平内衬光学 token 对（2026-09-21 用户视觉裁决）', () => {
  const COMPOSER_CSS = 'src/components/chat-composer/ChatComposer.module.css';

  /** 取某选择器规则块（CSS Modules 规则体无嵌套花括号，[^}]* 安全；精确匹配行首选择器） */
  function ruleBlock(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`^${escaped}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? '';
  }

  /** tokens.css 中某 token 的最后一次定义值（多主题块后者覆盖前者；取最后一次） */
  function tokenDef(tokensCss: string, name: string): string {
    const re = new RegExp(`(?<![\\w-])${name}\\s*:\\s*([^;]+);`, 'g');
    let v: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tokensCss))) v = m[1].trim();
    return v ?? '';
  }

  it('tokens.css 定义水平内衬 token 对：--composer-pad-x=10px（结束侧） + --composer-pad-x-start=10px（起始侧，等宽试验），均为固定 px', () => {
    const tokens = readTokenCss();
    expect(tokenDef(tokens, '--composer-pad-x')).toBe('10px');
    expect(tokenDef(tokens, '--composer-pad-x-start')).toBe('10px');
    // 负向：不得引用 --space-* 刻度（密度可变值会使几何测量变成时序依赖，同 --chat-stream-pad-x 纪律）
    for (const name of ['--composer-pad-x', '--composer-pad-x-start']) {
      expect(
        tokenDef(tokens, name).startsWith('var('),
        `${name} 不得引用空间刻度（光学内衬须固定值）`
      ).toBe(false);
    }
  });

  it('.composerCard 单/多行两条规则消费同一 token 对，兜底值与静态默认同值', () => {
    // 规则块提取用原始文本（^ 行首锚定依赖换行）；断言前再对块内空白归一化
    const single = ruleBlock(readFile(COMPOSER_CSS), '.composerCard').replace(
      /\s+/g,
      ' '
    );
    const multi = ruleBlock(
      readFile(COMPOSER_CSS),
      '.composerCard.isMultiline'
    ).replace(/\s+/g, ' ');
    expect(single, '.composerCard 规则应存在').not.toBe('');
    expect(multi, '.composerCard.isMultiline 规则应存在').not.toBe('');
    // 单行：上 6 / 右=结束侧 / 下 6 / 左=起始侧（等宽 10px）
    expect(single).toContain(
      'padding: 6px var(--composer-pad-x, 10px) 6px var(--composer-pad-x-start, 10px)'
    );
    // 多行：垂直 8，水平同一对 token——＋ 同列（left-ctrl）切换 X 轴零位移
    expect(multi).toContain(
      'padding: 8px var(--composer-pad-x, 10px) 8px var(--composer-pad-x-start, 10px)'
    );
  });

  it('负向：composer 卡片 padding 禁 calc() 魔术补偿（光学量必须命名化为 token）', () => {
    const css = readFile(COMPOSER_CSS);
    for (const sel of ['.composerCard', '.composerCard.isMultiline']) {
      const block = ruleBlock(css, sel);
      const padLine =
        block.split('\n').find((l) => l.includes('padding:')) ?? '';
      expect(
        padLine,
        `${sel} 的 padding 不得使用 calc() 魔术补偿（AGENTS.md §7）`
      ).not.toContain('calc(');
    }
  });
});

describe('全局文字选中色彩统一契约（方案 A #0d9668 绿底 + #ffffff 白字 SSOT）', () => {
  it('tokens.css 在 light 与 dark 块中均定义 --selection-bg: #0d9668 与 --selection-fg: #ffffff，且 --xterm-selection 同源', () => {
    const lightBlock = readTokenThemeBlocks(LIGHT_BLOCK_RE).join('\n');
    const darkBlock = readTokenThemeBlocks(DARK_BLOCK_RE).join('\n');
    for (const [label, block] of [
      ['light', lightBlock],
      ['dark', darkBlock],
    ] as const) {
      expect(block, `${label} --selection-bg`).toMatch(
        /--selection-bg:\s*#0d9668;/i
      );
      expect(block, `${label} --selection-fg`).toMatch(
        /--selection-fg:\s*#ffffff;/i
      );
      expect(block, `${label} --xterm-selection`).toMatch(
        /--xterm-selection:\s*var\(--selection-bg\);/
      );
    }
  });

  it('design-system.css 为全仓唯一 ::selection 规则入口，且绑定 var(--selection-bg) 与 var(--selection-fg)', () => {
    const designCss = readFile('src/styles/design-system.css');
    expect(designCss).toMatch(
      /::selection\s*\{[^}]*background-color:\s*var\(--selection-bg\);[^}]*color:\s*var\(--selection-fg\);[^}]*\}/
    );

    const cssFiles = walkSrc().filter((p) => p.endsWith('.css'));
    const privateSelections: string[] = [];
    for (const p of cssFiles) {
      const base = p.split(/[\\/]/).pop() ?? '';
      if (base === 'design-system.css') continue;
      const clean = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (clean.includes('::selection')) {
        privateSelections.push(p);
      }
    }
    expect(
      privateSelections,
      `禁止组件级私有 ::selection 分叉：${privateSelections.join(', ')}`
    ).toEqual([]);
  });

  it('FileAnnotationPopover 持久化选区高亮与全局选中绿底白字同源', () => {
    const popoverCss = readFile(
      'src/components/files/FileAnnotationPopover.module.css'
    );
    expect(popoverCss).toMatch(
      /::highlight\(file-annotation-active-selection\)[^{]*\{[^}]*background-color:\s*var\(--selection-bg\);[^}]*color:\s*var\(--selection-fg\);[^}]*\}/
    );
  });
});

describe('Tokens SSOT 收敛契约（清退 WAVE2 别名）', () => {
  it('tokens-state.css 中完全清空 [WAVE2-DEPRECATED-ALIAS] 标记与别名声明', () => {
    const css = readFile('src/styles/tokens-state.css');
    expect(css).not.toContain('[WAVE2-DEPRECATED-ALIAS]');

    // 历史废弃别名在定义面严格不存在
    const FORBIDDEN_TOKENS = [
      '--tint-hover:',
      '--tint-active:',
      '--tint-strong:',
      '--tint-subtle:',
      '--tint-quiet:',
      '--tint-focus-ring:',
      '--tint-divider:',
      '--tint-overlay:',
      '--tint-highlight:',
      '--bg-hover:',
      '--bg-active:',
      '--bg-card-hover:',
      '--bg-card-active:',
      '--button-secondary-bg:',
      '--control-soft-bg:',
      '--sidebar-hover:',
      '--sidebar-active:',
      '--composer-control-hover-bg:',
      '--filetree-node-hover-bg:',
    ];
    for (const token of FORBIDDEN_TOKENS) {
      expect(css, `tokens-state.css 不应再定义 ${token}`).not.toContain(token);
    }
  });

  it('全仓消费面（CSS/TS/TSX）废弃别名消费点严格清零 (0)', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    const ALIAS_PATTERNS = [
      /var\(--tint-hover\b/,
      /var\(--bg-hover\b/,
      /var\(--tint-active\b/,
      /var\(--bg-active\b/,
      /var\(--control-soft-bg\b/,
      /var\(--control-soft-bg-hover\b/,
      /var\(--control-soft-bg-active\b/,
      /var\(--sidebar-hover\b/,
      /var\(--sidebar-active\b/,
      /var\(--tint-focus-ring\b/,
      /var\(--tint-subtle\b/,
      /var\(--tint-quiet\b/,
      /var\(--tint-strong\b/,
      /var\(--tint-divider\b/,
      /var\(--tint-overlay\b/,
      /var\(--tint-highlight\b/,
      /var\(--bg-card-hover\b/,
      /var\(--bg-card-active\b/,
      /var\(--composer-control-hover-bg\b/,
      /var\(--filetree-node-hover-bg\b/,
      /var\(--button-secondary-bg\b/,
      /var\(--elevate-1\b/,
      /var\(--elevate-1-active\b/,
      /var\(--elevate-2\b/,
      /var\(--elevate-3\b/,
      /var\(--elevate-step-1\b/,
      /var\(--elevate-step-1-active\b/,
      /var\(--elevate-step-2\b/,
      /var\(--elevate-step-3\b/,
    ];

    let totalViolations = 0;
    const details: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of ALIAS_PATTERNS) {
        const matches = content.match(pattern);
        if (matches) {
          totalViolations += matches.length;
          details.push(`${file}: 命中废弃别名 ${pattern}`);
        }
      }
    }

    expect(
      totalViolations,
      `废弃别名消费点必须严格为 0，发现 ${totalViolations} 处残留：\n${details.join('\n')}`
    ).toBe(0);
  });
});

describe('动效单一真理源契约（74 处内联动效清零）', () => {
  it('CSS 模块中严禁内联裸写 cubic-bezier 曲线字面量', () => {
    const cssModules = walkSrc().filter((p) => /\.module\.css$/.test(p));
    let bareBeziers = 0;
    const violations: string[] = [];

    for (const file of cssModules) {
      const content = readFileSync(file, 'utf8');
      const clean = content.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = clean.split('\n');
      lines.forEach((line, idx) => {
        // 排除引用 var(--ease-* 或 var(--stream-anim-easing
        if (line.includes('cubic-bezier') && !line.includes('var(')) {
          bareBeziers++;
          violations.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      bareBeziers,
      `CSS 模块中禁止裸写 cubic-bezier，发现 ${bareBeziers} 处违规：\n${violations.join('\n')}`
    ).toBe(0);
  });

  it('CSS 模块过渡与动画声明中禁止裸写毫秒/秒时长（必须通过 duration tokens 引用）', () => {
    const cssModules = walkSrc().filter((p) => /\.module\.css$/.test(p));
    let bareDurations = 0;
    const violations: string[] = [];

    for (const file of cssModules) {
      const content = readFileSync(file, 'utf8');
      const clean = content.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = clean.split('\n');
      lines.forEach((line, idx) => {
        if (/^\s*(transition|animation)\s*:/.test(line)) {
          // 匹配含有纯数字时长如 120ms, 0.18s 但未包裹在 var(--duration 或 var(--transition 中
          if (
            /(?<!var\([^)]*)\b\d+(\.\d+)?(s|ms)\b/.test(line) &&
            !line.includes('var(--')
          ) {
            bareDurations++;
            violations.push(`${file}:${idx + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(
      bareDurations,
      `CSS 模块中禁止裸写过渡时长，发现 ${bareDurations} 处违规：\n${violations.join('\n')}`
    ).toBe(0);
  });
});

describe('原子组件 CVA 架构与特异度确定性覆盖契约', () => {
  it('Button / Badge / Card / Input 必须导出标准 Variants 矩阵对象', async () => {
    const buttonModule = await import('../components/ui/Button/Button');
    const badgeModule = await import('../components/ui/Badge/Badge');
    const cardModule = await import('../components/ui/Card/Card');
    const inputModule = await import('../components/ui/Input/Input');

    expect(typeof buttonModule.buttonVariants).toBe('function');
    expect(typeof badgeModule.badgeVariants).toBe('function');
    expect(typeof cardModule.cardVariants).toBe('function');
    expect(typeof inputModule.inputWrapVariants).toBe('function');
  });

  it('原子组件禁止手写 [styles.xxx, ...].filter(Boolean).join 易错拼串', () => {
    const targetFiles = [
      'src/components/ui/Button/Button.tsx',
      'src/components/ui/Badge/Badge.tsx',
      'src/components/ui/Card/Card.tsx',
      'src/components/ui/Input/Input.tsx',
    ];

    for (const rel of targetFiles) {
      const src = readFile(rel);
      expect(src, `${rel} 不应再手写 filter(Boolean).join 拼串`).not.toContain(
        '.filter(Boolean).join'
      );
      expect(src, `${rel} 必须接入 cn 工具函数`).toContain('cn(');
    }
  });

  it('外部传入 className 必须在最终类名中处于末位并具备合并覆盖优先级', async () => {
    const { buttonVariants } = await import('../components/ui/Button/Button');
    const { cn } = await import('../components/ui/utils/cn');

    const result = cn(
      buttonVariants({ variant: 'primary', size: 'md' }),
      'custom-override-cls'
    );
    const classes = result.split(' ');

    // 外部传入类名处于末位，确保层叠顺序优先
    expect(classes[classes.length - 1]).toBe('custom-override-cls');
  });
});
