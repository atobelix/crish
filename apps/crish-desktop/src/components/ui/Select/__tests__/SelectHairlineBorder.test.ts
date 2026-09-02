// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function getFileContent(filename: string): string {
  const absPath = resolve(process.cwd(), 'src/components/ui/Select', filename);
  return readFileSync(absPath, 'utf8');
}

describe('Select & Combobox: 1px Hairline Border Guardrails (Plan 09)', () => {
  it('SelectTrigger.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('SelectTrigger.module.css');
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+2px/);
  });

  it('Select.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('Select.module.css');
    // 允许浮层下拉阴影 (0 12px 32px ...)，严禁 0 0 0 1.5px 边框阴影
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
  });

  it('Combobox.module.css 中零 1.5px 扩散外阴影', () => {
    const css = getFileContent('Combobox.module.css');
    expect(css).not.toMatch(/box-shadow:\s*0\s+0\s+0\s+1\.5px/);
  });

  it('所有 Select/Combobox 聚焦态 border-color 混入比例严格 <= 10%', () => {
    const files = [
      'SelectTrigger.module.css',
      'Select.module.css',
      'Combobox.module.css',
    ];

    for (const file of files) {
      const css = getFileContent(file);
      const regex = /border(-color)?:\s*color-mix\([^;]*?var\(--text-primary\)\s*(\d+)%/g;
      let match;
      let matchCount = 0;
      while ((match = regex.exec(css)) !== null) {
        matchCount++;
        const pct = parseInt(match[2], 10);
        expect(pct).toBeLessThanOrEqual(10);
      }
      expect(matchCount).toBeGreaterThan(0);
    }
  });
});
