// @vitest-environment jsdom
/**
 * 布局 Token 契约测试（BATCH-06 · docs/layout-token-system/00-总方案 §8.5）
 *
 * 与门禁脚本 check-layout-tokens.mjs 互补：
 * - 本文件钉死密度矩阵关键 token 的存在性与偶数性（default/small/large 三档）；
 * - 钉死 ChatMessageList .listInner 纵向 padding 归零（几何 SSOT 归 chatScrollGeometry）；
 * - 钉死 Button 圆角 7px 用户锁（U1）。
 * - 【G-CASCADE】钉死密度档在层叠中**真实生效**（亮/暗 × 中/小/大 全组合）。
 *   背景：曾出现「[data-ui-size=…]（0,1,0）被基础块 html[data-theme='light']（0,1,1）
 *   压制 → 亮色下密度档静默失效、暗色下正常」的主题相关不一致；
 *   现密度档已升为 html[data-ui-size=…]（0,1,1），靠源码序取胜。
 *
 * 采用与 style-contract.test.ts 相同的 fs 契约断言方式
 * （new URL(rel, import.meta.url)，不依赖 process.cwd）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readFile(relPath: string): string {
  // 模板字面量先赋给中间变量再进 new URL——
  // 内联在 new URL 参数中的模板会被 vitest transform 破坏（资产 URL 重写）。
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

const TOKENS_CSS = 'src/styles/tokens.css';
const CHAT_LIST_CSS = 'src/components/chat-message-list/ChatMessageList.module.css';
const BUTTON_CSS = 'src/components/ui/Button/Button.module.css';

/* ── 顶层块扫描器（跳过 @media / @supports 等 at-rule 块） ──────────────── */

interface CssBlock {
  selector: string;
  body: string;
  order: number;
}

