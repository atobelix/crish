// @vitest-environment jsdom
/**
 * 契约测试：G² 连续曲率圆角 · 真相源守卫（立项方案 §2.4 第一层 + §五 F7 口径）
 *
 * 守卫对象（四路扫描合成《立项方案》docs/g2-corner-rollout-20261106）：
 * - 参数层单值：--corner-exponent = 2.42 只许 tokens-radius.css 一处定义，
 *   与生成层常量 CORNER_EXPONENT 钉住一致；档位映射（G2_TIERS）与 token
 *   计算值逐项对账（含 R16 独立档 ↔ --radius-xl 计算值 16）；
 * - 生成层唯一实现：@g2-generator 标记全仓只许出现在 utils/cornerPath.ts；
 * - 禁止清单 + 棘轮：裸 px 圆角 / 私有半径变量（含正典 token 被模块覆写，
 *   即 §五 F5 的同族规则）/ 回退值漂移三类存量逐项入册基线
 *   （g2-corner-ratchet-baseline.ts），实际集合 ⊆ 基线且基线只减不增；
 *   corner-shape 与手写 clip-path path( 为零容忍（无基线，命中即红）。
 *
 * 口径说明（F7）：本契约的数值断言一律走「计算值」——var() 链按 token 定义
 * 解析出有效 px 再断言，不钉源码回退文本（回退文本漂移本身由棘轮的漂移类
 * 单独入册跟踪，核正归 F3 机械小批）。定义点自身的断言（token 文件内的
 * --corner-* 定义）属「文本即事实」，因定义点就是单一真相源本身。
 *
 * 自排除（守卫防腐，§2.4）：扫描跳过全部 *.test.* 与 __tests__（断言文本
 * 本身含半径字样）、基线数据文件（条目文本含声明字样）、生成层与接入层
 *  sanctioned 落点（utils/cornerPath.ts、components/ui/G2Surface/——它们是
 * 生成几何的唯一合法产地，由 G2 唯一性断言与产物验证测试另行钉住）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  G2_RATCHET_BARE_PX,
  G2_RATCHET_CAPS,
  G2_RATCHET_FALLBACK_DRIFT,
  G2_RATCHET_PRIVATE_VARS,
} from './g2-corner-ratchet-baseline';

const currentDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(currentDir, '..');

const EXCLUDED_FILES = new Set([
  'styles/g2-corner-ratchet-baseline.ts',
  'utils/cornerPath.ts',
]);
const EXCLUDED_PREFIXES = ['components/ui/G2Surface/'];

interface Exemption {
  file: string;
  declIncludes: string;
  reason: string;
}
/** 豁免表（§1.4；逐项带理由与表面名，不许整文件豁免——匹配到声明级才生效） */
const G2_EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'components/agent-card/agentCardUtils.ts',
    declIncludes: 'border-radius',
    reason:
      '§1.4 排除项：导出/分享 HTML 模板字符串内的字面量，那是独立 HTML 文档渲染，不在应用 UI 渲染面内，不归产品 G² 标准管辖',
  },
  {
    file: 'components/diff/DiffCard.module.css',
    declIncludes: 'border-radius: 0',
    reason:
      '用户裁决 2026-11-06：DiffCard 差异面板豁免 G²、保持纯直角（多文件同列显示），其直角契约是裁决的产物不是缺陷',
  },
  {
    file: 'components/ui/ConfirmDialog/ConfirmDialog.tsx',
    declIncludes: "borderRadius: '9999px'",
    reason:
      '用户裁决 2026-11-06：删除会话确认面板的按钮为胶囊形（borderRadius 9999px）；胶囊是裁决的产物不是缺陷，永不回退胶囊',
  },
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(p, acc);
    } else if (
      /\.(css|ts|tsx)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name)
    ) {
      acc.push(p);
    }
  }
  return acc;
}

const relOf = (p: string) => relative(srcDir, p).replace(/\\/g, '/');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const isTokenFile = (rel: string) =>
  /(^|\/)tokens-[^/]*\.css$/.test(rel) || /(^|\/)tokens\.css$/.test(rel);

interface Census {
  barePx: Set<string>;
  privateVars: Set<string>;
  cornerShape: Set<string>;
  handPaths: Set<string>;
  drift: Set<string>;
  exponentDefs: Array<{ file: string; value: number }>;
  kappaDefs: Array<{ file: string; value: number }>;
  generatorFiles: string[];
}

