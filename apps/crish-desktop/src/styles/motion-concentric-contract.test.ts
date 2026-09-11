// @vitest-environment jsdom
/**
 * 契约测试：同心几何圆角与 Apple 物理动效防回潮 (DIM-02)
 *
 * 规范依据：
 * - Jakub Krehel 7 大工程级设计标准 + Apple 物理流体交互体系
 * - 00-总方案实现规划.md §2.1 (Gate Inversion Defense)
 * - 01-review-topology-and-conflicts.md §6.1 (渐进式棘轮基线机制 Ratchet Guard)
 * - 03-review-test-assets-protection.md §4.2 (跨循环状态机修复与复合圆角剥离)
 *
 * 棘轮演进时序：
 * - Phase 0 (BATCH-00): 存量基线快照模式 (Ratchet Baseline)，锁定存量违规不回潮、不劣化；
 * - Phase 2 (BATCH-02): 原子基座重塑完成后，解开全量零容忍硬阻断 (0 违规)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：模板字面量先赋给中间变量再进 new URL，避免 vitest transform 静态重写
const anchorRel = 'src/tokens.css';
const target = `../../${anchorRel}`;
const SRC_DIR = fileURLToPath(new URL(target, import.meta.url)).replace(
  /[\\/]tokens\.css$/,
  ''
);

/** 递归扫描全部 CSS 样式文件（排除外部资产与构建产物） */
function collectCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'reference'].includes(entry)) continue;
      collectCssFiles(fullPath, out);
    } else if (entry.endsWith('.css')) {
      out.push(fullPath);
    }
  }
  return out;
}

