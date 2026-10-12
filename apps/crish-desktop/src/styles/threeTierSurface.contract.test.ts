/**
 * 三档底色契约（2026-10-10 heson 定稿，local-fix-theme-gray-scrollbar）
 * 布局模型：外层通底（侧栏 + 标签栏，唯一透出云母）→ 内容矩形（主层：聊天区 + 右侧栏 + 卡片/弹层…）→ 输入框。
 * 每个主题只允许 --surface-outer / --surface-main / --surface-input 三个字面底色；
 * 其余 surface/bg 别名必须引用它们，hover/active 只能是统一叠加。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8').replace(
  /\r\n/g,
  '\n'
);
const block = (selectorStart: string): string => {
  const i = css.indexOf(selectorStart);
  expect(i, selectorStart).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}' && --depth === 0) return css.slice(open, k + 1);
  }
  throw new Error('unterminated block');
};
const light = block(":root,\nhtml[data-theme='default']");
const dark = block("html[data-theme='dark']");
const decl = (b: string, name: string): string | null =>
  b
    .match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1]
    ?.replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim() ?? null;

describe('三档底色契约', () => {
  for (const [theme, b] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${theme}: 只有三个字面底色，且由外到内各不相同`, () => {
      const outer = decl(b, '--surface-outer');
      const main = decl(b, '--surface-main');
      const input = decl(b, '--surface-input');
      for (const v of [outer, main, input]) expect(v).toMatch(/^(#|hsl\()/);
      expect(new Set([outer, main, input]).size).toBe(3);
    });

    it(`${theme}: 旧 surface/bg 别名全部落在三档上`, () => {
      const tier =
        /^var\(--(surface-(outer|main|input|chrome|paper|card|elevated|sunken)|bg-(primary|secondary|card|tertiary))\)/;
      for (const name of [
        '--surface-chrome',
        '--surface-paper',
        '--surface-card',
        '--surface-elevated',
        '--surface-sunken',
        '--bg-primary',
        '--bg-secondary',
        '--bg-card',
        '--bg-elevated',
        '--bg-tertiary',
        '--bg-workspace',
        '--composer-bg',
        '--bg-card-subtle',
      ]) {
        const v = decl(b, name) ?? decl(light, name);
        expect(v, `${theme} ${name}`).toMatch(tier);
      }
    });

    it(`${theme}: hover/active 是统一叠加`, () => {
      for (const name of [
        '--bg-hover',
        '--control-soft-bg',
        '--control-soft-bg-hover',
      ]) {
        expect(decl(b, name) ?? decl(light, name), `${theme} ${name}`).toBe(
          'var(--tint-hover)'
        );
      }
      // 卡片 hover/active 与 tint 同为「text-primary 透明叠加」，保留补丁前增量
      for (const name of [
        '--bg-card-hover',
        '--bg-card-active',
        '--tint-hover',
        '--tint-active',
      ]) {
        expect(decl(b, name), `${theme} ${name}`).toMatch(
          /^(color-mix\(in srgb, var\(--text-primary\) [\d.]+%, transparent\)|var\(--elevate-1(-active)?\))$/
        );
      }
    });
  }

  it('浅色三档 = heson 实测值；激活标签 = 输入档', () => {
    expect(decl(light, '--surface-outer')).toBe('#f2f1f0'); // K5（10-11 由 K4 加深）
    expect(decl(light, '--user-bubble-bg')).toBe('#eeedec');
    expect(decl(dark, '--surface-outer')).toBe('#1a1919');
    expect(decl(dark, '--user-bubble-bg')).toBe('var(--elevate-2)');
    expect(decl(light, '--surface-main')).toBe('#fbfaf9');
    expect(decl(light, '--surface-input')).toBe('#ffffff');
    expect(decl(light, '--tab-active-bg')).toBe('var(--surface-input)');
    // 深色元素底色：一律「所在层 + 提亮墨」派生，随皮肤 / accent 走（heson 2026-10-11）
    expect(decl(dark, '--element-ink')).toBe(
      'color-mix(in oklab, var(--text-primary) 88%, var(--accent-color) 12%)'
    );
    // 深色元素提亮阶梯：全部是 element-ink 透明叠加（任何层上相对增量一致）
    // 阶梯值集中在 --elevate-step-*：只断言结构与单调递增，不钉死百分比（heson 会逐步微调）
    for (const s of ['1', '1-active', '2', '3']) {
      expect(decl(dark, `--elevate-${s}`)).toBe(
        'color-mix(in srgb, var(--element-ink) var(' +
          `--elevate-step-${s}), transparent)`
      );
    }
    const pct = (s: string) =>
      parseFloat(decl(dark, `--elevate-step-${s}`) ?? 'NaN');
    expect(pct('1')).toBeLessThan(pct('1-active'));
    expect(pct('1-active')).toBeLessThan(pct('2'));
    expect(pct('2')).toBeLessThan(pct('3'));
    for (const [n, step] of [
      ['--tint-hover', 1],
      ['--bg-card-hover', 1],
      ['--composer-control-hover-bg', 1],
      ['--filetree-node-hover-bg', 1],
      ['--tint-active', '1-active'],
      ['--bg-card-active', '1-active'],
      ['--button-secondary-bg', 2],
      ['--user-bubble-bg', 2],
      ['--tab-active-bg', 3],
      ['--seg-slider-bg', 3],
      ['--sidebar-active', 3],
    ] as const) {
      expect(decl(dark, n), n).toBe('var(' + `--elevate-${step}` + ')');
    }
    for (const n of [
      '--user-bubble-bg',
      '--tab-active-bg',
      '--seg-slider-bg',
      '--button-secondary-bg',
    ]) {
      expect(decl(dark, n), n).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
    expect(decl(light, '--seg-slider-bg')).toBe('var(--surface-input)');
    expect(decl(light, '--button-secondary-bg')).toBe('var(--bg-card)');
  });

  it('布局模型：通底 = 外层，输入框 = 输入档；渐变只引用主层 token', () => {
    expect(decl(light, '--bg-workspace')).toBe('var(--surface-outer)');
    expect(decl(dark, '--bg-workspace')).toBe('var(--surface-outer)');
    expect(decl(light, '--composer-bg')).toBe('var(--surface-input)');
    const fade = css.match(/--chat-footer-fade:\s*([^;]+);/)?.[1] ?? '';
    expect(fade).toContain('var(--surface-main)');
    expect(fade).not.toMatch(/#[0-9a-f]{3,6}\b|hsl\(|rgb\(/i);
  });

  it('内容矩形框线：token 独立，只画左/顶 1px，右/底无边', () => {
    expect(decl(light, '--content-frame-border')).toBe('#ebeae9'); // 外层 K5 + 3 = K8
    expect(decl(dark, '--content-frame-border')).toBe('#222121'); // 外层 L10.2% + 3 → 13.2%
    const ws = readFileSync(
      resolve(
        __dirname,
        '../components/binary-tree/BinaryTreeWorkspace.module.css'
      ),
      'utf8'
    ).replace(/\r\n/g, '\n');
    const body = ws.match(/\n\.leafBody \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(body).toMatch(
      /border-left:\s*1px solid var\(--content-frame-border/
    );
    expect(body).toMatch(/border-top:\s*1px solid var\(--content-frame-border/);
    expect(body).toMatch(/border-right:\s*0;/);
    expect(body).toMatch(/border-bottom:\s*0;/);
    expect(body).toMatch(/border-radius:\s*var\(--radius-l\)/);
    // 活动叶不得把框线换成别的颜色
    const active =
      ws.match(/\.leaf\[data-active='true'\] \.leafBody \{([\s\S]*?)\}/)?.[1] ??
      '';
    expect(active).toMatch(/border-color:\s*var\(--content-frame-border/);
  });

  it('圆角：5 档 + 按钮用户锁 7px', () => {
    expect(decl(css, '--radius-s')).toBe('4px');
    expect(decl(css, '--radius-m')).toBe('8px');
    expect(decl(css, '--radius-l')).toBe('12px');
    expect(decl(css, '--radius-input')).toBe('20px');
    expect(decl(css, '--radius-pill')).toBe('9999px');
    expect(decl(css, '--radius-btn')).toBe('7px');
    for (const n of [
      '--radius-xs',
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--radius-xl',
      '--radius-2xl',
      '--radius-3xl',
      '--chat-bubble-radius',
      '--composer-radius-single',
      '--composer-radius-multi',
    ]) {
      expect(decl(css, n), n).toMatch(/^var\(--radius-(s|m|l|input|pill)\)$/);
    }
  });
});
