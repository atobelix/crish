import { useLayoutEffect, useMemo, useRef } from 'react';
import { IncrementalBlockSplitter } from '../../api/markdown/IncrementalBlockSplitter';
import { speculativeCloseBlock } from '../../api/markdown/SpeculativeVirtualCloser';

export interface ParsedBlockDescriptor {
  /** 块的唯一稳定标识 */
  key: string;
  /** 块的原始 Markdown 内容 */
  text: string;
  /** 纯内存投机虚拟补全后的渲染内容（用于活跃草稿尾块） */
  virtualClosedText?: string;
  /** 块在文档中的索引位置 */
  index: number;
  /** 该块是否已被封口（后续流式不会再修改该块文本） */
  isSealed: boolean;
}

export interface StreamingBlocksResult {
  blocks: ParsedBlockDescriptor[];
}

/**
 * 快速生成 16 位十六进制语义哈希
 */
export function hash16(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch << 5), 0x5bd1e995);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${p1}${p2}`;
}

/**
 * 渐进词法分块与无缝双缓冲协调 Hook
 *
 * 核心机制：
 * 1. 使用 IncrementalBlockSplitter 将累积 Markdown 增量切分为独立语法块；
 * 2. 语义哈希稳定 Key 策略：
 *    - 封口块：`${msgId}-blk-${index}-${hash16}`
 *    - 活跃草稿块：`${msgId}-blk-${tailIndex}-active`
 * 3. 活跃草稿块通过 SpeculativeVirtualCloser 实施纯内存投机虚拟补全；
 * 4. sealedCacheRef 维持已封口块的对象引用稳定，确保 React.memo 协调阶段 100% 拦截重渲染；
 * 5. useMemo 为纯计算派生，已提交状态通过 useLayoutEffect 同步，完全符合 React 19 规范。
 *
 * @param fullText 累积的流式 Markdown 文本
 * @param isStreaming 是否处于流式传输中
 * @param messageId 消息唯一标识，用于生成稳定 key 作用域
 */
export function useStreamingBlocks(
  fullText: string,
  isStreaming: boolean,
  messageId: string
): StreamingBlocksResult {
  const sealedCacheRef = useRef<ParsedBlockDescriptor[]>([]);
  const prevMessageIdRef = useRef<string>(messageId);

  const blocksResult = useMemo<StreamingBlocksResult>(() => {
    if (!fullText) {
      return { blocks: [] };
    }

    const rawBlocks = IncrementalBlockSplitter.split(fullText);
    const totalBlocks = rawBlocks.length;

    if (totalBlocks === 0) {
      return { blocks: [] };
    }

    const result: ParsedBlockDescriptor[] = [];
    const isSameMessage = prevMessageIdRef.current === messageId;
    const cachedSealed = isSameMessage ? sealedCacheRef.current : [];

    for (let i = 0; i < totalBlocks; i += 1) {
      const blockText = rawBlocks[i] ?? '';
      const isLastBlock = i === totalBlocks - 1;
      const isSealed = !isStreaming || !isLastBlock;

      if (isSealed) {
        const blockHash = hash16(blockText);
        const key = `${messageId}-blk-${i}-${blockHash}`;
        const cached = cachedSealed[i];

        if (
          cached &&
          cached.isSealed &&
          cached.key === key &&
          cached.text === blockText
        ) {
          // 复用上一次已封口块的对象引用（保证 React.memo 0 重绘）
          result.push(cached);
        } else {
          const desc: ParsedBlockDescriptor = {
            key,
            text: blockText,
            index: i,
            isSealed: true,
          };
          result.push(desc);
        }
      } else {
        // 活跃尾块草稿：进行纯内存投机虚拟补全
        const key = `${messageId}-blk-${i}-active`;
        const virtualClosed = speculativeCloseBlock(blockText);
        const desc: ParsedBlockDescriptor = {
          key,
          text: blockText,
          virtualClosedText: virtualClosed,
          index: i,
          isSealed: false,
        };
        result.push(desc);
      }
    }

    return { blocks: result };
  }, [fullText, isStreaming, messageId]);

  useLayoutEffect(() => {
    if (prevMessageIdRef.current !== messageId) {
      prevMessageIdRef.current = messageId;
      sealedCacheRef.current = [];
    }

    const currentBlocks = blocksResult.blocks;
    if (!fullText || currentBlocks.length === 0) {
      sealedCacheRef.current = [];
      return;
    }

    // 更新已封口块的缓存切片
    sealedCacheRef.current = isStreaming
      ? currentBlocks.slice(0, Math.max(0, currentBlocks.length - 1))
      : currentBlocks;
  }, [fullText, isStreaming, messageId, blocksResult.blocks]);

  return blocksResult;
}

export { IncrementalBlockSplitter };
