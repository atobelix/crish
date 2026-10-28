import { useCallback, useEffect, useRef, useState } from 'react';

interface UseFontKeyboardNavProps {
  filteredCount: number;
  onSelectCurrent: (index: number) => void;
  onApplyCustom: () => void;
  onClose: () => void;
}

export function useFontKeyboardNav({
  filteredCount,
  onSelectCurrent,
  onApplyCustom,
  onClose,
}: UseFontKeyboardNavProps) {
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const isComposingRef = useRef(false);
  const compositionEndStampRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 选项数量变动时自适应重置高亮焦点
  useEffect(() => {
    setFocusedIndex(filteredCount > 0 ? 0 : -1);
  }, [filteredCount]);

  // 高亮项变更时自动滚动至视口内
  useEffect(() => {
    if (focusedIndex < 0 || !scrollContainerRef.current) return;
    const activeEl = scrollContainerRef.current.querySelector(
      `[data-opt-index="${focusedIndex}"]`
    );
    if (
      activeEl &&
      typeof (activeEl as HTMLElement).scrollIntoView === 'function'
    ) {
      (activeEl as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIndex]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    compositionEndStampRef.current = Date.now();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const isImeKey =
        isComposingRef.current ||
        (e.nativeEvent as unknown as { isComposing?: boolean })?.isComposing ||
        e.keyCode === 229 ||
        Date.now() - compositionEndStampRef.current < 160;

      if (isImeKey) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
        }
        return; // 放行 IME 处理候选框方向键与取消键，避免劫持拼音输入
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCount > 0) {
          setFocusedIndex((prev) => (prev + 1) % filteredCount);
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCount > 0) {
          setFocusedIndex((prev) => (prev - 1 + filteredCount) % filteredCount);
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (filteredCount > 0) {
          const safeIdx =
            focusedIndex >= 0 && focusedIndex < filteredCount
              ? focusedIndex
              : 0;
          onSelectCurrent(safeIdx);
        } else {
          onApplyCustom();
        }
      }
    },
    [filteredCount, focusedIndex, onApplyCustom, onClose, onSelectCurrent]
  );

  return {
    focusedIndex,
    setFocusedIndex,
    scrollContainerRef,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
  };
}
