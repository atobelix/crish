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
    it(`${theme}: 每个语义色都是不透明的固定 hex（不混色、不透明叠加）`, () => {
      for (const name of FIXED) {
        expect(decl(block, name), `${theme} ${name}`).toMatch(
          /^#[0-9a-f]{6}$/i
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
});
