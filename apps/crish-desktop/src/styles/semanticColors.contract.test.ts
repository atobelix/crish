import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 固定语义色契约（heson 2026-10-11）：
 * 差异增减、文件状态、danger/success/warning/info 的前景 / soft 底 / hover 底，
 * 浅色、深色各一套固定纯色 hex；不得 color-mix、不得透明、运行时皮肤不覆盖。
 */
const ROOT = resolve(__dirname, '..');
const css = readFileSync(resolve(ROOT, 'styles/tokens.css'), 'utf8').replace(
  /\r\n/g,
  '\n'
);
const runtime = readFileSync(
  resolve(ROOT, 'services/TokenRuntimeController.ts'),
  'utf8'
);
const darkStart = css.indexOf("html[data-theme='dark'] {");
const light = css.slice(0, darkStart);
const dark = css.slice(darkStart);
const decl = (block: string, name: string) =>
  block
    .match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1]
    ?.replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();

const FIXED = [
  '--diff-add',
  '--diff-del',
  '--status-modified',
  '--status-added',
  '--status-deleted',
  '--status-renamed',
  '--status-untracked',
  '--status-conflicted',
  '--danger-fg',
  '--danger-soft-bg',
  '--danger-soft-bg-hover',
  '--success-fg',
  '--success-soft-bg',
  '--success-soft-bg-hover',
  '--warning-fg',
  '--warning-soft-bg',
  '--warning-soft-bg-hover',
  '--info-fg',
  '--info-soft-bg',
  '--info-soft-bg-hover',
];

