/**
 * SD-43 · hydrateProjection barrel 行数防回涨
 *
 * 钉：`hydrateProjection.ts` 物理行数 **≤ 399**（薄 barrel；目标 <400）。
 * 四分模已由 SD-24 切开：types / fixture / adapt / product。
 * **本包禁止重做 SD-24 四分模**；只钉行数门 + 诚实字面。
 *
 * 诚实边界（测头自钉）：
 * - **≠ 打开完成**；本测只防结构回涨，不关 G-HYD / 打开文档完成
 * - **≠ EL-01/04/08**；不关任何 EL
 * - fixture 成功体字面 `source: 'fixture'`，禁止伪装 `tauri-ipc`
 * - adapt 成功体字面 `source: 'tauri-ipc'`（IPC 通道，≠ 打开完成）
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
      : resolve(process.cwd(), 'src/components/note-paper');

/** SD-43 主文件上界（完成定义 ≤399 / 仍 <400） */
const BARREL_MAX_LINES = 399;

const QUAD_MODULES = [
  'hydrateProjection.types.ts',
  'hydrateProjection.fixture.ts',
  'hydrateProjection.adapt.ts',
  'hydrateProjection.product.ts',
] as const;

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

function readSrc(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

/** 去掉块注释与行注释，只扫实现字面（注释可写「禁止伪装 tauri-ipc」） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('SD-43 · hydrateProjection 行数防回涨', () => {
  it(`hydrateProjection.ts 物理行数 ≤ ${BARREL_MAX_LINES}（仍 <400）`, () => {
    const src = readSrc('hydrateProjection.ts');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${BARREL_MAX_LINES} 上界；` +
        `请外置到 types / fixture / adapt / product，勿堆回壳（禁重做 SD-24 四分模）`
    ).toBeLessThanOrEqual(BARREL_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('四分模文件存在（types / fixture / adapt / product，防半拆）', () => {
    const barrel = readSrc('hydrateProjection.ts');
    expect(barrel).toMatch(/hydrateProjection\.types/);
    expect(barrel).toMatch(/hydrateProjection\.fixture/);
    expect(barrel).toMatch(/hydrateProjection\.adapt/);
    expect(barrel).toMatch(/hydrateProjection\.product/);

    for (const name of QUAD_MODULES) {
      const src = readSrc(name);
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
    }
  });

  it("fixture 源码字面 source: 'fixture'；adapt 字面 source: 'tauri-ipc'（禁止伪装）", () => {
    const fixtureSrc = readSrc('hydrateProjection.fixture.ts');
    const adaptSrc = readSrc('hydrateProjection.adapt.ts');
    const fixtureCode = stripComments(fixtureSrc);
    const adaptCode = stripComments(adaptSrc);

    expect(fixtureSrc).toMatch(/source:\s*['"]fixture['"]/);
    expect(adaptSrc).toMatch(/source:\s*['"]tauri-ipc['"]/);

    const fixtureHits = fixtureCode.match(/source:\s*['"]fixture['"]/g) ?? [];
    expect(
      fixtureHits.length,
      'fixture 实现须至少两处成功体 source: fixture（空投影 + seed）'
    ).toBeGreaterThanOrEqual(2);

    expect(
      fixtureCode,
      'fixture 实现字面禁止 source: tauri-ipc（注释可写禁令，赋值不行）'
    ).not.toMatch(/source:\s*['"]tauri-ipc['"]/);

    expect(adaptCode).toMatch(/source:\s*['"]tauri-ipc['"]/);
  });

  it('测头自钉 ≠ 打开完成 / ≠ EL-01/04/08（本测不关账）', () => {
    const self = readSrc('hydrateProjection.line-budget.test.ts');
    expect(self).toMatch(/≠\s*打开完成/);
    expect(self).toMatch(/≠\s*EL-01\/04\/08/);
    expect(self).not.toMatch(/打开完成\s*[已关关闭]/);
    expect(self).not.toMatch(/EL-01\s*[已关关闭完成]/);
    expect(self).not.toMatch(/EL-04\s*[已关关闭完成]/);
    expect(self).not.toMatch(/EL-08\s*[已关关闭完成]/);
  });
});
