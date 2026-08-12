/**
 * SD-13 · SlashMenuOverlay 装配壳行数防回涨
 *
 * 钉：`SlashMenuOverlay.tsx` 物理行数 **≤ 220**（薄装配壳）。
 * 选中 / 键盘 / catalog / 写模式解析优先外置同目录 `SlashMenuOverlay*` / `useSlashMenu*`。
 *
 * 诚实边界：
 * - **≠ EL-01**；本测只防结构回涨，不关任何 EL
 * - 不改 productSlashSink / EmptyState 语义；不回退 CONN-B 测
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

/** SD-13 装配壳上界（显著低于 400 黄边） */
const OVERLAY_MAX_LINES = 220;

function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-13 · SlashMenuOverlay 行数防回涨', () => {
  it(`SlashMenuOverlay.tsx 物理行数 ≤ ${OVERLAY_MAX_LINES}`, () => {
    const filePath = join(DIR, 'SlashMenuOverlay.tsx');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${OVERLAY_MAX_LINES} 上界；` +
        `请外置到 useSlashMenu* / SlashMenuOverlayCatalog / writeMode，勿堆回壳`
    ).toBeLessThanOrEqual(OVERLAY_MAX_LINES);
  });

  it('模块头保留 SD-13 / 分模指针与诚实边界（≠ EL-01）', () => {
    const src = readFileSync(join(DIR, 'SlashMenuOverlay.tsx'), 'utf8');
    expect(src).toMatch(/SD-13/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/useSlashMenuSelect|SlashMenuOverlayCatalog/);
    // 禁止假关：不得把本壳标成 EL-01 已关闭
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
  });

  it('分模文件存在（防半拆）', () => {
    const required = [
      'SlashMenuOverlay.types.ts',
      'slashMenuOverlayWriteMode.ts',
      'useSlashMenuSelect.ts',
      'useSlashMenuKeymap.ts',
      'useSlashMenuModelSync.ts',
      'SlashMenuOverlayCatalog.tsx',
    ];
    for (const name of required) {
      const p = join(DIR, name);
      const src = readFileSync(p, 'utf8');
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 ≠ EL-01`).toMatch(/≠\s*EL-01|EL-01/);
    }
  });
});
