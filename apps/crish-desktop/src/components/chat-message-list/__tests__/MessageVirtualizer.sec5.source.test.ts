/**
 * §5.1 / §5.2 MessageVirtualizer：字号失效清高；审批/重试无空实现伪装
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../MessageVirtualizer.tsx');

describe('MessageVirtualizer §5 source contracts', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('clears heights on uiSize change', () => {
    expect(src).toMatch(/uiSize/);
    expect(src).toMatch(/clearHeights\(\)/);
    expect(src).toMatch(/\[uiSize, clearHeights\]/);
  });

  it('does not fake approval with empty noops in fallback tool stack', () => {
    expect(src).not.toMatch(/onApprovalAllow:\s*\(\)\s*=>\s*\{\}/);
    expect(src).not.toMatch(/onApprovalDeny:\s*\(\)\s*=>\s*\{\}/);
  });

  it('physically retires EphemeralStatusSlot from MessageVirtualizer', () => {
    expect(src).not.toMatch(/EphemeralStatusSlot/);
  });

  it('does not fake row regenerate with empty noop fallback', () => {
    expect(src).not.toMatch(/handleRegenerateRow\s*\?\?\s*\(\(\s*\)\s*=>\s*\{\s*\}\)/);
    expect(src).toMatch(/const handleRegenerateRow = generation\?\.handleRegenerateRow;/);
  });
});
