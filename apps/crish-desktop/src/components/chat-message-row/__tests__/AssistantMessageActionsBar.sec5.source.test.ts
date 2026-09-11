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

  it('renders regenerate button with exact tooltip and accessible icon', () => {
    expect(src).toMatch(/content="重新生成回复 \(快捷键: R\)"/);
    expect(src).toMatch(/<AppIcon name="refresh" size=\{14\} aria-hidden \/>/);
    expect(src).toMatch(/styles\.regenerateBtn/);
    expect(src).not.toMatch(/\btitle=/);
  });
});
