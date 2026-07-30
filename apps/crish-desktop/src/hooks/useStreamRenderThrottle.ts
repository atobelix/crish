import { useEffect, useRef, useState } from 'react';

export interface StreamRenderThrottleResult {
  /** 节流后用于渲染的文本 */
  text: string;
  /** 是否暂停渲染（不在视口） */
  paused: boolean;
}

/**
 * 基于 requestAnimationFrame 的流式渲染节流。
 * - 自动对齐显示器刷新率（60/120/144Hz）
 * - 同一帧内多次更新合并为一次
 * - visible=false 时 paused=true，跳过渲染
 * - isStreaming=false 时立即同步（完成态无延迟）
 */
export function useStreamRenderThrottle(
  streamText: string | undefined,
  isStreaming: boolean,
  visible: boolean
): StreamRenderThrottleResult {
  const [renderText, setRenderText] = useState(streamText || '');
  const rafRef = useRef<number | null>(null);
  const pendingTextRef = useRef<string | undefined>(streamText);

  // 完成态：立即同步
  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setRenderText(streamText || '');
      return;
    }

    // 流式期但不可见：不渲染（保留上次状态）
    if (!visible) {
      return;
    }

    // 流式期且可见：调度 rAF
    pendingTextRef.current = streamText;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setRenderText(pendingTextRef.current || '');
      });
    }
  }, [streamText, isStreaming, visible]);

  // 清理
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  return {
    text: renderText,
    paused: isStreaming && !visible,
  };
}
