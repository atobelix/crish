/**
 * fileTreeMotion.contract.test.ts — 文件树动效守卫（2026-11-06 S6）
 *
 * 背景：审计 A 实测文件树行 transition-duration: 0s——展开/折叠、悬停/选中
 * 全部瞬时。S6 用 components/files/fileTreeMotion.diffToggleChange 做归因关口
 * （只认锚点目录后单段连续插入/删除，其余一律静默同步），展开 = 新增子行
 * WAAPI 淡入 + 下方行 FLIP 下移，折叠 = 子行快照留位淡出 + 下方行 FLIP 上移，
 * 时长走 S9 calcAccordionDuration 单一时钟；另把脉冲清除定时器 1400ms 对齐
 * 到 fileRowPulse 动画的 1.6s（原值在动画约 87% 处截断尾巴）。
 *
 * 本守卫钉住防回潮的五件事：
 * 1. 脉冲定时器 = 1600ms（与 1.6s 动画对齐），且源码里不再出现 1400ms 旧值；
 * 2. 切换意图有三路记录（单击目录行 / 键盘 ←/→/Enter / 双击目录），
 *    缺一路即红；
 * 3. FLIP/入场走 calcAccordionDuration 单一时钟（不新造时钟），
 *    退场快照有内容高度下限兜底（不被 overflow: hidden 裁掉）；
 * 4. 行过渡 + [data-tree-leaving] 退场规则都在（摘掉即红）；
 * 5. 本批触及的 CSS 模块不新增 keyframes 悬空（S 波收口 43 处教训）。
 *
 * 归因关口的 8 条单元断言在 fileTreeMotion.test.ts（展开/折叠/无变化/
 * 空锚点/锚点不符/非子树段/多处变化/过滤替换）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** 找出模块 CSS 中引用了却未在本文件定义的 keyframes 名（S 波收口模式）。 */
function danglingKeyframes(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = new Set(
    [...clean.matchAll(/@keyframes\s+([A-Za-z][\w-]*)/g)].map((m) => m[1])
  );
  const referenced = new Set<string>();
  const stripParens = (v: string) => {
    let prev = '';
    let cur = v;
    while (prev !== cur) {
      prev = cur;
      cur = cur.replace(/\([^()]*\)/g, '');
    }
    return cur;
  };
  for (const m of clean.matchAll(/animation\s*:([^;]+);/g)) {
    for (const part of stripParens(m[1]).split(',')) {
      const name = part.trim().match(/^([A-Za-z][\w-]*)/)?.[1];
      if (name && !['none', 'var', 'inherit', 'initial', 'unset'].includes(name)) {
        referenced.add(name);
      }
    }
  }
  for (const m of clean.matchAll(/animation-name\s*:([^;]+);/g)) {
    for (const name of m[1].split(',')) {
      const n = name.trim();
      if (n && n !== 'none') referenced.add(n);
    }
  }
  return [...referenced].filter((n) => !defined.has(n));
}

describe('S6 文件树动效：脉冲定时器与动画对齐', () => {
  it('清除定时器 = 1600ms（fileRowPulse 动画 1.6s），旧值 1400 已清', () => {
    const view = read('components/files/FileTreeView.tsx');
    expect(view).toContain('}, 1600);');
    // 注释里保留一句“原 1400ms”历史说明（恰一次），除此之外旧值已清
    expect(view.match(/1400/g)?.length ?? 0).toBe(1);
    const css = read('components/files/FilesCard.module.css');
    expect(css).toContain('1.6s');
    expect(css).not.toContain('1.4s');
  });
});

describe('S6 文件树动效：切换意图三路记录', () => {
  const view = read('components/files/FileTreeView.tsx');

  it('单击目录行记录', () => {
    expect(view).toContain('if (node.isDir) noteToggle(node.path);');
  });

  it('键盘 Enter / ArrowRight / ArrowLeft 记录', () => {
    expect(view).toMatch(/if \(node\.isDir\) noteToggle\(node\.path\);\s*\n\s*onSelect\(node\.path, node\.isDir\);/);
    expect(view).toContain("e.key === 'ArrowRight'");
    expect(view).toContain("e.key === 'ArrowLeft'");
  });

  it('双击目录行记录', () => {
    expect(view).toMatch(
      /onDoubleClick=\{\(\) => \{\s*\n\s*if \(node\.isDir\) noteToggle\(node\.path\);/
    );
  });
});

describe('S6 文件树动效：单一时钟与退场兜底', () => {
  const view = read('components/files/FileTreeView.tsx');

  it('FLIP 走 calcAccordionDuration 单一时钟（不新造时钟）', () => {
    expect(view).toContain(
      'const duration = calcAccordionDuration(maxDeltaPx, isOpening);'
    );
    expect(view).toContain("easing: EASE_DECELERATE");
  });

  it('退场快照有内容高度下限（不被 overflow: hidden 裁掉）', () => {
    expect(view).toContain('const contentHeight = Math.max(');
    expect(view).toContain('height: `${contentHeight}px`');
  });

  it('退场快照不带 data-tree-index（不干扰 FLIP/入场按下标查元素）', () => {
    expect(view).toContain(
      "data-tree-index={leaving ? undefined : (globalIdx ?? undefined)}"
    );
    expect(view).toContain("data-tree-leaving={leaving ? 'true' : undefined}");
  });
});

describe('S6 文件树动效：行 CSS 规则', () => {
  const css = read('components/files/FilesCard.module.css');

  it('行有背景色/透明度微档过渡（原 transition-duration: 0s）', () => {
    expect(css).toMatch(
      /\.filesRow \{[^}]*transition:\s*background-color var\(--transition-micro\),\s*opacity var\(--duration-micro\) var\(--ease-standard\);/s
    );
  });

  it("[data-tree-leaving='true'] 退场：目标态透明 + 禁指针命中", () => {
    expect(css).toContain(".filesRow[data-tree-leaving='true']");
    expect(css).toMatch(
      /\.filesRow\[data-tree-leaving='true'\] \{[^}]*opacity: 0;[^}]*pointer-events: none;/s
    );
  });

  it('CSS 模块无新增 keyframes 悬空', () => {
    expect(danglingKeyframes(css)).toEqual([]);
  });
});
