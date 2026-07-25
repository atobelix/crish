import { useRef, useCallback } from 'react';
import { StreamRenderBuffer } from '../api/StreamRenderBuffer';
import { StreamTextBatcher } from '../api/streamTextBatcher';
import { streamRecovery } from '../services/StreamRecovery';

export interface UseStreamingTextCallbacks {
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
}

export interface UseStreamingTextRun {
  pushChunk: (chunk: string) => void;
  pushThinking: (thinking: string) => void;
  dropThinking: () => void;
  flush: () => void;
  stop: () => void;
  currentText: () => string;
  bufferedLength: () => number;
}

export interface UseStreamingTextOptions {
  thinkingBatcherIntervalMs?: number;
  thinkingBatcherMaxChars?: number;
  frameBudgetMs?: number;
  maxBytesPerFrame?: number;
}

export function useStreamingText(options?: UseStreamingTextOptions) {
  const thinkingBatcherRef = useRef<StreamTextBatcher | null>(null);
  const renderBufferRef = useRef<StreamRenderBuffer | null>(null);
  const onTextRef = useRef<((text: string) => void) | null>(null);
  const onThinkingRef = useRef<((thinking: string) => void) | null>(null);

  const frameBudgetRef = useRef(options?.frameBudgetMs);
  frameBudgetRef.current = options?.frameBudgetMs;
  const maxBytesRef = useRef(options?.maxBytesPerFrame);
  maxBytesRef.current = options?.maxBytesPerFrame;

  const thinkInterval = options?.thinkingBatcherIntervalMs ?? 48;
  const thinkMaxChars = options?.thinkingBatcherMaxChars ?? 4000;

  if (!thinkingBatcherRef.current) {
    thinkingBatcherRef.current = new StreamTextBatcher(
      (_key, thinking) => onThinkingRef.current?.(thinking),
      { intervalMs: thinkInterval, maxBufferedChars: thinkMaxChars },
    );
  }

  const startRun = useCallback(
    (callbacks: UseStreamingTextCallbacks, recoverySid?: string) => {
      thinkingBatcherRef.current?.flushNow();

      onTextRef.current = callbacks.onText;
      onThinkingRef.current = callbacks.onThinking ?? null;

      const prevBuf = renderBufferRef.current;
      if (prevBuf) {
        prevBuf.stop();
      }

      const bufferOpts: {
        frameBudgetMs?: number;
        maxBytesPerFrame?: number;
      } = {};
      if (frameBudgetRef.current != null)
        bufferOpts.frameBudgetMs = frameBudgetRef.current;
      if (maxBytesRef.current != null)
        bufferOpts.maxBytesPerFrame = maxBytesRef.current;

      const buffer = new StreamRenderBuffer(bufferOpts);
      renderBufferRef.current = buffer;
      buffer.reset();
      buffer.onFrame = (frame) => {
        onTextRef.current?.(frame.full);
        if (recoverySid) {
          streamRecovery.noteRenderBuffer(
            recoverySid,
            buffer.bufferedLength(),
          );
        }
      };
      buffer.start();

      let runActive = true;

      return {
        pushChunk: (chunk: string) => {
          if (!runActive) return;
          renderBufferRef.current?.push(chunk);
        },
        pushThinking: (thinking: string) => {
          if (!runActive) return;
          thinkingBatcherRef.current?.push('_', thinking);
        },
        dropThinking: () => {
          thinkingBatcherRef.current?.drop('_');
        },
        flush: () => {
          runActive = false;
          const buf = renderBufferRef.current;
          if (buf) {
            buf.markFinal();
            buf.flush(true);
          }
          thinkingBatcherRef.current?.flushNow();
        },
        stop: () => {
          runActive = false;
          renderBufferRef.current?.stop();
        },
        currentText: () =>
          renderBufferRef.current?.currentText() ?? '',
        bufferedLength: () =>
          renderBufferRef.current?.bufferedLength() ?? 0,
      } satisfies UseStreamingTextRun;
    },
    [],
  );

  const dispose = useCallback(() => {
    thinkingBatcherRef.current?.flushNow();
    thinkingBatcherRef.current?.dispose();
    thinkingBatcherRef.current = null;
    renderBufferRef.current?.reset();
    renderBufferRef.current = null;
  }, []);

  return { startRun, dispose };
}
