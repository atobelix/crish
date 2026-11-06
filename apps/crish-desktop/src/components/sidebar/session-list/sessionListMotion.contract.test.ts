/**
 * sessionListMotion.contract.test.ts — 会话列表动效守卫（2026-11-06 S6）
 *
 * 背景：审计 A 指出会话列表的增/删/重排/置顶/inner fold 全部瞬时跳变
 * （行壳无任何 transition；活动行 font-weight 500 ↔ 400 跳变致文本/省略号
 * 抖动；时间/操作组 hover 对切无过渡；尾部宽度 24px ↔ 76px 瞬间撑开）。
 * S6 用 components/sidebar/session-list/useSessionListMotion 统一收敛：
 * 入场 = 挂载即带 data-motion="enter" 的 @starting-style（标签条同款）；
 * 退场 = S4 快照模式（data-motion="leaving" 目标态 0 高 + 透明，200ms 后卸载）；
 * 重排/置顶 = FLIP（WAAPI translateY，拖拽移位同款 120ms 时钟）；
 * inner fold = 纯增/纯减任意数量均做动效（整表替换才静默）。
 *
 * 本守卫钉住防回潮的六件事：
 * 1. 退场时长 = S4 口径（150ms 主档 + 50ms 余量 = 200ms，TS/CSS 双向同步）；
 * 2. FLIP 时钟 = 拖拽移位同款（120ms + cubic-bezier(0.2, 0, 0, 1)，
 *    与 sessionListDragShift 的 SHIFT_TRANSITION 逐字同值）；
 * 3. 行壳过渡 + @starting-style 入场 + [data-motion='leaving'] 退场
 *    + 3px gap 负 margin 补偿四条 CSS 规则都在（摘掉即红）；
 * 4. SessionRow 的 <li> 不再有行内 height 样式（它会压过 @starting-style
 *    首帧 0 高）；活动行字重钉死 400（G §1.6 + 标签条 400 惯例）；
 * 5. 三个分区（置顶/通用/项目）确实接线 hook；窗口化路径仍走
 *    WindowedSessionUl 原样渲染（虚拟窗口与行级动效互斥）；
 * 6. 本批触及的 CSS 模块不新增 keyframes 悬空（S 波收口 43 处教训：
 *    模块内引用的 animation 名必须在本文件内定义）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DURATION_EXIT_MS,
  EXIT_SETTLE_BUFFER_MS,
} from '../../../utils/motionTokens';
import { SESSION_ROW_LEAVE_MS } from './useSessionListMotion';
import {
  SESSION_ROW_SHIFT_DURATION_MS,
  SESSION_ROW_SHIFT_EASING,
} from './sessionListDragShift';

const SRC = join(import.meta.dirname, '..', '..', '..');
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

describe('S6 会话列表动效：时长口径', () => {
  it('退场时长 = S4 口径 150ms 主档 + 50ms 余量', () => {
    expect(SESSION_ROW_LEAVE_MS).toBe(
      DURATION_EXIT_MS + EXIT_SETTLE_BUFFER_MS
    );
    expect(SESSION_ROW_LEAVE_MS).toBe(200);
  });

  it('FLIP 时钟 = 拖拽移位同款 120ms + decelerate', () => {
    expect(SESSION_ROW_SHIFT_DURATION_MS).toBe(120);
    expect(SESSION_ROW_SHIFT_EASING).toBe('cubic-bezier(0.2, 0, 0, 1)');
    // SHIFT_TRANSITION 由此二者派生（字符串与原内联实现逐字一致）
    const dragShift = read(
      'components/sidebar/session-list/sessionListDragShift.ts'
    );
    expect(dragShift).toContain(
      'const SHIFT_TRANSITION = `transform ${SESSION_ROW_SHIFT_DURATION_MS}ms ${SESSION_ROW_SHIFT_EASING}`'
    );
  });
});

describe('S6 会话列表动效：行壳 CSS 规则', () => {
  const css = read('components/sidebar/SidebarSessionList.module.css');

  it('行壳有高度/透明度/负 margin 过渡（max-height 恒 28 不参变）', () => {
    expect(css).toContain('height var(--duration-normal) var(--ease-standard)');
    expect(css).toContain(
      'opacity var(--duration-micro) var(--ease-standard)'
    );
    expect(css).toContain(
      'margin-bottom var(--duration-normal) var(--ease-standard)'
    );
  });

  it('@starting-style 入场：首帧 0 高 + 透明，gap 变体负 margin 抵消 3px', () => {
    expect(css).toContain("@starting-style {");
    expect(css).toContain(".sessionItemWrap[data-motion='enter']");
    expect(css).toContain(
      ".sessionItemWrap[data-motion='enter'][data-motion-gap='true']"
    );
    expect(css).toContain('margin-bottom: -3px;');
  });

  it("[data-motion='leaving'] 退场：目标态 0 高 + 透明 + 禁指针命中", () => {
    expect(css).toContain(".sessionItemWrap[data-motion='leaving']");
    expect(css).toContain(
      ".sessionItemWrap[data-motion='leaving'][data-motion-gap='true']"
    );
    expect(css).toMatch(
      /\.sessionItemWrap\[data-motion='leaving'\] \{[^}]*pointer-events: none;/s
    );
  });

  it('尾部对齐：时间/操作组 100ms 交叉淡入淡出，尾部宽度同档过渡', () => {
    expect(css).toMatch(
      /\.sessionActionGroup \{[^}]*transition: opacity var\(--transition-micro\);/s
    );
    expect(css).toMatch(
      /\.sessionTime \{[^}]*transition: opacity var\(--transition-micro\);/s
    );
    expect(css).toMatch(
      /\.sessionTrailing \{[^}]*transition:\s*width var\(--transition-micro\),\s*min-width var\(--transition-micro\);/s
    );
  });

  it('CSS 模块无新增 keyframes 悬空（棘轮：零值）', () => {
    // 历史：.sessionRunningSpinner 曾引用本模块内无定义的 crish-spin
    // （S8 时代遗留的悬空引用）；keyframes 修复批已将其迁为
    // composes: crish-anim-spin from global（全局类呈现，不再是模块内
    // keyframes 引用），本模块悬空名归零。本守卫为棘轮——S6 及后续
    // 不新增悬空名；再有新的悬空名出现即红。
    expect(danglingKeyframes(css)).toEqual([]);
  });
});

describe('S6 会话列表动效：接线', () => {
  it('SessionRow 的 <li> 无行内 height 样式（不压 @starting-style 首帧）', () => {
    const row = read('components/sidebar/session-list/SessionRow.tsx');
    expect(row).not.toContain('SIDEBAR_SESSION_ROW_HEIGHT');
    expect(row).toContain('data-motion=');
    expect(row).toContain('data-motion-gap=');
  });

  it('活动行字重钉死 400（字重跳变致文本/省略号抖动，G §1.6）', () => {
    const css = read('components/sidebar/SidebarSessionList.module.css');
    expect(css).toMatch(
      /\.sessionItem\.active \{[^}]*font-weight: var\(--font-weight-normal, 400\);/s
    );
  });

  it('三个分区确实接线 useSessionListMotion', () => {
    for (const section of [
      'PinnedSection.tsx',
      'GeneralSection.tsx',
      'ProjectsSection.tsx',
    ]) {
      const src = read(`components/sidebar/session-list/${section}`);
      expect(src).toContain('useSessionListMotion(');
    }
  });

  it('窗口化路径仍走 WindowedSessionUl（与行级动效互斥）', () => {
    const general = read('components/sidebar/session-list/GeneralSection.tsx');
    expect(general).toContain('<WindowedSessionUl');
    expect(general).toContain('windowed');
  });
});