describe('契约测试：同心几何圆角与 Apple 物理动效防回潮 (DIM-02) [Ratchet Mode]', () => {
  const cssFiles = collectCssFiles(SRC_DIR);

  // 全仓清除历史奇数/亚像素硬编码圆角，已全部规范化至 Design Tokens，基线硬性锁死为 0
  const ODD_RADIUS_PHASE0_BASELINE = 0;

  it('1. 静态扫描：全站清除 5px/7px 等奇数与亚像素圆角（Ratchet 模式防劣化）', () => {
    const FORBIDDEN_ODD_VALUES = [
      /\b3px\b/,
      /\b5px\b/,
      /\b7px\b/,
      /\b9px\b/,
      /\b11px\b/,
      /\b13px\b/,
      /\b15px\b/,
      /\b3\.5px\b/,
      /\b6\.5px\b/,
    ];

    const violations: { file: string; line: number; raw: string }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        // 无状态单行正则匹配，杜绝跨行共享 /g 状态机泄露 (Review-03 §4.2.1)
        const match = line.match(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/);
        if (!match) return;

        const rawValue = match[1].trim();
        // 彻底剥离 var(...) 复合结构（如 border-radius: 0 0 var(--radius) var(--radius)）(Review-03 §4.2.2)
        const strippedValue = rawValue.replace(/var\([^)]+\)/g, '').trim();
        if (!strippedValue) return;

        for (const forbidden of FORBIDDEN_ODD_VALUES) {
          if (forbidden.test(strippedValue)) {
            violations.push({
              file: file.replace(SRC_DIR, 'src/').replace(/\\/g, '/'),
              line: idx + 1,
              raw: line.trim(),
            });
            break;
          }
        }
      });
    }

    // 棘轮断言：严禁引入新增奇数圆角（存量 <= 基线；Phase 2 解锁 0 容忍）
    expect(
      violations.length,
      `奇数/亚像素圆角违规数量 (${violations.length}) 超过 Ratchet 基线 (${ODD_RADIUS_PHASE0_BASELINE})！\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBeLessThanOrEqual(ODD_RADIUS_PHASE0_BASELINE);
  });

  // Phase 0 存量基线快照：全仓现存 3 处过冲晃荡贝塞尔 (PreviewCard, Tabs, tokens)
  // Phase 2 重构完成后此阈值收敛至 0
  const CUBIC_BEZIER_PHASE0_BASELINE = 3;

  it('2. 静态扫描：根除 cubic-bezier 过冲抖动贝塞尔 y2 > 1.05（Ratchet 模式防劣化）', () => {
    const CUBIC_BEZIER_RE = /cubic-bezier\s*\(\s*([\d.]+)\s*,\s*([\d.-]+)\s*,\s*([\d.]+)\s*,\s*([\d.-]+)\s*\)/g;
    const violations: { file: string; y2: number }[] = [];

    for (const file of cssFiles) {
      const content = readFileSync(file, 'utf8');
      const matches = Array.from(content.matchAll(CUBIC_BEZIER_RE));
      for (const match of matches) {
        const y2 = parseFloat(match[4]);
        // 严格防线：临界阻尼与衰减震荡下，y2 绝不允许 > 1.05 (彻底封杀 1.5 弹性过冲)
        if (y2 > 1.05) {
          violations.push({
            file: file.replace(SRC_DIR, 'src/').replace(/\\/g, '/'),
            y2,
          });
        }
      }
    }

    // 棘轮断言：存量 <= 基线，严禁引入新的过冲曲线
    expect(
      violations.length,
      `过冲贝塞尔违规数量 (${violations.length}) 超过 Ratchet 基线 (${CUBIC_BEZIER_PHASE0_BASELINE})！\n${JSON.stringify(
        violations,
        null,
        2
      )}`
    ).toBeLessThanOrEqual(CUBIC_BEZIER_PHASE0_BASELINE);
  });

  it('3. tokens.css 物理动效与按钮圆角契约健全性', () => {
    const tokensPath = join(SRC_DIR, 'styles', 'tokens.css');
    expect(existsSync(tokensPath), 'tokens.css 必须物理存在').toBe(true);

    const tokensContent = readFileSync(tokensPath, 'utf8');
    // 按钮圆角基础档存在（Phase 0: 7px, Phase 1: 8px）。
    // 形态演进：早期为字面值 `--button-radius: 8px`；BATCH-01 §4.4 收敛为
    // 单一真源引用 `--button-radius: var(--radius-btn)`（:root 唯一权威定义 U1）。
    // 故断言须同时接受两种形态，且对间接引用额外校验落点值 —— 比只认字面值更严：
    // 前者只能证明"有个数字"，后者要求"引用链最终落到合法档位"。
    const buttonRadiusLiteral = tokensContent.match(/--button-radius:\s*(\d+px);/);
    const buttonRadiusAlias = tokensContent.match(/--button-radius:\s*var\(\s*(--[a-z0-9-]+)\s*\)/);
    expect(
      buttonRadiusLiteral || buttonRadiusAlias,
      '--button-radius 须为字面值或 var() 单一真源引用'
    ).toBeTruthy();
    if (buttonRadiusAlias) {
      // 间接形态：解析被引用的 token，校验其值仍落在合法档位（7px / 8px）
      const refName = buttonRadiusAlias[1];
      const refDef = tokensContent.match(
        new RegExp(`${refName.replace(/[-]/g, '\\-')}:\\s*(\\d+px);`)
      );
      expect(refDef, `${refName} 须有字面定义（引用链不得悬空）`).toBeTruthy();
      expect(['7px', '8px']).toContain(refDef?.[1]);
    } else {
      expect(['7px', '8px']).toContain(buttonRadiusLiteral?.[1]);
    }

    // 若 Phase 2 动效 Token 已注入，断言其符合数学临界阻尼规范
    if (tokensContent.includes('--ease-critical-damping:')) {
      expect(tokensContent).toContain('--ease-critical-damping: cubic-bezier(0.2, 0, 0, 1)');
      expect(tokensContent).toContain('--ease-tactile-release: cubic-bezier(0.16, 1, 0.3, 1)');
    }
  });

  it('4. Button 原子基座触感安全网检验（结构完整与无障碍降级）', () => {
    const btnCssPath = join(SRC_DIR, 'components', 'ui', 'Button', 'Button.module.css');
    expect(existsSync(btnCssPath), 'Button.module.css 必须物理存在').toBe(true);

    const btnCss = readFileSync(btnCssPath, 'utf8');
    expect(btnCss.length).toBeGreaterThan(0);

    // 若 Phase 2 scale(0.96) 微触感已注入，强制断言安全降级防线必须齐备
    if (btnCss.includes('scale(0.96)')) {
      expect(btnCss).toContain('transform: none !important');
      expect(btnCss).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });
});
