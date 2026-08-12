/**
 * SD-34 · noteApplyOpsIpc 装配壳行数防回涨
 *
 * 钉：`noteApplyOpsIpc.ts` 物理行数 **≤ 399**（薄 barrel；目标 <400）。
 * 类型 / wire / mock / tauri / adapt 外置同目录分模。
 *
 * 诚实边界：
 * - **≠ EL-01**；**≠ EL-08**；本测只防结构回涨，不关任何 EL
 * - G2 notify（applied>0）不回退；无 Tauri 不默认可写
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
      : resolve(process.cwd(), 'src/api');

/** SD-34 主文件上界（完成定义 <400） */
const APPLY_OPS_MAX_LINES = 399;

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-34 · noteApplyOpsIpc 行数防回涨', () => {
  it(`noteApplyOpsIpc.ts 物理行数 ≤ ${APPLY_OPS_MAX_LINES}（仍 <400）`, () => {
    const filePath = join(DIR, 'noteApplyOpsIpc.ts');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${APPLY_OPS_MAX_LINES} 上界；` +
        `请外置到 types / wire / mock / tauri / adapt，勿堆回壳`
    ).toBeLessThanOrEqual(APPLY_OPS_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('模块头保留 SD-34 / 分模指针与诚实边界（≠ EL-01 / ≠ EL-08）', () => {
    const src = readFileSync(join(DIR, 'noteApplyOpsIpc.ts'), 'utf8');
    expect(src).toMatch(/SD-34/);
    expect(src).toMatch(/目标[^\n]*<400|主文件[^\n]*<400|主文件[^\n]*&lt;400/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/≠\s*EL-08|EL-08/);
    expect(src).toMatch(/CONN-G2/);
    expect(src).toMatch(/applied\s*>\s*0|applied>0/);
    expect(src).toMatch(/notifyNoteDocWritten/);
    expect(src).toMatch(/无 Tauri/);
    expect(src).toMatch(
      /noteApplyOpsIpc\.types|noteApplyOpsIpc\.wire|noteApplyOpsIpc\.adapt/
    );
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
    expect(src).not.toMatch(/EL-08\s*[已关关闭完成]/);
  });

  it('分模文件存在（防半拆）', () => {
    const required = [
      'noteApplyOpsIpc.types.ts',
      'noteApplyOpsIpc.wire.ts',
      'noteApplyOpsIpc.mock.ts',
      'noteApplyOpsIpc.tauri.ts',
      'noteApplyOpsIpc.adapt.ts',
    ];
    for (const name of required) {
      const p = join(DIR, name);
      const src = readFileSync(p, 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 ≠ EL-01`).toMatch(/≠\s*EL-01|EL-01/);
    }
  });
});