describe('固定语义色契约', () => {
  for (const [theme, block] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${theme}: 每个语义色都是不透明的固定格式（支持纯色 hex 与纯正 hsla）`, () => {
      for (const name of FIXED) {
        expect(decl(block, name), `${theme} ${name}`).toMatch(
          /^(?:#[0-9a-f]{6}|hsla?\([^)]+\))$/i
        );
      }
    });
  }

  it('浅色、深色两套取值不同（各自一档）', () => {
    for (const name of FIXED)
      expect(decl(light, name), name).not.toBe(decl(dark, name));
  });

  it('旧的半透明 soft 底与文件徽标前景都改指固定 token', () => {
    for (const [theme, block] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      expect(decl(block, '--color-error-bg'), theme).toBe(
        'var(--danger-soft-bg)'
      );
      expect(decl(block, '--color-success-bg'), theme).toBe(
        'var(--success-soft-bg)'
      );
      expect(decl(block, '--color-warning-bg'), theme).toBe(
        'var(--warning-soft-bg)'
      );
      expect(decl(block, '--color-info-bg'), theme).toBe('var(--info-soft-bg)');
      expect(decl(block, '--filetree-badge-add-fg'), theme).toBe(
        'var(--status-added)'
      );
      expect(decl(block, '--filetree-badge-mod-fg'), theme).toBe(
        'var(--status-modified)'
      );
      expect(decl(block, '--filetree-badge-del-fg'), theme).toBe(
        'var(--status-deleted)'
      );
    }
  });

  it('运行时皮肤不覆盖固定语义色；adaptive soft 底只引用固定 token', () => {
    for (const name of FIXED)
      expect(runtime.includes(`'${name}'`), name).toBe(false);
    expect(runtime).not.toMatch(
      /color-mix\(in srgb, var\(--accent-(green|red)\)/
    );
    // G-CASCADE 引用面契约：adaptive soft 底值恒为常量引用，指向固定语义
    // token，严禁改指 --user-*；tokens.css 明/暗两块静态声明同名同值兜底。
    expect(runtime).toContain("'var(--success-soft-bg)'");
    expect(runtime).toContain("'var(--danger-soft-bg)'");
  });

  it('组件：差异增减、状态徽标、危险项直接引用固定 token', () => {
    const diff = readFileSync(
      resolve(ROOT, 'components/diff/DiffCard.module.css'),
      'utf8'
    );
    expect(diff).toMatch(/\.statAdd \{\s*color: var\(--diff-add\)/);
    expect(diff).toMatch(/\.statDel \{\s*color: var\(--diff-del\)/);
    expect(diff).toContain('color: var(--status-renamed)');
    const badge = readFileSync(
      resolve(ROOT, 'components/overview/GitStatusBadge.module.css'),
      'utf8'
    );
    expect(badge).not.toMatch(/filetree-badge-[a-z]+-bg/);
    expect(badge).toContain('color: var(--status-untracked)');
    expect(badge).toContain('color: var(--status-conflicted)');
    const menu = readFileSync(
      resolve(ROOT, 'components/ui/SmartPanel/SmartPanel.module.css'),
      'utf8'
    ).replace(/\s+/g, ' ');
    expect(menu).toContain(
      '.item.danger:hover, .item.danger.focused { background-color: var(--danger-soft-bg); }'
    );
    expect(menu).toContain(
      '.item.danger:active { background-color: var(--danger-soft-bg-hover); }'
    );
    expect(decl(light, '--sep-danger-color')).toBe('var(--danger-fg)');
  });

  it('活力色系完整调色盘契约测试 (Full Saturated Palette)', () => {
    const paletteTokens = [
      '--palette-mint-green-fg',
      '--palette-mint-green-bg',
      '--palette-mint-green-border',
      '--palette-coral-rose-fg',
      '--palette-coral-rose-bg',
      '--palette-coral-rose-border',
      '--palette-amber-orange-fg',
      '--palette-amber-orange-bg',
      '--palette-amber-orange-border',
      '--palette-pure-blue-fg',
      '--palette-pure-blue-bg',
      '--palette-pure-blue-border',
      '--palette-pure-purple-fg',
      '--palette-pure-purple-bg',
      '--palette-pure-purple-border',
      '--palette-lime-green-fg',
      '--palette-lime-green-bg',
      '--palette-lime-green-border',
      '--palette-electric-cyan-fg',
      '--palette-electric-cyan-bg',
      '--palette-electric-cyan-border',
      '--palette-vivid-orange-fg',
      '--palette-vivid-orange-bg',
      '--palette-vivid-orange-border',
      '--palette-hot-pink-fg',
      '--palette-hot-pink-bg',
      '--palette-hot-pink-border',
      '--palette-peacock-teal-fg',
      '--palette-peacock-teal-bg',
      '--palette-peacock-teal-border',
      '--palette-royal-cobalt-fg',
      '--palette-royal-cobalt-bg',
      '--palette-royal-cobalt-border',
      '--palette-fuchsia-fg',
      '--palette-fuchsia-bg',
      '--palette-fuchsia-border',
      '--palette-sky-blue-fg',
      '--palette-sky-blue-bg',
      '--palette-sky-blue-border',
      '--palette-warm-gold-fg',
      '--palette-warm-gold-bg',
      '--palette-warm-gold-border',
      '--palette-jade-emerald-fg',
      '--palette-jade-emerald-bg',
      '--palette-jade-emerald-border',
      '--palette-warm-coral-fg',
      '--palette-warm-coral-bg',
      '--palette-warm-coral-border',
      '--palette-vermillion-fg',
      '--palette-vermillion-bg',
      '--palette-vermillion-border',
      '--palette-forest-green-fg',
      '--palette-forest-green-bg',
      '--palette-forest-green-border',
      '--palette-warm-lavender-fg',
      '--palette-warm-lavender-bg',
      '--palette-warm-lavender-border',
      '--palette-turmeric-deep-fg',
      '--palette-turmeric-deep-bg',
      '--palette-turmeric-deep-border',
      '--palette-true-indigo-fg',
      '--palette-true-indigo-bg',
      '--palette-true-indigo-border',
      '--palette-vivid-aqua-fg',
      '--palette-vivid-aqua-bg',
      '--palette-vivid-aqua-border',
      '--palette-grape-fg',
      '--palette-grape-bg',
      '--palette-grape-border',
      '--palette-spring-green-fg',
      '--palette-spring-green-bg',
      '--palette-spring-green-border',
      '--palette-deep-rouge-fg',
      '--palette-deep-rouge-bg',
      '--palette-deep-rouge-border',
      '--palette-mango-orange-fg',
      '--palette-mango-orange-bg',
      '--palette-mango-orange-border',
      '--palette-cerulean-fg',
      '--palette-cerulean-bg',
      '--palette-cerulean-border',
      '--palette-vivid-yellow-fg',
      '--palette-vivid-yellow-bg',
      '--palette-vivid-yellow-border',
      '--palette-deep-wine-fg',
      '--palette-deep-wine-bg',
      '--palette-deep-wine-border',
    ];
    for (const token of paletteTokens) {
      expect(css).toContain(token);
    }
  });
});
