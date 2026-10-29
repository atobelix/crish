/**
 * 流式 Markdown 块派生 Hook。
 *
 * 只使用 MarkdownBlockScanner 做词法切分；封口块按 (index,text) 复用
 * descriptor，活跃尾块单独生成。渲染与结构补全由 Rust 侧负责。
 */
import { useMemo, useRef } from 'react';
import { MarkdownBlockScanner } from '../../api/markdown/markdownBlockScanner';
import { hash16 } from '../../api/markdown/markdownChunker';

export { hash16 };

export interface ParsedBlockDescriptor {
  /** 稳定 key：messageId + index + 文本 hash（封口）/ index-active（活跃） */
  key: string;
  text: string;
  index: number;
  isSealed: boolean;
}

export interface StreamingBlocksResult {
  blocks: ParsedBlockDescriptor[];
}

function makeSealedDescriptor(
  text: string,
  index: number,
  messageId: string
): ParsedBlockDescriptor {
  return {
    key: `${messageId}-blk-${index}-${hash16(text)}`,
    text,
    index,
    isSealed: true,
  };
}

function makeActiveDescriptor(
  text: string,
  index: number,
  messageId: string
): ParsedBlockDescriptor {
  return {
    key: `${messageId}-blk-${index}-active`,
    text,
    index,
    isSealed: false,
  };
}

interface IncrementalState {
  messageId: string | null;
  scanner: MarkdownBlockScanner | null;
  prevText: string;
  sealed: ParsedBlockDescriptor[];
}

export function useStreamingBlocks(
  fullText: string,
  isStreaming: boolean,
  messageId: string
): StreamingBlocksResult {
  const stateRef = useRef<IncrementalState>({
    messageId: null,
    scanner: null,
    prevText: '',
    sealed: [],
  });

  return useMemo<StreamingBlocksResult>(() => {
    const state = stateRef.current;

    if (!fullText) {
      stateRef.current = {
        messageId,
        scanner: null,
        prevText: '',
        sealed: [],
      };
      return { blocks: [] };
    }

    // 非流式（历史消息/回放）：一次全量 split；sealed descriptor 按文本复用。
    if (!isStreaming) {
      const texts = MarkdownBlockScanner.split(fullText);
      const sealed = texts.map((text, index) => {
        const previous = state.sealed[index];
        if (previous && previous.text === text) return previous;
        return makeSealedDescriptor(text, index, messageId);
      });
      stateRef.current = {
        messageId,
        scanner: null,
        prevText: fullText,
        sealed,
      };
      return { blocks: sealed };
    }

    const prefixGrowth =
      state.messageId === messageId &&
      state.scanner !== null &&
      fullText.startsWith(state.prevText) &&
      fullText.length >= state.prevText.length;

    // 冷路径：首帧 / messageId 变更 / 非前缀重写
    if (!prefixGrowth) {
      const scanner = new MarkdownBlockScanner();
      scanner.appendChunk(fullText);
      const sealedTexts = scanner.getSealedBlocks();
      const sealed = sealedTexts.map((text, index) =>
        makeSealedDescriptor(text, index, messageId)
      );
      const draft = scanner.getPendingDraft();
      const blocks = [...sealed];
      if (draft.trim().length > 0) {
        blocks.push(makeActiveDescriptor(draft, sealed.length, messageId));
      }
      stateRef.current = {
        messageId,
        scanner,
        prevText: fullText,
        sealed,
      };
      return { blocks };
    }

    // 热路径：只追加 delta
    const scanner = state.scanner!;
    const delta = fullText.slice(state.prevText.length);
    if (delta.length > 0) scanner.appendChunk(delta);

    const sealedTexts = scanner.getSealedBlocks();
    const sealed = sealedTexts.map((text, index) => {
      const previous = state.sealed[index];
      if (previous && previous.text === text) return previous;
      return makeSealedDescriptor(text, index, messageId);
    });
    const draft = scanner.getPendingDraft();
    const blocks = [...sealed];
    if (draft.trim().length > 0) {
      blocks.push(makeActiveDescriptor(draft, sealed.length, messageId));
    }
    stateRef.current = {
      messageId,
      scanner,
      prevText: fullText,
      sealed,
    };
    return { blocks };
  }, [fullText, isStreaming, messageId]);
}
