// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamingBlocks, hash16 } from './useStreamingBlocks';

describe('useStreamingBlocks Hook', () => {
  it('returns empty blocks when input is empty', () => {
    const { result } = renderHook(() => useStreamingBlocks('', true, 'msg-1'));
    expect(result.current.blocks).toEqual([]);
  });

  it('generates semantic hash keys for sealed blocks and -active key for tail', () => {
    const text = '# Title\n\nParagraph 1.\n\n```ts\nconst x = 1;';
    const { result } = renderHook(() => useStreamingBlocks(text, true, 'msg-100'));

    const blocks = result.current.blocks;
    expect(blocks.length).toBe(3);

    // Block 0: Sealed Heading
    expect(blocks[0]?.isSealed).toBe(true);
    expect(blocks[0]?.key).toBe(`msg-100-blk-0-${hash16('# Title')}`);

    // Block 1: Sealed Paragraph
    expect(blocks[1]?.isSealed).toBe(true);
    expect(blocks[1]?.key).toBe(`msg-100-blk-1-${hash16('Paragraph 1.')}`);

    // Block 2: Active unsealed Tail (unclosed code fence)
    expect(blocks[2]?.isSealed).toBe(false);
    expect(blocks[2]?.key).toBe('msg-100-blk-2-active');
    // Speculative virtual closer should have closed the fence for rendering
    expect(blocks[2]?.virtualClosedText).toBe('```ts\nconst x = 1;\n```');
    // Original raw text remains untouched
    expect(blocks[2]?.text).toBe('```ts\nconst x = 1;');
  });

  it('marks all blocks as sealed when isStreaming is false', () => {
    const text = '# Title\n\nParagraph 1.\n\nFinal block.';
    const { result } = renderHook(() => useStreamingBlocks(text, false, 'msg-100'));

    const blocks = result.current.blocks;
    expect(blocks.length).toBe(3);
    expect(blocks.every((b) => b.isSealed)).toBe(true);
    expect(blocks[2]?.key).toBe(`msg-100-blk-2-${hash16('Final block.')}`);
  });

  it('reuses sealed block object references across streaming updates (0 re-render guarantee)', () => {
    const { result, rerender } = renderHook(
      ({ text, isStreaming }: { text: string; isStreaming: boolean }) =>
        useStreamingBlocks(text, isStreaming, 'msg-test'),
      {
        initialProps: {
          text: '# Fixed Title\n\nFixed Paragraph.\n\nTyping...',
          isStreaming: true,
        },
      }
    );

    const firstPass = result.current.blocks;

    rerender({
      text: '# Fixed Title\n\nFixed Paragraph.\n\nTyping... more characters',
      isStreaming: true,
    });

    const secondPass = result.current.blocks;

    expect(firstPass.length).toBe(3);
    expect(secondPass.length).toBe(3);

    // Sealed historical blocks MUST have strictly identical object references
    expect(firstPass[0]).toBe(secondPass[0]);
    expect(firstPass[1]).toBe(secondPass[1]);

    // Active tail block reference is fresh
    expect(firstPass[2]).not.toBe(secondPass[2]);
    expect(secondPass[2]?.text).toBe('Typing... more characters');
  });

  it('clears cache when messageId changes', () => {
    const { result, rerender } = renderHook(
      ({ msgId }: { msgId: string }) =>
        useStreamingBlocks('# Same Title\n\nBody', false, msgId),
      {
        initialProps: { msgId: 'msg-1' },
      }
    );

    const firstBlocks = result.current.blocks;

    rerender({ msgId: 'msg-2' });

    const secondBlocks = result.current.blocks;
    expect(firstBlocks[0]).not.toBe(secondBlocks[0]);
    expect(secondBlocks[0]?.key).toContain('msg-2-blk-0-');
  });
});
