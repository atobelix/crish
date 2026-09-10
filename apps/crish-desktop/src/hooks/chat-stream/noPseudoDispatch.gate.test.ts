/**
 * check-no-pseudo-dispatch：负向正则 + 仓库应 PASS。
 * 禁止在本文件写死 forbidden stub 全名字面量（会被门禁扫描命中）。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('../../../../../', import.meta.url)));
const SCRIPT = join(REPO, 'scripts', 'check-no-pseudo-dispatch.mjs');

describe('check-no-pseudo-dispatch', () => {
  it('当前仓库扫描应通过', () => {
    const pass = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(pass.status, pass.stderr || pass.stdout || '').toBe(0);
  });

  it('空壳 dispatch*Card 正则能识别坏样本、放过好样本', () => {
    const stubRe =
      /export\s+function\s+(dispatch\w*Card)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*(?:\/\/[^\n]*\s*)*return\s+(?:''|""|null)\s*;?\s*\}/gms;
    const sym = ['dispatch', 'Skill', 'Context', 'Card'].join('');
    const bad = `export function ${sym}(_a: string): string {\n  return '';\n}\n`;
    const good = `export function buildWorkflowAssistantContext(a: string): string {\n  return a;\n}\n`;
    expect(stubRe.test(bad)).toBe(true);
    stubRe.lastIndex = 0;
    expect(stubRe.test(good)).toBe(false);
  });
});
