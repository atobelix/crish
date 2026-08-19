/**
 * 可选叙事注入：ChatMessageList 提供槽，缺省不进 Virtualizer memo。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

describe('ChatMessageList 叙事注入槽', () => {
  it('props 含可选 renderTools / renderThought', () => {
    const src = readFileSync(join(DIR, 'chatMessageListProps.ts'), 'utf8');
    expect(src).toMatch(/renderTools\?:/);
    expect(src).toMatch(/renderThought\?:/);
  });

  it('列表用 Context 注入，不把槽写进 MessageVirtualizer props', () => {
    const list = readFileSync(join(DIR, 'ChatMessageList.tsx'), 'utf8');
    const memo = readFileSync(join(DIR, 'messageVirtualizerMemo.ts'), 'utf8');
    expect(list).toMatch(/NarrativeRenderSlotsContext\.Provider/);
    expect(memo).not.toMatch(/renderTools/);
    expect(memo).not.toMatch(/renderThought/);
  });
});
