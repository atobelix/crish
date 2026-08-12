/**
 * SD-13-R · turnInto 装配壳行数防回涨
 *
 * 钉：`turnInto.ts` 物理行数 **≤ 399**（薄 barrel；目标 <400，宜 <350）。
 * 类型 / 工厂 / MD 快路径优先外置同目录 `turnIntoTypes` / `turnIntoIntent` / `turnIntoMdPrefix`。
 *
 * 诚实边界：
 * - **≠ EL-01**；本测只防结构回涨，不关任何 EL
 * - **≠ A-BLK-08/09 e2e**；不把 provisional pending 说成已满关
 * - 不引入第二套写锥；禁止 DOM/PM serialize 旁路
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
      : resolve(process.cwd(), 'packages/block-paper/src/leaves');

/** SD-13-R 主文件上界（完成定义 <400） */
const TURN_INTO_MAX_LINES = 399;

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-13-R · turnInto 行数防回涨', () => {
  it(`turnInto.ts 物理行数 ≤ ${TURN_INTO_MAX_LINES}（仍 <400）`, () => {
    const filePath = join(DIR, 'turnInto.ts');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${TURN_INTO_MAX_LINES} 上界；` +
        `请外置到 turnIntoTypes / turnIntoIntent / turnIntoMdPrefix，勿堆回壳`
    ).toBeLessThanOrEqual(TURN_INTO_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('模块头保留 SD-13-R / 分模指针与诚实边界（≠ EL-01 / ≠ A-BLK-08 e2e）', () => {
    const src = readFileSync(join(DIR, 'turnInto.ts'), 'utf8');
    expect(src).toMatch(/SD-13-R/);
    expect(src).toMatch(/目标[^\n]*<400|目标[^\n]*&lt;400/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/A-BLK-08/);
    expect(src).toMatch(/turnIntoTypes|turnIntoIntent|turnIntoMdPrefix/);
    expect(src).toMatch(/pending_turn_into_flavour/);
    // 禁止假关：不得把本壳标成 EL-01 / A-BLK-08 e2e 已关闭
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
    expect(src).not.toMatch(/A-BLK-08\s*[已关关闭完成]/);
  });

  it('分模文件存在（防半拆）', () => {
    const required = [
      'turnIntoTypes.ts',
      'turnIntoIntent.ts',
      'turnIntoMdPrefix.ts',
    ];
    for (const name of required) {
      const p = join(DIR, name);
      const src = readFileSync(p, 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 ≠ EL-01`).toMatch(/≠\s*EL-01|EL-01/);
    }
  });
});
