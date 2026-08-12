/**
 * SD-25 · NotePaperPanel Skeleton 装配壳行数防回涨
 *
 * 钉：`NotePaperPanel.tsx` 物理行数 **≤ 399**（目标 <400）。
 * hooks / 静默接线 / chrome 装配优先外置同目录旁挂。
 *
 * 诚实边界：
 * - **≠ 任何 EL**；本测只防结构回涨，不关任何 EL
 * - **≠ W5-B Strict**；包锚必须仍 `W5-B-S` / `data-track=skeleton`
 * - **禁止** 去 `-S` 冒充 Strict
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

/** SD-25 主文件上界（完成定义 <400） */
const SKELETON_PANEL_MAX_LINES = 399;

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

describe('SD-25 · NotePaperPanel 行数防回涨 + 包锚', () => {
  it(`NotePaperPanel.tsx 物理行数 ≤ ${SKELETON_PANEL_MAX_LINES}（仍 <400）`, () => {
    const src = readSrc('NotePaperPanel.tsx');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${SKELETON_PANEL_MAX_LINES + 1} 上界；` +
        `请外置到 useNotePaperSkeleton / notePaperSilentFixture / NotePaperPanelChrome，勿堆回壳`
    ).toBeLessThanOrEqual(SKELETON_PANEL_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('模块头保留 SD-25 / 分模指针与诚实边界（≠ EL · ≠ W5-B Strict · 保 -S）', () => {
    const src = readSrc('NotePaperPanel.tsx');
    expect(src).toMatch(/SD-25/);
    expect(src).toMatch(/目标\s*&lt;400|目标\s*<400|&lt;400/);
    expect(src).toMatch(
      /useNotePaperSkeleton|notePaperSilentFixture|NotePaperPanelChrome/
    );
    expect(src).toMatch(/≠\s*W5-B Strict|≠ W5-B Strict/);
    expect(src).toMatch(/≠\s*任何 EL|≠ EL/);
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
  });

  it('包锚仍 W5-B-S / skeleton（禁止去 -S 冒充 Strict）', () => {
    const src = readSrc('NotePaperPanel.tsx');
    expect(src).toMatch(/W5B_SKELETON_PACKAGE_ID/);
    expect(src).toMatch(/W5B_SKELETON_TRACK/);
    expect(src).toMatch(/data-package-id=\{W5B_SKELETON_PACKAGE_ID\}/);
    expect(src).toMatch(/data-track=\{W5B_SKELETON_TRACK\}/);
    expect(src).not.toMatch(/W5B_STRICT_PACKAGE_ID/);
    expect(src).not.toMatch(/data-package-id=["']W5-B["']/);
    expect(src).not.toMatch(/data-track=["']strict["']/);
    expect(readSrc('w5bSkeleton.ts')).toMatch(
      /W5B_SKELETON_PACKAGE_ID\s*=\s*['"]W5-B-S['"]/
    );
  });

  it('未传 transport 不隐式拉真后端（扫 import 行，注释可提产品注入名）', () => {
    const files = [
      'useNotePaperSkeleton.ts',
      'NotePaperPanel.tsx',
      'notePaperSilentFixture.ts',
      'NotePaperPanelChrome.tsx',
    ];
    const forbidden =
      /createDefaultNoteTransport|createTauriNoteTransport|createProductStrictHydrate/;
    const hits: string[] = [];
    for (const name of files) {
      const src = readSrc(name);
      for (const line of src.split(/\r?\n/)) {
        if (!/^\s*import\b/.test(line) && !/\bfrom\s+['"]/.test(line)) {
          continue;
        }
        if (forbidden.test(line)) hits.push(`${name}: ${line.trim()}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
    const hookSrc = readSrc('useNotePaperSkeleton.ts');
    expect(hookSrc).toMatch(/transport !== undefined/);
    expect(hookSrc).toMatch(/不隐式拉真后端/);
  });

  it('分模文件存在（防半拆）且钉 SD-25 / -S / ≠ EL', () => {
    const required = [
      'useNotePaperSkeleton.ts',
      'notePaperSilentFixture.ts',
      'NotePaperPanelChrome.tsx',
    ];
    for (const name of required) {
      const src = readSrc(name);
      expect(src.length, `${name} 不应为空`).toBeGreaterThan(40);
      expect(src, `${name} 须钉 SD-25`).toMatch(/SD-25/);
      expect(src, `${name} 须钉 W5-B-S / -S`).toMatch(/W5-B-S|-S/);
      expect(src, `${name} 须钉 ≠ EL`).toMatch(/≠\s*任何 EL|≠\s*EL|EL-01/);
    }
  });
});