/** 只扫描顶层规则；`@` 开头的 at-rule（@media/@supports）整体跳过。 */
function scanTopLevelBlocks(css: string): CssBlock[] {
  const isWs = (ch: string) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f';
  const blocks: CssBlock[] = [];
  let i = 0;
  let order = 0;
  const n = css.length;
  while (i < n) {
    // 跳过空白与注释 —— 必须在捕获 selector 之前做，
    // 否则块前注释会被并入 selector，导致后续所有匹配失效（实测踩坑）。
    while (i < n) {
      if (isWs(css[i])) {
        i++;
        continue;
      }
      if (css.startsWith('/*', i)) {
        const end = css.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      break;
    }
    if (i >= n) break;
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const selector = css.slice(i, brace).trim();
    // 配平花括号（同时跳过注释，防止注释内出现花括号干扰配平）
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      if (css.startsWith('/*', j)) {
        const end = css.indexOf('*/', j + 2);
        j = end === -1 ? n : end + 2;
        continue;
      }
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    if (selector.startsWith('@')) {
      // at-rule：整体跳过，不作为顶层规则参与级联模型
      i = j;
      continue;
    }
    blocks.push({ selector, body, order: order++ });
    i = j;
  }
  return blocks;
}

/* ── 级联求值模型（G-CASCADE 的核心） ───────────────────────────────────── */

type ThemeName = 'default' | 'light' | 'dark';
type UiSizeName = 'small' | 'medium' | 'large';

interface CascadeCtx {
  theme: ThemeName;
  uiSize: UiSizeName;
}

/** 单个简单选择器是否命中 <html data-theme data-ui-size> */
function selectorApplies(one: string, ctx: CascadeCtx): boolean {
  const s = one.trim();
  if (s === ':root') return true;
  const theme = s.match(/^html\[data-theme=['"]([^'"]+)['"]\]$/);
  if (theme) return theme[1] === ctx.theme;
  const size = s.match(/^(?:html)?\[data-ui-size=['"]([^'"]+)['"]\]$/);
  if (size) return size[1] === ctx.uiSize;
  // 其他维度（data-perf-tier / data-platform / data-fullscreen）不参与本模型：
  // 由「密度采样 token 不被这些块重复定义」的完备性断言保证。
  return false;
}

/** 特异性：:root 与 [attr] = 10；html[attr] = 11（与 CSS 规则一致） */
function selectorSpecificity(one: string): number {
  if (/^html\[/.test(one.trim())) return 11;
  return 10;
}

/**
 * 级联胜出方：在「命中上下文且声明了该 token」的块中，
 * 取特异性最高者；同特异性按源码序取靠后者（与 CSS 一致）。
 */
function resolveWinner(
  blocks: CssBlock[],
  token: string,
  ctx: CascadeCtx
): { value: string; selector: string; order: number } | null {
  // 匹配前必须剥离注释：否则「; 与 token 之间隔着注释」会匹配失败
  // （实测踩坑：--border-color 前有多行注释，被误判为未定义）。
  // (?<![\w-]) 防止把 --border-color 误匹配进 --xxx-border-color 之类的更长名字。
  const tokenRe = new RegExp(`(?<![\\w-])${token.replace(/[-]/g, '\\$&')}\\s*:\\s*([^;]+);`);
  let best: { value: string; selector: string; order: number; spec: number } | null = null;
  for (const b of blocks) {
    const matching = b.selector.split(',').filter((s) => selectorApplies(s, ctx));
    if (matching.length === 0) continue;
    const decl = stripCssComments(b.body).match(tokenRe);
    if (!decl) continue;
    const spec = Math.max(...matching.map((s) => selectorSpecificity(s)));
    // `>=`：同特异性时，源码序靠后者胜（与 CSS 一致）
    if (!best || spec >= best.spec) {
      best = { value: decl[1].trim(), selector: b.selector, order: b.order, spec };
    }
  }
  return best;
}

/** 剥离 CSS 注释后再做声明匹配 —— 否则「; 与 token 之间隔着注释」会匹配失败
 *  （实测踩坑：--border-color 前有一段多行注释，导致被误判为未定义）。 */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function declaresToken(body: string, token: string): boolean {
  // (?<![\w-]) 防止把 --border-color 误匹配进 --xxx-border-color 之类的更长名字
  return new RegExp(`(?<![\\w-])${token.replace(/[-]/g, '\\$&')}\\s*:`).test(stripCssComments(body));
}

/** 从块 body 中读取 --space-* 定义表 */
function parseSpaceMap(body: string): Map<string, number> {
  const map = new Map<string, number>();
  const re = /(--space-[\w-]+)\s*:\s*(-?[\d.]+)px\s*;/g;
  let m;
  while ((m = re.exec(body))) {
    map.set(m[1], parseFloat(m[2]));
  }
  return map;
}

/** 密度档 token 顺序（与 §4 表一致） */
const SPACE_ORDER = [
  '--space-0_5',
  '--space-1',
  '--space-1_5',
  '--space-2',
  '--space-2_5',
  '--space-3',
  '--space-3_5',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--space-8',
  '--space-10',
];

/** 密度档采样 token（覆盖 space / font-size / control 三族） */
const DENSITY_SAMPLE_TOKENS = ['--space-1', '--space-2', '--space-3', '--font-size-xs', '--control-height'];

const THEMES: ThemeName[] = ['light', 'dark'];
const SIZES: UiSizeName[] = ['small', 'medium', 'large'];

describe('密度矩阵 space token 契约（BATCH-01 §4.5）', () => {
  const tokensCss = readFile(TOKENS_CSS);
  const allBlocks = scanTopLevelBlocks(tokensCss);

  // 基础/亮色块 = 声明了 --space-1 的 :root 引导块
  const baseBlock = allBlocks.find(
    (b) => /(^|,)\s*:root\s*(,|$)/.test(b.selector) && declaresToken(b.body, '--space-1')
  );
  const smallBlock = allBlocks.find((b) => /\[data-ui-size=['"]small['"]\]/.test(b.selector));
  const largeBlock = allBlocks.find((b) => /\[data-ui-size=['"]large['"]\]/.test(b.selector));

  it('基础块存在且包含全部关键 --space-* token', () => {
    expect(baseBlock, '未找到声明 --space-1 的 :root 基础块').toBeDefined();
    const map = parseSpaceMap(baseBlock!.body);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `基础块缺少 ${name}`).toBe(true);
    }
  });

  it('default 档所有关键 --space-* 均为偶数 px', () => {
    const map = parseSpaceMap(baseBlock!.body);
    for (const name of SPACE_ORDER) {
      const px = map.get(name);
      expect(px, `${name} 缺失`).toBeDefined();
      expect(Number.isInteger(px!), `${name}=${px} 非整数`).toBe(true);
      expect((px! % 2) as number, `${name}=${px} 为奇数`).toBe(0);
    }
  });

  it('small 档存在、全偶数、严格单调', () => {
    expect(smallBlock, '未找到 small 密度档块').toBeDefined();
    const map = parseSpaceMap(smallBlock!.body);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `small 缺少 ${name}`).toBe(true);
    }
    let prev = -Infinity;
    for (const name of SPACE_ORDER) {
      const px = map.get(name)!;
      expect(Number.isInteger(px), `small ${name}=${px} 非整数`).toBe(true);
      expect(px % 2, `small ${name}=${px} 为奇数`).toBe(0);
      expect(px, `small ${name}=${px} 非单调（prev=${prev}）`).toBeGreaterThan(prev);
      prev = px;
    }
  });

  it('large 档存在、全偶数、严格单调', () => {
    expect(largeBlock, '未找到 large 密度档块').toBeDefined();
    const map = parseSpaceMap(largeBlock!.body);
    for (const name of SPACE_ORDER) {
      expect(map.has(name), `large 缺少 ${name}`).toBe(true);
    }
    let prev = -Infinity;
    for (const name of SPACE_ORDER) {
      const px = map.get(name)!;
      expect(Number.isInteger(px), `large ${name}=${px} 非整数`).toBe(true);
      expect(px % 2, `large ${name}=${px} 为奇数`).toBe(0);
      expect(px, `large ${name}=${px} 非单调（prev=${prev}）`).toBeGreaterThan(prev);
      prev = px;
    }
  });
});

/* ── G-CASCADE：密度档必须在层叠中真实生效 ─────────────────────────────── */

describe('G-CASCADE · 密度档层叠生效契约（防「定义正确却被压制」）', () => {
  const tokensCss = readFile(TOKENS_CSS);
  const allBlocks = scanTopLevelBlocks(tokensCss);

  it('密度档选择器必须带元素限定 html[data-ui-size=…]（0,1,1），不得是 [data-ui-size=…]（0,1,0）', () => {
    // 若退回 [data-ui-size=…] 形态，会被基础/亮色块 html[data-theme='light']（0,1,1）压制，
    // 重演「亮色下密度档静默失效、暗色下正常」的主题相关不一致。
    const offenders = allBlocks
      .filter((b) => /(^|\s)\[data-ui-size=/.test(b.selector))
      .map((b) => b.selector);
    expect(offenders, `密度档选择器特异性不足：${offenders.join(' | ')}`).toEqual([]);
  });

  it('密度采样 token 在亮/暗 × 中/小/大 全组合下，级联胜出方均正确', () => {
    for (const token of DENSITY_SAMPLE_TOKENS) {
      for (const theme of THEMES) {
        // medium（html 上无 small/large 属性）→ 基础块
        const mid = resolveWinner(allBlocks, token, { theme, uiSize: 'medium' });
        expect(mid, `${token} @ ${theme}/medium 应有胜出方`).not.toBeNull();
        expect(
          /(^|,)\s*:root\s*(,|$)/.test(mid!.selector),
          `${token} @ ${theme}/medium 应由基础块胜出，实际：${mid!.selector}`
        ).toBe(true);

        // small / large → 密度档块（亮暗两主题都要，防「暗色正常、亮色失效」）
        for (const size of ['small', 'large'] as UiSizeName[]) {
          const w = resolveWinner(allBlocks, token, { theme, uiSize: size });
          expect(w, `${token} @ ${theme}/${size} 应有胜出方`).not.toBeNull();
          expect(
            w!.selector,
            `${token} @ ${theme}/${size} 应由 ${size} 密度档胜出，实际：${w!.selector}`
          ).toMatch(new RegExp(`data-ui-size=['"]${size}['"]`));
        }
      }
    }
  });

  it('large 档级联计算值必须等于 large 档声明值（F5 回归锚点：--space-1 曾为 4px≠6px）', () => {
    const largeBlock = allBlocks.find((b) => /data-ui-size=['"]large['"]/.test(b.selector));
    expect(largeBlock).toBeDefined();
    for (const token of DENSITY_SAMPLE_TOKENS) {
      expect(declaresToken(largeBlock!.body, token), `large 档缺少 ${token}`).toBe(true);
      for (const theme of THEMES) {
        const w = resolveWinner(allBlocks, token, { theme, uiSize: 'large' });
        const declared = largeBlock!.body.match(
          new RegExp(`(?:^|;)\\s*${token.replace(/[-]/g, '\\$&')}\\s*:\\s*([^;]+);`)
        )![1].trim();
        expect(
          w!.value.replace(/\s+/g, ' '),
          `${token} @ ${theme}/large 级联值应等于 large 声明值`
        ).toBe(declared.replace(/\s+/g, ' '));
      }
    }
  });

  it('密度采样 token 不得被暗色主题块重复定义（否则主题会压制密度档）', () => {
    const darkBlock = allBlocks.find((b) => /^html\[data-theme=['"]dark['"]\]$/.test(b.selector.trim()));
    expect(darkBlock, '未找到暗色主题块').toBeDefined();
    for (const token of DENSITY_SAMPLE_TOKENS) {
      expect(
        declaresToken(darkBlock!.body, token),
        `${token} 不应出现在暗色主题块（主题块不得复写密度档 token）`
      ).toBe(false);
    }
  });

  it('级联模型完备性：密度采样 token 不得出现在未纳入模型的块（perf-tier / platform / fullscreen）', () => {
    const uncovered = allBlocks.filter(
      (b) =>
        /data-perf-tier|data-platform|data-fullscreen/.test(b.selector) &&
        DENSITY_SAMPLE_TOKENS.some((t) => declaresToken(b.body, t))
    );
    expect(
      uncovered.map((b) => b.selector),
      '存在未纳入级联模型的块定义了密度采样 token，模型不完备'
    ).toEqual([]);
  });

  it('主题色级联：light 取基础块值、dark 取暗色块值（medium 档，二者必须不同）', () => {
    for (const token of ['--text-primary', '--surface-paper', '--border-color']) {
      const light = resolveWinner(allBlocks, token, { theme: 'light', uiSize: 'medium' });
      const dark = resolveWinner(allBlocks, token, { theme: 'dark', uiSize: 'medium' });
      expect(light, `${token} light 应有胜出方`).not.toBeNull();
      expect(dark, `${token} dark 应有胜出方`).not.toBeNull();
      expect(/(^|,)\s*:root\s*(,|$)/.test(light!.selector), `${token} 亮色应由基础块胜出`).toBe(true);
      expect(/data-theme=['"]dark['"]/.test(dark!.selector), `${token} 暗色应由暗色块胜出`).toBe(true);
      expect(light!.value, `${token} 亮暗值不应相同（否则主题失效）`).not.toBe(dark!.value);
    }
  });
});

describe('ChatMessageList .listInner 几何 SSOT 契约', () => {
  const listCss = readFile(CHAT_LIST_CSS);

  it('.listInner 不含 padding: 48px（纵向 padding 归 chatScrollGeometry 单轨）', () => {
    expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding:\s*48px/);
  });

  it('.listInner 不含 padding-top: 48px', () => {
    expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding-top:\s*48px/);
  });
});

describe('Button 圆角 7px 用户锁契约（U1 · 2026-09-11 起经 --radius-btn 单一权威定义）', () => {
  const tokensCss = readFile(TOKENS_CSS);
  const buttonCss = readFile(BUTTON_CSS);

  it('tokens.css 单一权威定义：--radius-btn: 7px 且 --button-radius: var(--radius-btn)', () => {
    // 机制变更：旧形态为消费点逐处 `var(--button-radius, 7px)` 兜底；
    // 现收敛为 tokens.css 单点权威定义（注释明写「密度档/主题块禁止覆写」）。
    expect(tokensCss).toMatch(/--radius-btn:\s*7px\s*;/);
    expect(tokensCss).toMatch(/--button-radius:\s*var\(--radius-btn\)\s*;/);
  });

  it('U1 反覆写：--button-radius / --radius-btn 只允许基础块定义，密度档/暗色块禁止覆写', () => {
    // 基础块（:root 引导列表）是唯一权威定义点（其选择器含 data-theme，需排除）；
    // 其余任何含密度/主题维度的块（small/large/dark）出现即属覆写。
    const offenders = scanTopLevelBlocks(tokensCss)
      .filter((b) => !/(^|,)\s*:root\s*(,|$)/.test(b.selector))
      .filter((b) => /data-ui-size|data-theme|data-perf-tier/.test(b.selector))
      .filter((b) => /(?<![\w-])--(button-radius|radius-btn)\s*:/.test(stripCssComments(b.body)))
      .map((b) => b.selector);
    expect(offenders, `U1 用户锁被覆写：${offenders.join(' | ')}`).toEqual([]);
  });

  it('Button.module.css 消费 var(--button-radius)，且无 8px 覆写', () => {
    expect(buttonCss).toContain('var(--button-radius)');
    expect(buttonCss).not.toContain('var(--button-radius, 8px)');
    expect(buttonCss).not.toMatch(/border-radius:\s*8px/);
  });
});
