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
import { join } from 'node:path';
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
    const css = readFile('src/styles/tokens.css');
    const darkBlock = css.match(DARK_BLOCK_RE);
    expect(darkBlock).toBeTruthy();
    for (const token of [
      '--ui-text-success',
      '--ui-text-danger',
      '--ui-text-muted',
      '--ui-text-info',
      '--ui-text-warning',
    ]) {
      expect(darkBlock?.[0], `dark 块应定义 ${token}`).toContain(`${token}:`);
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
    '--control-pad-x',
    '--control-pad-x-sm',
    '--control-pad-y',
  ]);

  it('色系前缀 token（bg/text/border/accent/color/tint/sidebar/control）在 dark 块全部重新定义', () => {
    const css = readFile('src/styles/tokens.css');
    const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
    const darkBlock = css.match(DARK_BLOCK_RE)?.[0] ?? '';
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

describe('批次 2 · ② 禁新裸混色（text-primary 基底，ratchet）', () => {
  // 基线 = 批次 2 S2 收敛完成后的保留登记例外（批次 9.1 复审后 3 处）：
  //   UnitSessionTabStrip.module.css:333（6% 非标准基底 var(--unit-tab-active-bg)）
  //   settings-base.css:2370（5% 非标准基底 var(--bg-tertiary)）
  //   shell-polish.css:885（35% border 用法不入 tint 族，detail 02 §3.3 口径）
  // 批次 9.1 复审：settings-models.css:387 的 35% 强底已归 --tint-highlight 派生档。
  // 后续批次应单调递减，禁止新增裸混色消费点。
  const BARE_MIX_BASELINE = 25;
  const mixRe = /color-mix\(in srgb, var\(--text-primary\) \d+(?:\.\d+)?%,/g;

  it(`全仓裸混色计数 ≤ ${BARE_MIX_BASELINE}（排除 tokens/theme-dark/themeStore 与定义行）`, () => {
    const cssFiles = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    for (const p of cssFiles) {
      const base = p.split(/[\\/]/).pop() ?? '';
      if (MIX_SKIP_FILE_NAMES.includes(base)) continue;
      const lines = readFileSync(p, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (DEF_LINE_RE.test(line)) continue;
        total += (line.match(mixRe) ?? []).length;
      }
    }
    expect(
      total,
      `裸混色消费点 ${total} 处超过基线 ${BARE_MIX_BASELINE}`
    ).toBeLessThanOrEqual(BARE_MIX_BASELINE);
  });
});

describe('批次 2 · ③ 禁裸 999px / 裸 99999', () => {
  const RADIUS_999_BASELINE = 62; // 当前基线（S5 表面族收敛后递减）
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
      expect(css, rel).toContain('--tint-scrollbar-thumb');
      expect(css, rel).toContain('::-webkit-scrollbar-button');
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
});

describe('批次 2 · ⑤ !important ratchet', () => {
  // 基线 633 = 批次 9.1 治理后（settings-base segment 组 12 处 + chat.css 双重
  // border 2 处去除；reduced-motion.css 白名单——R-04 双通道机制性 !important
  // 按 01 方案 S7 口径「保留 reduced-motion 27 处 + 白名单注明」豁免，防误伤）。
  const IMPORTANT_BASELINE = 626;
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
  it('themeStore setProperty 注入的每个 token 在 tokens.css 有静态定义', () => {
    const themeStore =
      readFile('src/api/themeStore.ts') +
      '\n' +
      readFile('src/api/themePersonalization.ts');
    const injected = [
      ...new Set(
        [...themeStore.matchAll(/setProperty\('(--[\w-]+)'/g)].map((m) => m[1])
      ),
    ];
    expect(injected.length).toBeGreaterThan(10);
    const staticCss = readFile('src/styles/tokens.css');
    const missing = injected.filter((name) => !staticCss.includes(`${name}:`));
    expect(missing, `注入但无静态定义：${missing.join(', ')}`).toEqual([]);
  });
});

describe('批次 2 · ⑦ 固定值双源同值（双层同源约束 2）', () => {
  it('--bg-hover/--bg-active 不再由 themeStore 注入（静态真源唯一）', () => {
    const themeStore =
      readFile('src/api/themeStore.ts') +
      '\n' +
      readFile('src/api/themePersonalization.ts');
    expect(themeStore).not.toContain("setProperty('--bg-hover'");
    expect(themeStore).not.toContain("setProperty('--bg-active'");
  });

  it('themeStore control-soft 注入百分比与静态定义对齐（light 4/4/8、dark 5/6.5/9.5）', () => {
    const ts =
      readFile('src/api/themeStore.ts') +
      '\n' +
      readFile('src/api/themePersonalization.ts');
    const softBg = ts.match(
      /softBgPct = isDarkPreset \? '([^']+)' : '([^']+)'/
    );
    const softHover = ts.match(
      /softHoverPct = isDarkPreset \? '([^']+)' : '([^']+)'/
    );
    const softActive = ts.match(
      /softActivePct = isDarkPreset \? '([^']+)' : '([^']+)'/
    );
    expect(softBg?.[1]).toBe('5%');
    expect(softBg?.[2]).toBe('4%');
    expect(softHover?.[1]).toBe('6.5%');
    expect(softHover?.[2]).toBe('4%');
    expect(softActive?.[1]).toBe('9.5%');
    expect(softActive?.[2]).toBe('8%');

    const css = readFile('src/styles/tokens.css');
    const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
    const darkBlock = css.match(DARK_BLOCK_RE)?.[0] ?? '';
    const pctOf = (block: string, token: string): string | null => {
      const m = block.match(
        new RegExp(
          `${token}:\\s*color-mix\\(\\s*in srgb,\\s*var\\(--[\\w-]+\\)\\s*(\\d+(?:\\.\\d+)?)%`
        )
      );
      return m?.[1] ?? null;
    };
    expect(lightBlock).toContain('--control-soft-bg: var(--tint-hover)');
    expect(lightBlock).toContain('--control-soft-bg-hover: var(--tint-active)');
    expect(lightBlock).toContain('--control-soft-bg-active: color-mix(');
  });

  it('--bg-hover/--bg-active 语义别名接线到 tint 档位（3.5% / 6.5%）且两主题一致', () => {
    const css = readFile('src/styles/tokens.css');
    const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
    const darkBlock = css.match(DARK_BLOCK_RE)?.[0] ?? '';
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toContain('--bg-hover: var(--tint-hover)');
      expect(block).toContain('--bg-active: var(--tint-active)');
      expect(block).toContain(
        '--tint-hover: color-mix(in srgb, var(--text-primary) 3.5%, transparent)'
      );
      expect(block).toContain(
        '--tint-active: color-mix(in srgb, var(--text-primary) 6.5%, transparent)'
      );
    }
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
    const css = readFile('src/styles/tokens.css');
    expect(css).not.toContain('15.5%');
    expect(css).not.toContain('12.5%');
  });
});

describe('设置按钮圆角 7px 契约', () => {
  it('tokens.css 默认档 --button-radius 锁 7px，密度档不得改写', () => {
    const css = readFile('src/styles/tokens.css');
    const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
    expect(lightBlock).toMatch(/--button-radius:\s*7px/);
    expect(lightBlock).not.toMatch(/--button-radius:\s*var\(--radius-/);
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
    expect(button).toContain('--btn-radius: var(--button-radius, 7px)');
    expect(seg).toContain('--seg-outer-radius: var(--button-radius, 7px)');
    expect(seg).toContain('--seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad))');
    expect(seg).toContain('border-radius: var(--seg-outer-radius)');
    expect(seg).toContain('border-radius: var(--seg-inner-radius)');
    expect(seg).not.toMatch(/border-radius:\s*8px/);
    expect(seg).not.toMatch(/border-radius:\s*999/);
  });
});

describe('批次 6 · T4 hover-only 键盘闭环契约（08-步5）', () => {
  it('DiffCard.hoverActions 不以 display:none 阻断 Tab 序，且 :hover/:focus-within 双揭示', () => {
    // 规范化行尾：`\s*` 会吞 CRLF 的 \r，导致匹配串含换行
    const css = readFile('src/components/diff/DiffCard.module.css').replace(
      /\r\n/g,
      '\n'
    );
    const block = css.match(/\.hoverActions\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(block, '.hoverActions 应存在').toContain('opacity: 0');
    expect(block).toContain('visibility: hidden');
    expect(block).not.toContain('display: none');
    expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
    expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
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
