// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamingBlocks, hash16 } from './useStreamingBlocks';
import { IncrementalBlockSplitter } from '../../api/markdown/IncrementalBlockSplitter';

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

/**
 * D7.1 等价性：增量 appendChunk 路径 vs 全量 split 路径，逐块相等。
 * 冷路径（isStreaming=false）与热路径封口帧均须与 IncrementalBlockSplitter.split 对齐。
 *
 * 语义说明：流式热路径不 flush（保持未闭合围栏等为 draft）；
 * 全量 split 恒 flush。故流式帧比较 sealed 前缀 + draft（trimEnd 后与
 * split 尾块文本对齐）；封口帧（isStreaming=false）后与 split 完全一致。
 */
describe('useStreamingBlocks 增量 vs 全量等价性（D7.1）', () => {
  const CHUNKS = [
    '# 开始\n',
    '# 开始\n\n第一段内容。\n',
    '# 开始\n\n第一段内容。\n\n```ts\n',
    '# 开始\n\n第一段内容。\n\n```ts\nconst x = 1;\n',
    '# 开始\n\n第一段内容。\n\n```ts\nconst x = 1;\n```\n\n',
    '# 开始\n\n第一段内容。\n\n```ts\nconst x = 1;\n```\n\n## 尾部\n',
    '# 开始\n\n第一段内容。\n\n```ts\nconst x = 1;\n```\n\n## 尾部\n\n收尾正文。',
  ];

  it('流式逐帧：已封口块与全量 split 前缀一致；draft 为未 flush 尾部', () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingBlocks(text, true, 'msg-eq'),
      { initialProps: { text: CHUNKS[0]! } }
    );

    for (let i = 0; i < CHUNKS.length; i += 1) {
      const full = CHUNKS[i]!;
      if (i > 0) {
        rerender({ text: full });
      }
      const blocks = result.current.blocks;
      const sealedTexts = blocks.filter((b) => b.isSealed).map((b) => b.text);
      const fullSplit = IncrementalBlockSplitter.split(full);

      // 已封口块必须是全量 split 的严格前缀（逐块相等）
      expect(sealedTexts.length).toBeLessThanOrEqual(fullSplit.length);
      for (let j = 0; j < sealedTexts.length; j += 1) {
        expect(sealedTexts[j]).toBe(fullSplit[j]);
      }

      // 若有 draft：非空 draft 在 trimEnd 后须等于 split 的下一期望块
      const draft = blocks.find((b) => !b.isSealed);
      if (draft) {
        const nextExpected = fullSplit[sealedTexts.length];
        expect(draft.text.trimEnd()).toBe((nextExpected ?? '').trimEnd());
      } else {
        // 无 draft 时 sealed 已覆盖全部 split 块
        expect(sealedTexts).toEqual(fullSplit);
      }
    }
  });

  it('封口帧（isStreaming=false）与全量 split 完全一致且全 sealed', () => {
    const full = CHUNKS[CHUNKS.length - 1]!;
    // 先以流式喂入，再封口
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) =>
        useStreamingBlocks(text, streaming, 'msg-seal'),
      { initialProps: { text: full, streaming: true } }
    );
    rerender({ text: full, streaming: false });

    const sealed = result.current.blocks;
    const fullSplit = IncrementalBlockSplitter.split(full);
    expect(sealed.map((b) => b.text)).toEqual(fullSplit);
    expect(sealed.every((b) => b.isSealed)).toBe(true);
    // 封口 hash 恰一次：key 与 hash16(text) 对齐
    expect(sealed[0]?.key).toBe(`msg-seal-blk-0-${hash16(fullSplit[0]!)}`);
  });

  it('热路径封口后历史块 descriptor 引用稳定（不重算 hash）', () => {
    const frames = CHUNKS;
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamingBlocks(text, true, 'msg-ref'),
      { initialProps: { text: frames[0]! } }
    );

    const sealedSnapshots: string[][] = [];
    for (let i = 0; i < frames.length; i += 1) {
      if (i > 0) rerender({ text: frames[i]! });
      sealedSnapshots.push(
        result.current.blocks.filter((b) => b.isSealed).map((b) => b.key)
      );
    }

    // 最后一帧的已封口 key 序列是前缀：早期封口块 key 不因后续追加而变
    const lastSealed = sealedSnapshots[sealedSnapshots.length - 1]!;
    for (let i = 0; i < lastSealed.length; i += 1) {
      const frameWith = sealedSnapshots.find((s) => s.length > i);
      expect(frameWith?.[i]).toBe(lastSealed[i]);
    }
  });
});
