/**
 * SD-04-R-G · Strict 装配壳行数防回涨门
 *
 * 钉：`NotePaperStrictPanel.tsx` 物理行数 **< 400**（≤399）。
 * 新 prop / 钩子优先外置（`notePaperStrictProps` / Header / Body / ChromeSlot 等），
 * 禁止把装配逻辑堆回本壳。
 *
 * 诚实边界：
 * - **≠ EL-01**；本测只防结构回涨，不关任何 EL
 * - 不改 presentationMode 默认 / 互斥条件渲染语义
 * - 行数口径：物理全量行（含注释与空行），与编辑器 / `Get-Content` 计数一致
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** vitest 下 import.meta.url 偶发非 file: 时回退 cwd 相对路径 */
const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'src/components/note-paper');

/** SD-04-R 上界：仍 &lt;400（允许最大值 399） */
const STRICT_PANEL_MAX_LINES = 399;

/**
 * 物理行数：按 `\n` 拆分；文件以换行结尾时去掉 split 产生的尾空串，
 * 与常见编辑器 / PowerShell `(Get-Content).Count` 对齐。
 */
function physicalLineCount(src: string): number {
  if (src.length === 0) return 0;
  const normalized = src.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

describe('SD-04-R-G · NotePaperStrictPanel 行数防回涨', () => {
  it(`NotePaperStrictPanel.tsx 物理行数 ≤ ${STRICT_PANEL_MAX_LINES}（仍 <400）`, () => {
    const filePath = join(DIR, 'NotePaperStrictPanel.tsx');
    const src = readFileSync(filePath, 'utf8');
    const lineCount = physicalLineCount(src);

    expect(
      lineCount,
      `装配壳 ${lineCount} 行已达/超 ${STRICT_PANEL_MAX_LINES + 1} 上界；` +
        `请外置 prop/钩子到 notePaperStrictProps 或同目录子模块，勿堆回壳`
    ).toBeLessThanOrEqual(STRICT_PANEL_MAX_LINES);

    expect(lineCount).toBeLessThan(400);
  });

  it('模块头保留 SD-04-R / &lt;400 目标与诚实边界（≠ EL-01）', () => {
    const src = readFileSync(join(DIR, 'NotePaperStrictPanel.tsx'), 'utf8');
    // 头部契约锚：防有人删目标注释或假关 EL
    expect(src).toMatch(/目标\s*&lt;400|目标\s*<400|&lt;400/);
    expect(src).toMatch(/≠\s*EL-01|EL-01/);
    expect(src).toMatch(/SD-04-R/);
    // 禁止假关：不得把本壳标成 EL-01 已关闭
    expect(src).not.toMatch(/EL-01\s*[已关关闭完成]/);
  });

  it('产品 Strict 面板源码不再挂 ConexFloatHandle', () => {
    const src = readFileSync(join(DIR, 'NotePaperStrictPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/ConexFloatHandle/);
  });
});
