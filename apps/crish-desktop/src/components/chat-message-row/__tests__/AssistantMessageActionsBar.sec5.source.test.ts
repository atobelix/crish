/**
 * F5-1：无真实 onRegenerate 不渲染重新生成（对齐 onRetract）
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../AssistantMessageActionsBar.tsx');

describe('AssistantMessageActionsBar §5 / F5-1 source contracts', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('onRegenerate is optional', () => {
    expect(src).toMatch(/onRegenerate\?:\s*\(\)\s*=>\s*void/);
  });

  it('gates regenerate button on real callback like onRetract', () => {
    expect(src).toMatch(/isLastAssistant && onRegenerate/);
    expect(src).toMatch(/onRetract \? <RetractActionButton/);
  });
});
