/**
 * §5.1：VirtualPlainCodeViewer 测高可失效重测；禁止永久 isMeasuredRef 锁定
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, './VirtualPlainCodeViewer.tsx');

describe('VirtualPlainCodeViewer §5.1 measure invalidation', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('does not permanently lock measured scalars', () => {
    expect(src).not.toMatch(/isMeasuredRef\.current\s*=\s*true/);
    expect(src).not.toMatch(/if \(isMeasuredRef\.current\) return/);
    expect(src).toMatch(/measureGenRef/);
    expect(src).toMatch(/ResizeObserver/);
    expect(src).toMatch(/uiSize/);
  });

  it('remasures when uiSize / wordWrap change', () => {
    expect(src).toMatch(/\}, \[uiSize, wordWrap\]\);/);
  });
});
