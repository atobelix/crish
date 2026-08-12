/**
 * SD-44 · noteMirrorIpc 装配壳行数防回涨
 *
 * 钉：`noteMirrorIpc.ts` 物理行数 **≤ 399**（薄 barrel；目标 <400）。
 * 类型 / wire / parse / mock / tauri 外置同目录五分模（SD-33 已切；本测只钉门，不重做切开）。
 *
 * 测头自钉（本文件诚实边界，≠ 改产品默认）：
 * - **≠ EL-03**；本测只防结构回涨，不关任何 EL
 * - **≠ inotify 满关**；**≠ inotify 产品满关**
 * - **≠ 重做 E2′**；**≠ 重做 E3**；**≠ 占 SD-33** 整包重切
 * - CONN-E2 默认关 / CONN-E3 头纪律只读断言，不改默认
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

/** SD-44 主文件上界（完成定义 ≤399 / <400） */
const MIRROR_IPC_MAX_LINES = 399;

const FIVE_SPLIT = [
  'noteMirrorIpc.types.ts',
  'noteMirrorIpc.wire.ts',
  'noteMirrorIpc.parse.ts',
  'noteMirrorIpc.mock.ts',
  'noteMirrorIpc.tauri.ts',
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

describe('SD-44 · noteMirrorIpc 行数防回涨', () => {
  it(`noteMirrorIpc.ts 物理行数 ≤ ${MIRROR_IPC_MAX_LINES}（仍 <400）`, () => {
    const filePath = join(DIR, 'noteMirrorIpc.ts');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${MIRROR_IPC_MAX_LINES} 上界；` +
        `请外置到 types / wire / parse / mock / tauri，勿堆回壳`
    ).toBeLessThanOrEqual(MIRROR_IPC_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('barrel 头含 E2 默认关 / E3 纪律 / ≠ EL-03（或源码字符串）', () => {
    const src = readFileSync(join(DIR, 'noteMirrorIpc.ts'), 'utf8');
    expect(src).toMatch(/SD-33/);
    expect(src).toMatch(/主文件[^\n]*<400|目标[^\n]*<400|主文件[^\n]*&lt;400/);
    expect(src).toMatch(/≠\s*EL-03/);
    expect(src).toMatch(/CONN-E2 默认策略|CONN-E2/);
    expect(src).toMatch(/默认关/);
    expect(src).toMatch(/CONN-E3/);
    expect(src).toMatch(/inotify/);
    expect(src).toMatch(
      /≠\s*重做 E2′|≠\s*重做 E2'|E2′\s*\/\s*E3|E2'\s*\/\s*E3/
    );
    expect(src).toMatch(/noteMirrorIpc\.types/);
    expect(src).toMatch(/noteMirrorIpc\.wire/);
    expect(src).toMatch(/noteMirrorIpc\.parse/);
    expect(src).toMatch(/noteMirrorIpc\.mock/);
    expect(src).toMatch(/noteMirrorIpc\.tauri/);
    expect(src).not.toMatch(/EL-03\s*[已关关闭完成]/);
    expect(src).not.toMatch(/inotify[^\n]*已关/);
    expect(src).not.toMatch(/E2\s*默认开/);
  });

  it('五分模存在（types / wire / parse / mock / tauri）', () => {
    for (const name of FIVE_SPLIT) {
      const p = join(DIR, name);
      const src = readFileSync(p, 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 ≠ EL-03`).toMatch(/≠\s*EL-03|EL-03/);
    }
  });

  it('测头自钉 ≠ EL-03 / ≠ inotify 满关 / ≠ 重做 E2′', () => {
    const self = readFileSync(
      join(DIR, 'noteMirrorIpc.line-budget.test.ts'),
      'utf8'
    );
    expect(self).toMatch(/SD-44/);
    expect(self).toMatch(/≠\s*EL-03/);
    expect(self).toMatch(/≠\s*inotify 满关|≠ inotify 满关/);
    expect(self).toMatch(/≠\s*重做 E2′|≠ 重做 E2′/);
    expect(self).toMatch(/≠\s*inotify 产品满关|≠ inotify 产品满关/);
    expect(self).not.toMatch(/EL-03\s*[已关关闭完成]/);
    expect(self).not.toMatch(/抬\s*EL-03/);
  });
});