/** token 计算值解析：按 tokens.css 的级联序（radius → components）后定义胜出，递归解 var() 链 */
function buildTokenResolver(): (name: string) => number | null {
  const defs = new Map<string, string>();
  for (const f of ['tokens-radius.css', 'tokens-components.css']) {
    const text = stripComments(
      readFileSync(resolve(srcDir, 'styles', f), 'utf8'),
    );
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      defs.set(m[1], m[2].trim());
    }
  }
  const resolveName = (name: string, depth: number): number | null => {
    if (depth > 10 || !defs.has(name)) return null;
    const v = defs.get(name)!;
    const px = v.match(/^([\d.]+)px$/);
    if (px) return parseFloat(px[1]);
    const vm = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\d.]+)px\s*)?\)$/);
    if (vm) {
      const inner = resolveName(vm[1], depth + 1);
      return inner !== null ? inner : vm[2] ? parseFloat(vm[2]) : null;
    }
    return null;
  };
  return (name) => resolveName(name, 0);
}

function runCensus(): Census {
  const resolveToken = buildTokenResolver();
  const out: Census = {
    barePx: new Set(),
    privateVars: new Set(),
    cornerShape: new Set(),
    handPaths: new Set(),
    drift: new Set(),
    exponentDefs: [],
    kappaDefs: [],
    generatorFiles: [],
  };
  for (const file of walk(srcDir)) {
    const rel = relOf(file);
    const raw = readFileSync(file, 'utf8');
    // 生成层标记普查先于自排除：utils/cornerPath.ts 本人也在排除表内（其余
    // 扫描不适用于生成实现本身），但唯一性断言必须看见它——标记位于其文件
    // 头注释内，故在未剥离的原文上找（剥离后标记随注释消失）
    if (raw.includes('@g2-generator')) out.generatorFiles.push(rel);
    if (EXCLUDED_FILES.has(rel)) continue;
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const text = stripComments(raw);
    for (const m of text.matchAll(/corner-shape\s*:/g)) {
      out.cornerShape.add(`${rel} :: corner-shape:`);
    }
    for (const m of text.matchAll(/clip-path\s*:\s*path\(/g)) {
      out.handPaths.add(`${rel} :: clip-path: path(`);
    }
    for (const m of text.matchAll(/clipPath\s*:\s*['"`]path\(/g)) {
      out.handPaths.add(`${rel} :: clipPath: path(`);
    }
    if (/\.css$/.test(rel)) {
      for (const m of text.matchAll(/--corner-exponent\s*:\s*([\d.]+)/g)) {
        out.exponentDefs.push({ file: rel, value: parseFloat(m[1]) });
      }
      for (const m of text.matchAll(/--corner-kappa-peak\s*:\s*([\d.]+)/g)) {
        out.kappaDefs.push({ file: rel, value: parseFloat(m[1]) });
      }
      for (const m of text.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
        const val = m[1].trim();
        if (
          /^[\d\s.px]+$/.test(val) &&
          /\d/.test(val) &&
          !/^0(px)?$/.test(val.replace(/\s/g, ''))
        ) {
          out.barePx.add(`${rel} :: border-radius: ${norm(val)};`);
        }
        const vm = val.match(/^var\(\s*(--[\w-]+)\s*,\s*([\d.]+)px\s*\)$/);
        if (vm) {
          const resolved = resolveToken(vm[1]);
          if (resolved !== null && Math.abs(resolved - parseFloat(vm[2])) > 0.001) {
            out.drift.add(`${rel} :: border-radius: ${norm(val)};`);
          }
        }
      }
      if (!isTokenFile(rel)) {
        for (const m of text.matchAll(/(--[\w-]*radius[\w-]*)\s*:/g)) {
          out.privateVars.add(`${rel} :: ${m[1]}:`);
        }
      }
    } else {
      for (const m of text.matchAll(/borderRadius\s*:\s*(\d+(?:\.\d+)?)\b/g)) {
        out.barePx.add(`${rel} :: borderRadius: ${m[1]}`);
      }
      for (const m of text.matchAll(/borderRadius\s*:\s*['"](\d+(?:\.\d+)?)px['"]/g)) {
        out.barePx.add(`${rel} :: borderRadius: '${m[1]}px'`);
      }
      for (const m of text.matchAll(/(--[\w-]*radius[\w-]*)\s*:/g)) {
        out.privateVars.add(`${rel} :: ${m[1]}:`);
      }
    }
  }
  return out;
}

function applyExemptions(set: Set<string>): Set<string> {
  return new Set(
    [...set].filter((key) => {
      const [file, decl] = key.split(' :: ');
      return !G2_EXEMPTIONS.some(
        (e) => e.file === file && decl.includes(e.declIncludes),
      );
    }),
  );
}

function expectSubset(actual: Set<string>, baseline: readonly string[], label: string) {
  const base = new Set(baseline);
  const extra = [...actual].filter((k) => !base.has(k));
  expect(
    extra,
    `${label}：出现基线外的新违规（棘轮只减不增，新违规必须先消除或经立项修订基线）：\n${extra.join('\n')}`,
  ).toEqual([]);
}

describe('G² 真相源守卫（g2-corner）', () => {
  const census = runCensus();

  it('契约 G1：参数层单值——--corner-exponent 只在 tokens-radius.css 定义且 = 2.42，与生成层常量一致', () => {
    expect(census.exponentDefs).toEqual([
      { file: 'styles/tokens-radius.css', value: 2.42 },
    ]);
    expect(census.kappaDefs).toEqual([
      { file: 'styles/tokens-radius.css', value: 1.337 },
    ]);
    const gen = readFileSync(resolve(srcDir, 'utils', 'cornerPath.ts'), 'utf8');
    const cm = gen.match(/CORNER_EXPONENT = ([\d.]+)/);
    expect(cm, 'utils/cornerPath.ts 必须导出 CORNER_EXPONENT 常量').toBeTruthy();
    expect(parseFloat(cm![1])).toBe(2.42);
  });

  it('契约 G2：生成层唯一实现 + 档位映射与 token 计算值逐项对账（含 R16 独立档）', () => {
    expect(census.generatorFiles).toEqual(['utils/cornerPath.ts']);
    const resolveToken = buildTokenResolver();
    const gen = readFileSync(resolve(srcDir, 'utils', 'cornerPath.ts'), 'utf8');
    const tierBlock = gen.match(/G2_TIERS = \{([\s\S]*?)\} as const/);
    expect(tierBlock, 'cornerPath.ts 必须含 G2_TIERS 档位表').toBeTruthy();
    const tierOf = (k: string) => {
      const m = tierBlock![1].match(new RegExp(`${k}:\\s*([\\d.]+)`));
      expect(m, `G2_TIERS 必须含档位 ${k}`).toBeTruthy();
      return parseFloat(m![1]);
    };
    // 计算值对账：档位数值必须等于对应 token 的有效计算值（不钉任何回退文本）
    expect(tierOf('dock')).toBe(resolveToken('--radius-dock'));
    // modal 档对账锚 = --radius-2xl(20)：待裁决 #4 裁定模态统一 20 后，
    // 专设 --radius-modal(24) 已按 §五 F4 删除（零消费不留死定义）
    expect(tierOf('modal')).toBe(resolveToken('--radius-2xl'));
    expect(tierOf('menuOuter')).toBe(resolveToken('--radius-menu-outer'));
    expect(tierOf('r16')).toBe(resolveToken('--radius-xl'));
    expect(tierOf('card')).toBe(resolveToken('--radius-card'));
    expect(tierOf('btn')).toBe(resolveToken('--radius-btn'));
    expect(tierOf('control')).toBe(resolveToken('--radius-control'));
    expect(tierOf('row')).toBe(resolveToken('--radius-row'));
    // 参数层映射表（定义点文本即事实）：R16 必须在 tokens 形状区单独立档
    const tokens = readFileSync(
      resolve(srcDir, 'styles', 'tokens-radius.css'),
      'utf8',
    );
    expect(tokens).toMatch(/R16 独立档 --radius-xl 16/);
  });

  it('契约 G3：零容忍——corner-shape 与手写角路径全仓为零', () => {
    expect([...census.cornerShape]).toEqual([]);
    expect([...census.handPaths]).toEqual([]);
  });

  it('契约 G4：棘轮——三类存量违规 ⊆ 基线，基线条数 = CAPS（只减不增）', () => {
    expectSubset(applyExemptions(census.barePx), G2_RATCHET_BARE_PX, '裸 px 圆角');
    expectSubset(applyExemptions(census.privateVars), G2_RATCHET_PRIVATE_VARS, '私有半径变量/ token 覆写');
    expectSubset(applyExemptions(census.drift), G2_RATCHET_FALLBACK_DRIFT, '回退值漂移');
    expect(new Set(G2_RATCHET_BARE_PX).size).toBe(G2_RATCHET_BARE_PX.length);
    expect(new Set(G2_RATCHET_PRIVATE_VARS).size).toBe(G2_RATCHET_PRIVATE_VARS.length);
    expect(new Set(G2_RATCHET_FALLBACK_DRIFT).size).toBe(G2_RATCHET_FALLBACK_DRIFT.length);
    expect(G2_RATCHET_BARE_PX.length).toBe(G2_RATCHET_CAPS.barePx);
    expect(G2_RATCHET_PRIVATE_VARS.length).toBe(G2_RATCHET_CAPS.privateVars);
    expect(G2_RATCHET_FALLBACK_DRIFT.length).toBe(G2_RATCHET_CAPS.fallbackDrift);
  });

  it('契约 G5：真相源在打包链上——tokens.css 聚合入口含 tokens-radius.css', () => {
    const tokensCss = readFileSync(resolve(srcDir, 'styles', 'tokens.css'), 'utf8');
    expect(tokensCss).toContain("@import './tokens-radius.css';");
    expect(tokensCss).toContain("@import './tokens-components.css';");
  });

  it('契约 G6：SEP 族单挂接点（第一波丙 · 槽 B）——外壳与消费类均不得自绘油漆', () => {
    // 外壳油漆只在 SepPanelShell（ui/G2Surface）声明一处；.panel /
    // .cascadeSubmenu 只留布局 + 兜底圆弧 + 全局弹层动画 composes。
    // 消费类（.plusMenu/.permMenu/.pickerPanel/.activityPanelOuter）只留
    // 布局/排版。任一面重新自绘背景/边框/阴影即变红（防分叉回归）。
    const readCss = (...segments: string[]) =>
      readFileSync(resolve(srcDir, ...segments), 'utf8');
    const ruleBlock = (css: string, cls: string) => {
      const m = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]+)\\}`));
      expect(m, `必须含 .${cls} 规则块`).toBeTruthy();
      return m![1];
    };
    const expectNoPaint = (block: string, where: string) => {
      expect(block, `${where} 不得自绘 background`).not.toMatch(/background\s*:/);
      expect(block, `${where} 不得自绘 border`).not.toMatch(/(^|[^-])border\s*:/);
      expect(block, `${where} 不得自绘 box-shadow`).not.toMatch(/box-shadow\s*:/);
    };
    const sepCss = readCss(
      'components',
      'ui',
      'SmartExpandablePanel',
      'SmartExpandablePanel.module.css',
    );
    expectNoPaint(ruleBlock(sepCss, 'panel'), '.panel');
    expectNoPaint(ruleBlock(sepCss, 'cascadeSubmenu'), '.cascadeSubmenu');
    // 全局弹层动画 composes 是外壳的入/退场载体（Radix 面）
    expect(ruleBlock(sepCss, 'panel')).toMatch(
      /composes:\s*crish-popover-anim from global/,
    );
    expect(ruleBlock(sepCss, 'cascadeSubmenu')).toMatch(
      /composes:\s*crish-popover-anim from global/,
    );
    const noPaintNoRadius = (block: string, where: string) => {
      expectNoPaint(block, where);
      expect(block, `${where} 不得自绘 border-radius`).not.toMatch(
        /border-radius\s*:/,
      );
    };
    noPaintNoRadius(
      ruleBlock(
        readCss('components', 'chat-composer', 'ComposePlusMenu.module.css'),
        'plusMenu',
      ),
      '.plusMenu',
    );
    noPaintNoRadius(
      ruleBlock(
        readCss('components', 'chat-composer', 'PermissionModeMenu.module.css'),
        'permMenu',
      ),
      '.permMenu',
    );
    noPaintNoRadius(
      ruleBlock(
        readCss('components', 'chat-card', 'ProjectPickerMenu.module.css'),
        'pickerPanel',
      ),
      '.pickerPanel',
    );
    noPaintNoRadius(
      ruleBlock(
        readCss('components', 'chat-card', 'SubagentHeaderPanel.module.css'),
        'activityPanelOuter',
      ),
      '.activityPanelOuter',
    );
  });
});
