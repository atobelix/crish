import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { prepare, layout } from '@chenglou/pretext';
import { buildPretextFont } from '../utils/pretextFontBridge';

export interface UseChatAutoScrollResult {
  chatFlowRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  /** 用户点「回到最新」：恢复自动滚底并滚到末尾 */
  scrollToBottom: () => void;
}

export function useChatAutoScroll(
  messages: unknown[],
  isProcessing = false,
): UseChatAutoScrollResult {
  const chatFlowRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Pretext streaming prediction state
  const fontRef = useRef('');
  const prevTextRef = useRef('');
  const prevHeightRef = useRef(0);

  const getFont = useCallback((): string => {
    if (fontRef.current) return fontRef.current;
    try {
      fontRef.current = buildPretextFont('sans', 'normal', 15);
    } catch {
      fontRef.current = '400 15px Inter';
    }
    return fontRef.current;
  }, []);

  // Smart scroll: during AI streaming use Pretext delta; otherwise scrollHeight
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el || userScrolledRef.current) return;

    if (isProcessing) {
      const msgs = messages as Array<{ sender?: string; text?: string }>;
      const asstMsg = [...msgs].reverse().find((m) => m.sender === 'assistant');
      const currentText = asstMsg?.text || '';

      if (currentText && currentText !== prevTextRef.current) {
        const font = getFont();
        if (font) {
          try {
            const containerWidth = el.clientWidth;
            const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
            const pretextHeight = layout(
              prepare(currentText, font),
              containerWidth,
              lineHeight,
            ).height;
            const actualHeight = el.scrollHeight;

            const markdownOverhead = actualHeight - pretextHeight;
            const buffer = markdownOverhead > 0 ? markdownOverhead * 0.15 : 0;
            const estimatedHeight = pretextHeight + markdownOverhead + buffer;

            if (prevHeightRef.current > 0) {
              const dh = estimatedHeight - prevHeightRef.current;
              if (dh > 0) {
                el.scrollTop = Math.min(el.scrollTop + dh, actualHeight);
              }
            }

            prevTextRef.current = currentText;
            prevHeightRef.current = estimatedHeight;
          } catch {
            el.scrollTop = el.scrollHeight;
          }
        }
      }
    } else {
      // Calibration: use real scrollHeight when not streaming
      el.scrollTop = el.scrollHeight;
      prevTextRef.current = '';
      prevHeightRef.current = 0;
    }

    setShowScrollToBottom(false);
  }, [messages, getFont, isProcessing]);

  // Detect user scroll-up to stop auto-scroll
  useEffect(() => {
    const el = chatFlowRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (atBottom) {
        userScrolledRef.current = false;
        setShowScrollToBottom(false);
      } else {
        userScrolledRef.current = true;
        setShowScrollToBottom(true);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    userScrolledRef.current = false;
    setShowScrollToBottom(false);
    if (chatFlowRef.current) {
      chatFlowRef.current.scrollTop = chatFlowRef.current.scrollHeight;
    }
    prevTextRef.current = '';
    prevHeightRef.current = 0;
  }, []);

  return { chatFlowRef, showScrollToBottom, scrollToBottom };
}
