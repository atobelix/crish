/**
 * 三档底色契约（2026-10-10 heson 定稿，local-fix-theme-gray-scrollbar）
 * 布局模型：外层通底（侧栏 + 标签栏，唯一透出云母）→ 内容矩形（主层：聊天区 + 右侧栏 + 卡片/弹层…）→ 输入框。
 * 每个主题只允许 --surface-outer / --surface-main / --surface-input 三个字面底色；
 * 其余 surface/bg 别名必须引用它们，hover/active 只能是统一叠加。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rawCss = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8').replace(
  /\r\n/g,
  '\n'
);
let light = '';
let dark = '';
if (rawCss.includes('@import')) {
  const imports = [...rawCss.matchAll(/@import\s+['"]\.\/([^'"]+)['"];/g)].map(
    (m) => m[1]
  );
  for (const file of imports) {
    const fcontent = readFileSync(resolve(__dirname, file), 'utf8').replace(
      /\r\n/g,
      '\n'
    );
    const dStart = fcontent.indexOf("html[data-theme='dark']");
    if (dStart !== -1) {
      light += '\n' + fcontent.slice(0, dStart);
      dark += '\n' + fcontent.slice(dStart);
    } else {
      light += '\n' + fcontent;
    }
  }
} else {
  const darkStart = rawCss.indexOf("html[data-theme='dark'] {");
  light = rawCss.slice(0, darkStart);
  dark = rawCss.slice(darkStart);
}
const css = `${light}\n${dark}`;
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
      // T-BLK-07b：三档字面值移入 --user-surface-* 参数声明（B 类，JS 运行时覆盖），
      // A 类三档声明为 var(--user-*, 本块原静态值) 字面量兜底派生；
      // 本断言钉死参数声明字面值与派生形态（含 fallback 同值）
      const outer = decl(b, '--user-surface-outer');
      const main = decl(b, '--user-surface-main');
      const input = decl(b, '--user-surface-input');
      for (const v of [outer, main, input]) expect(v).toMatch(/^(#|hsl\()/);
      expect(new Set([outer, main, input]).size).toBe(
        theme === 'light' ? 2 : 3
      );
      // G-CASCADE 结构契约：A 类三档声明以 var(--user-*, 本块原静态值) 字面量
      // 兜底承载亮暗 distinct（无 JS/首帧兜底正确性）；字面值仍唯一钉在
      // --user-surface-* 参数声明上，fallback 与其同值。
      const fallback = (name: string, hex: string) =>
        'var(' + '--user-' + name.slice(2) + ', ' + hex + ')';
      const fb =
        theme === 'light'
          ? { outer: '#f7f6f5', main: '#ffffff', input: '#ffffff' }
          : { outer: '#1e1e1e', main: '#141414', input: '#232323' };
      expect(decl(b, '--surface-outer')).toBe(
        fallback('--surface-outer', fb.outer)
      );
      expect(decl(b, '--surface-main')).toBe(
        fallback('--surface-main', fb.main)
      );
      expect(decl(b, '--surface-input')).toBe(
        fallback('--surface-input', fb.input)
      );
    });

    it(`${theme}: 旧 surface/bg 别名全部落在三档上`, () => {
      const tier =
        /^var\(--(surface-(outer|main|input|chrome|paper|card|elevated|sunken|overlay)|bg-(primary|secondary|card|tertiary))\)/;
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
      // 验证 hover / active / selected 统一叠加到正典 --state-* (SSOT)
      expect(decl(b, '--state-hover'), `${theme} --state-hover`).toBe(
        'color-mix(in srgb, var(--text-primary) var(--state-hover-pct), transparent)'
      );
      expect(decl(b, '--state-active'), `${theme} --state-active`).toBe(
        'color-mix(in srgb, var(--text-primary) var(--state-active-pct), transparent)'
      );
      expect(decl(b, '--state-selected'), `${theme} --state-selected`).toBe(
        'color-mix(in srgb, var(--text-primary) var(--state-selected-pct), transparent)'
      );

      // 组件 hover/active 统一收敛至正典 state tokens
      for (const [name, expected] of [
        ['--filetree-node-hover-bg', 'var(--state-hover)'],
        ['--artifact-btn-hover-bg', 'var(--state-hover)'],
        ['--artifact-btn-active-bg', 'var(--state-active)'],
        ['--md-code-copy-hover-bg', 'var(--state-hover)'],
        ['--md-table-row-hover-bg', 'var(--state-hover)'],
      ] as const) {
        expect(decl(b, name) ?? decl(light, name), `${theme} ${name}`).toBe(
          expected
        );
      }

      // 卡片 hover/active 属于 text-primary 透明叠加
      expect(decl(light, '--bg-card-hover')).toMatch(
        /^color-mix\(in srgb, var\(--text-primary\) [\d.]+%, transparent\)$/
      );
      expect(decl(light, '--bg-card-active')).toMatch(
        /^color-mix\(in srgb, var\(--text-primary\) [\d.]+%, transparent\)$/
      );
    });
  }

  it('浅色三档 = heson 实测值；激活态正典接线', () => {
    // T-BLK-07b：字面实测值现在钉在 --user-surface-* 参数声明上
    expect(decl(light, '--user-surface-outer')).toBe('#f7f6f5');
    expect(decl(light, '--user-bubble-bg')).toBe(
      'color-mix(in srgb, var(--text-primary) 5.5%, transparent)'
    );
    expect(decl(dark, '--user-surface-outer')).toBe('#1e1e1e');
    expect(decl(dark, '--user-bubble-bg')).toBe(
      'color-mix(in srgb, var(--user-text-primary) 9%, transparent)'
    );
    expect(decl(light, '--user-surface-main')).toBe('#ffffff');
    expect(decl(light, '--user-surface-input')).toBe('#ffffff');
    expect(decl(light, '--tab-active-bg')).toBe('var(--surface-input)');

    // 状态透明叠加阶梯单调递增验证（纯净轻中性微光，严禁倒挂）
    for (const [theme, b] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      const hoverPct = parseFloat(decl(b, '--state-hover-pct') ?? 'NaN');
      const activePct = parseFloat(decl(b, '--state-active-pct') ?? 'NaN');
      const selectedPct = parseFloat(decl(b, '--state-selected-pct') ?? 'NaN');
      expect(hoverPct, `${theme} hover < active`).toBeLessThan(activePct);
      expect(activePct, `${theme} active <= selected`).toBeLessThanOrEqual(
        selectedPct
      );
    }

    // 深色激活态正典接线：收敛至 --state-selected 与 --state-active
    for (const [n, expected] of [
      ['--tab-active-bg', 'var(--state-selected)'],
      ['--seg-slider-bg', 'var(--state-selected)'],
      ['--sidebar-active', 'var(--state-selected)'],
      ['--button-secondary-bg', 'var(--state-active)'],
    ] as const) {
      expect(decl(dark, n), n).toBe(expected);
    }

    // 浅色激活态正典接线
    expect(decl(light, '--seg-slider-bg')).toBe('var(--surface-input)');
    expect(decl(light, '--button-secondary-bg')).toBe('var(--bg-card)');

    // 动态层底色严禁硬编码字面颜色
    for (const n of [
      '--user-bubble-bg',
      '--tab-active-bg',
      '--seg-slider-bg',
      '--button-secondary-bg',
    ]) {
      expect(decl(dark, n), n).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
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

  it('圆角：完备偶数阶梯 + 按钮用户锁 7px', () => {
    expect(decl(css, '--radius-xs')).toBe('4px');
    expect(decl(css, '--radius-sm')).toBe('6px');
    expect(decl(css, '--radius-md')).toBe('8px');
    expect(decl(css, '--radius-lg')).toBe('10px');
    expect(decl(css, '--radius-l')).toBe('12px');
    expect(decl(css, '--radius-xl')).toBe('16px');
    expect(decl(css, '--radius-2xl')).toBe('20px');
    expect(decl(css, '--radius-3xl')).toBe('24px');
    expect(decl(css, '--radius-pill')).toBe('9999px');
    expect(decl(css, '--radius-btn')).toBe('7px');
    for (const n of [
      '--chat-bubble-radius',
      '--composer-radius-single',
      '--composer-radius-multi',
    ]) {
      expect(decl(css, n), n).toMatch(/^var\(--radius-(2xl|3xl|input)\)$/);
    }
  });
});
