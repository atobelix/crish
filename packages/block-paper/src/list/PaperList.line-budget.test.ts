/**
 * SD-20 · PaperList 装配壳行数防回涨
 *
 * 钉：`PaperList.ts` 物理行数 **≤ 399**（薄宿主；目标 <400，相对切开前 488）。
 * 契约 / 类型 / plan / reconcile / spacer 优先外置同目录旁挂。
 *
 * 诚实边界：
 * - **≠ EL-01**；本测只防结构回涨，不关任何 EL
 * - **≠ W3-P** WindowManager；**≠ C2 默开**
 * - 禁止 CSS hidden 挂全量 DOM 冒充虚拟化
 * - 行数口径：物理全量行（含注释与空行）
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'packages/block-paper/src/list');

/** SD-20 主文件上界（完成定义 <400） */
const PAPER_LIST_MAX_LINES = 399;

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-20 · PaperList 行数防回涨', () => {
  it(`PaperList.ts 物理行数 ≤ ${PAPER_LIST_MAX_LINES}（仍 <400）`, () => {
    const filePath = join(DIR, 'PaperList.ts');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `宿主壳 ${lineCount} 行已达/超 ${PAPER_LIST_MAX_LINES} 上界；` +
        `请外置到 paperListConstants / types / plan / reconcile / spacer，勿堆回壳`
    ).toBeLessThanOrEqual(PAPER_LIST_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('模块头保留 SD-20 / 分模指针与诚实边界（≠ EL-01 / ≠ W3-P / ≠ C2 默开）', () => {
    const src = readFileSync(join(DIR, 'PaperList.ts'), 'utf8');
    expect(src).toMatch(/SD-20/);
    expect(src).toMatch(/目标[^\n]*<400|主文件[^\n]*<400/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/W3-P/);
    expect(src).toMatch(/≠\s*C2|C2\s*默开/);
    expect(src).toMatch(
      /paperListConstants|paperListTypes|paperListPlan|paperListReconcile|paperListSpacer/
    );
    expect(src).toMatch(/hidden/);
    // 禁止假关：不得把本壳标成 EL-01 / W3-P 已关闭，也不得默开 C2
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
    expect(src).not.toMatch(/W3-P\s*[已关关闭完成]/);
    expect(src).not.toMatch(/enableProductPaperList/);
  });

  it('分模文件存在（防半拆）', () => {
    const required = [
      'paperListConstants.ts',
      'paperListTypes.ts',
      'paperListPlan.ts',
      'paperListReconcile.ts',
      'paperListSpacer.ts',
    ];
    for (const name of required) {
      const p = join(DIR, name);
      const src = readFileSync(p, 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 SD-20`).toMatch(/SD-20/);
      expect(src, `${name} 须钉 ≠ EL-01`).toMatch(/≠\s*EL-01|EL-01/);
      expect(src, `${name} 须钉 ≠ W3-P`).toMatch(/W3-P/);
      expect(src, `${name} 须钉 ≠ C2`).toMatch(/C2/);
    }
  });
});
