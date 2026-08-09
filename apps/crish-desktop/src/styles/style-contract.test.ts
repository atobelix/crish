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
 *   ④ scrollbar 块 ratchet（防新增私有滚动条）
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

/** 双层同源扫描排除文件（tokens.css 定义面 / theme-dark.css 补丁面 / themeStore 注入面） */
const MIX_SKIP_FILE_NAMES = ['tokens.css', 'theme-dark.css', 'themeStore.ts'];

const LIGHT_BLOCK_RE = /:root,[\s\S]*?\n\}/;
const DARK_BLOCK_RE = /html\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/;

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
      'src/components/sidebar/session-list/useSessionListDrag.ts'
    );
    expect(src).toContain('z-index:var(--z-tooltip)');
  });

  it('LeafToolTabStrip.addDropdownMenu 走 --z-floating-panel 档位', () => {
    const src = readFile('src/components/binary-tree/LeafToolTabStrip.module.css');
    const block = src.match(/\.addDropdownMenu\s*\{[\s\S]*?\}/);
    expect(block?.[0]).toContain('z-index: var(--z-floating-panel)');
  });

  it('FileViewerCard.filesOpenMenu / filesMoreMenu 走 --z-sidebar 档位', () => {
    const src = readFile('src/components/files/FileViewerCard.module.css');
    for (const sel of ['.filesOpenMenu', '.filesMoreMenu']) {
      const block = src.match(new RegExp(`${sel}\\s*\\{[\\s\\S]*?\\}`));
      expect(block?.[0], `${sel} 应 token 化`).toContain('z-index: var(--z-sidebar)');
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
  // 基线 = 批次 2 S2 收敛完成后的保留登记例外（4 处）：
  //   UnitSessionTabStrip.module.css:333（6% 非标准基底）
  //   settings-base.css:2370（5% 非标准基底）
  //   settings-models.css:387 / shell-polish.css:885（35% 不入 tint 族，人工保留）
  // 后续批次应单调递减，禁止新增裸混色消费点。
  const BARE_MIX_BASELINE = 4;
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
    expect(total, `裸混色消费点 ${total} 处超过基线 ${BARE_MIX_BASELINE}`).toBeLessThanOrEqual(
      BARE_MIX_BASELINE
    );
  });
});

describe('批次 2 · ③ 禁裸 999px / 裸 99999', () => {
  const RADIUS_999_BASELINE = 66; // 当前基线（S5 表面族收敛后递减）
  const BARE_99999_WHITELIST = ['ChatComposer.module.css']; // autofill hack（R-11）

  it(`border-radius: 999px 裸值计数 ≤ ${RADIUS_999_BASELINE}`, () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    for (const p of files) {
      total += (readFileSync(p, 'utf8').match(/border-radius:\s*999(?!\d)/g) ?? [])
        .length;
    }
    expect(total, `裸 999px 计数 ${total} 超过基线`).toBeLessThanOrEqual(RADIUS_999_BASELINE);
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
  const SCROLLBAR_BASELINE = 31; // 当前基线（S5 收敛为全局契约后递减）

  it(`::-webkit-scrollbar 块计数 ≤ ${SCROLLBAR_BASELINE}`, () => {
    const files = walkSrc().filter((p) => p.endsWith('.css'));
    let total = 0;
    for (const p of files) {
      total += (readFileSync(p, 'utf8').match(/::-webkit-scrollbar/g) ?? []).length;
    }
    expect(total, `scrollbar 块 ${total} 超过基线`).toBeLessThanOrEqual(SCROLLBAR_BASELINE);
  });
});

describe('批次 2 · ⑤ !important ratchet', () => {
  const IMPORTANT_BASELINE = 676; // 当前基线（后续批次治理后递减）

  it(`全仓 !important 计数 ≤ ${IMPORTANT_BASELINE}`, () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let total = 0;
    for (const p of files) {
      total += (readFileSync(p, 'utf8').match(/!important/g) ?? []).length;
    }
    expect(total, `!important 总数 ${total} 超过基线`).toBeLessThanOrEqual(IMPORTANT_BASELINE);
  });
});

