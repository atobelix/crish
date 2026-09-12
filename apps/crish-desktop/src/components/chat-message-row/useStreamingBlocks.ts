import { useMemo, useRef } from 'react';
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
    virtualClosedText: speculativeCloseBlock(text),
    index,
    isSealed: false,
  };
}

interface IncrementalState {
  messageId: string | null;
  splitter: IncrementalBlockSplitter | null;
  /** 上一帧已消费的全文长度（仅在前缀增长时有效） */
  prevText: string;
  /** 已封口块描述符（按 index 对齐；封口时 hash 恰一次） */
  sealed: ParsedBlockDescriptor[];
}

/**
 * 渐进词法分块与无缝双缓冲协调 Hook
 *
 * 核心机制（D7.1 真增量化）：
 * 1. useRef 持有 IncrementalBlockSplitter 实例；messageId 变更时重建；
 * 2. 流式热路径只 appendChunk(delta)，禁止每帧全量 split；
 * 3. 冷路径（首帧 / 回放 / isStreaming=false / 非前缀重写）允许一次全量；
 * 4. 封口块 hash16 恰一次写入 descriptor，后续帧引用相等短路；
 * 5. 活跃草稿块通过 SpeculativeVirtualCloser 实施纯内存投机虚拟补全。
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
  const stateRef = useRef<IncrementalState>({
    messageId: null,
    splitter: null,
    prevText: '',
    sealed: [],
  });

  const blocksResult = useMemo<StreamingBlocksResult>(() => {
    const st = stateRef.current;

    if (!fullText) {
      st.messageId = messageId;
      st.splitter = null;
      st.prevText = '';
      st.sealed = [];
      return { blocks: [] };
    }

    const isPrefixGrowth =
      st.messageId === messageId &&
      st.splitter != null &&
      fullText.startsWith(st.prevText) &&
      fullText.length >= st.prevText.length;

    // 冷路径：首帧 / messageId 变更 / 非流式重建 / 非前缀重写
    if (!isPrefixGrowth) {
      const splitter = new IncrementalBlockSplitter();
      if (isStreaming) {
        // 流式冷路径：append 后不 flush，保持与热路径一致的 sealed/draft 切分
        splitter.appendChunk(fullText);
        const sealedTexts = splitter.getSealedBlocks();
        const sealed = sealedTexts.map((t, i) =>
          makeSealedDescriptor(t, i, messageId)
        );
        const draft = splitter.getPendingDraft();
        const blocks = [...sealed];
        if (draft.trim().length > 0) {
          blocks.push(makeActiveDescriptor(draft, sealed.length, messageId));
        }
        stateRef.current = {
          messageId,
          splitter,
          prevText: fullText,
          sealed,
        };
        return { blocks };
      }

      // 非流式：一次全量 split（flush 封口全部）
      const rawBlocks = IncrementalBlockSplitter.split(fullText);
      const sealed = rawBlocks.map((t, i) =>
        makeSealedDescriptor(t, i, messageId)
      );
      stateRef.current = {
        messageId,
        splitter: null,
        prevText: fullText,
        sealed,
      };
      return { blocks: sealed };
    }

    // ── 热路径：仅追加 delta ──
    const stSplitter = st.splitter!;
    const delta = fullText.slice(st.prevText.length);
    if (delta.length > 0) {
      stSplitter.appendChunk(delta);
      st.prevText = fullText;
    }

    if (!isStreaming) {
      // 封口帧：flush 草稿尾块并全部封口（hash 恰一次）
      const allTexts = stSplitter.flush();
      const sealed = allTexts.map((t, i) => {
        const prev = st.sealed[i];
        if (prev && prev.isSealed && prev.text === t) {
          return prev;
        }
        return makeSealedDescriptor(t, i, messageId);
      });
      stateRef.current = {
        messageId,
        splitter: null,
        prevText: fullText,
        sealed,
      };
      return { blocks: sealed };
    }

    // 流式帧：已封口块复用 descriptor；仅尾块新建
    const sealedTexts = stSplitter.getSealedBlocks();
    const sealedCount = sealedTexts.length;
    const sealed: ParsedBlockDescriptor[] = new Array(sealedCount);
    let changed = st.sealed.length !== sealedCount;
    for (let i = 0; i < sealedCount; i += 1) {
      const text = sealedTexts[i] ?? '';
      const prev = st.sealed[i];
      if (prev && prev.isSealed && prev.text === text) {
        sealed[i] = prev;
      } else {
        sealed[i] = makeSealedDescriptor(text, i, messageId);
        changed = true;
      }
    }
    if (changed) {
      st.sealed = sealed;
    }

    const draft = stSplitter.getPendingDraft();
    const blocks: ParsedBlockDescriptor[] = changed || delta.length > 0
      ? sealed.slice()
      : sealed.slice();
    if (draft.trim().length > 0) {
      blocks.push(makeActiveDescriptor(draft, sealedCount, messageId));
    }
    return { blocks };
  }, [fullText, isStreaming, messageId]);

  return blocksResult;
}

export { IncrementalBlockSplitter };