describe('批次 2 · ⑥ 注入 token 名 ∈ 静态定义名（双层同源约束 1）', () => {
  it('themeStore setProperty 注入的每个 token 在 tokens.css / shell-workspace.css 有静态定义', () => {
    const themeStore = readFile('src/api/themeStore.ts');
    const injected = [
      ...new Set(
        [...themeStore.matchAll(/setProperty\('(--[\w-]+)'/g)].map((m) => m[1])
      ),
    ];
    expect(injected.length).toBeGreaterThan(10);
    const staticCss =
      readFile('src/styles/tokens.css') +
      '\n' +
      readFile('src/styles/shell/shell-workspace.css');
    const missing = injected.filter((name) => !staticCss.includes(`${name}:`));
    expect(missing, `注入但无静态定义：${missing.join(', ')}`).toEqual([]);
  });
});

describe('批次 2 · ⑦ 固定值双源同值（双层同源约束 2）', () => {
  it('--bg-hover/--bg-active 不再由 themeStore 注入（静态真源唯一）', () => {
    const themeStore = readFile('src/api/themeStore.ts');
    expect(themeStore).not.toContain("setProperty('--bg-hover'");
    expect(themeStore).not.toContain("setProperty('--bg-active'");
  });

  it('themeStore control-soft 注入百分比与静态定义对齐（light 4/4/8、dark 5/6.5/9.5）', () => {
    const ts = readFile('src/api/themeStore.ts');
    const softBg = ts.match(/softBgPct = isDarkPreset \? '([^']+)' : '([^']+)'/);
    const softHover = ts.match(/softHoverPct = isDarkPreset \? '([^']+)' : '([^']+)'/);
    const softActive = ts.match(/softActivePct = isDarkPreset \? '([^']+)' : '([^']+)'/);
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
        new RegExp(`${token}:\\s*color-mix\\(in srgb,\\s*var\\(--[\\w-]+\\)\\s*(\\d+(?:\\.\\d+)?)%`)
      );
      return m?.[1] ?? null;
    };
    for (const token of [
      '--control-soft-bg',
      '--control-soft-bg-hover',
      '--control-soft-bg-active',
    ]) {
      expect(pctOf(lightBlock, token), `light ${token} 静态百分比`).toBe(
        token === '--control-soft-bg-active' ? '8' : '4'
      );
    }
    for (const [token, expectPct] of [
      ['--control-soft-bg', '5'],
      ['--control-soft-bg-hover', '6.5'],
      ['--control-soft-bg-active', '9.5'],
    ] as const) {
      expect(pctOf(darkBlock, token), `dark ${token} 静态百分比`).toBe(expectPct);
    }
  });

  it('--bg-hover/--bg-active 语义别名接线到 tint 档位（4% / 8%）且两主题一致', () => {
    const css = readFile('src/styles/tokens.css');
    const lightBlock = css.match(LIGHT_BLOCK_RE)?.[0] ?? '';
    const darkBlock = css.match(DARK_BLOCK_RE)?.[0] ?? '';
    for (const block of [lightBlock, darkBlock]) {
      expect(block).toContain('--bg-hover: var(--tint-hover)');
      expect(block).toContain('--bg-active: var(--tint-active)');
      expect(block).toContain(
        '--tint-hover: color-mix(in srgb, var(--text-primary) 4%, transparent)'
      );
      expect(block).toContain(
        '--tint-active: color-mix(in srgb, var(--text-primary) 8%, transparent)'
      );
    }
  });
});

describe('批次 2 · ⑧ 悬空引用清零 + 静态兜底存在', () => {
  it('--hover-bg / --active-bg / --chart-color 悬空引用全仓清零', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      const hits = src.match(/var\(--(?:hover-bg|active-bg|chart-color)[\w-]*\)/g);
      if (hits) {
        expect.fail(`${p} 存在悬空引用：${hits.join(', ')}`);
      }
    }
  });

  it('--z-drag-overlay-max 为 1 定义 + 2 消费点（无 fallback 裸引用）', () => {
    const files = walkSrc().filter((p) => /\.(?:css|tsx|ts)$/.test(p));
    let refCount = 0;
    for (const p of files) {
      const src = readFileSync(p, 'utf8');
      for (const line of src.split(/\r?\n/)) {
        if (!line.includes('z-drag-overlay-max')) continue;
        if (DEF_LINE_RE.test(line)) continue;
        refCount += 1;
        expect(line, `${p} 残留 fallback 裸引用`).not.toContain('99999');
      }
    }
    expect(refCount).toBe(2);
  });

  it('ui/Tooltip.module.css 含 --tooltip-translate 静态 fallback（translate(0) 形态）', () => {
    const rel = 'src/components/ui/Tooltip/Tooltip.module.css';
    const src = readFile(rel);
    const bare = src.match(/var\(--tooltip-translate\)(?!,)/g) ?? [];
    expect(bare, `${rel} 存在无 fallback 的裸引用`).toEqual([]);
    expect(src, rel).toContain('var(--tooltip-translate, translate(0))');
  });

  it('tokens.css 含 --accent-green/red-light-adaptive 静态定义（light + dark）', () => {
    const css = readFile('src/styles/tokens.css');
    expect(css.match(/--accent-green-light-adaptive:/g)?.length).toBe(2);
    expect(css.match(/--accent-red-light-adaptive:/g)?.length).toBe(2);
  });

  it('.card-tab.active 基础声明仅 1 条（死规则已删除；皮肤复合选择器不受影响）', () => {
    // 先规范化行尾再匹配：`\s*` 会吞 CRLF 的 \r，导致匹配串含换行
    const css = readFile('src/styles/shell/shell-workspace.css').replace(
      /\r\n/g,
      '\n'
    );
    const decls = css.match(/^[ \t]*\.card-tab\.active\s*\{/gm) ?? [];
    expect(decls).toEqual(['.card-tab.active {']);
  });
});
