import { useCallback, useEffect, useRef, useState } from 'react';

interface UseThumbDragOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  thumbRefY: React.RefObject<HTMLDivElement | null>;
  thumbRefX: React.RefObject<HTMLDivElement | null>;
  maxTravelPxY: number;
  maxTravelPxX: number;
}

export function useThumbDrag({
  viewportRef,
  thumbRefY,
  thumbRefX,
  maxTravelPxY,
  maxTravelPxX,
}: UseThumbDragOptions) {
  const dragStateRefY = useRef<{
    isDragging: boolean;
    startY: number;
    startScrollTop: number;
    maxTravel: number;
    maxScroll: number;
  }>({
    isDragging: false,
    startY: 0,
    startScrollTop: 0,
    maxTravel: 0,
    maxScroll: 0,
  });

  const dragStateRefX = useRef<{
    isDragging: boolean;
    startX: number;
    startScrollLeft: number;
    maxTravel: number;
    maxScroll: number;
  }>({
    isDragging: false,
    startX: 0,
    startScrollLeft: 0,
    maxTravel: 0,
    maxScroll: 0,
  });

  const [isDraggingY, setIsDraggingY] = useState(false);
  const [isDraggingX, setIsDraggingX] = useState(false);

  // W3C Pointer Capture 鼠标抓取拖拽引擎（垂直）
  const handleThumbPointerDownY = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = viewportRef.current;
      if (!el) return;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll <= 0 || maxTravelPxY <= 0) return;

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragStateRefY.current = {
        isDragging: true,
        startY: e.clientY,
        startScrollTop: el.scrollTop,
        maxTravel: maxTravelPxY,
        maxScroll,
      };
      setIsDraggingY(true);
    },
    [maxTravelPxY, viewportRef]
  );

  const handleThumbPointerMoveY = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefY.current.isDragging) return;
      e.preventDefault();
      const { startY, startScrollTop, maxTravel, maxScroll } =
        dragStateRefY.current;
      if (maxTravel > 0 && viewportRef.current) {
        const scrollDelta = ((e.clientY - startY) / maxTravel) * maxScroll;
        const nextScroll = Math.max(
          0,
          Math.min(startScrollTop + scrollDelta, maxScroll)
        );
        viewportRef.current.scrollTop = nextScroll;
        const topPx = maxScroll > 0 ? (nextScroll / maxScroll) * maxTravel : 0;
        if (thumbRefY.current) {
          thumbRefY.current.style.transform = `translate3d(0, ${topPx}px, 0)`;
        }
      }
    },
    [thumbRefY, viewportRef]
  );

  const handleThumbPointerUpY = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefY.current.isDragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStateRefY.current.isDragging = false;
      setIsDraggingY(false);
    },
    []
  );

  // W3C Pointer Capture 鼠标抓取拖拽引擎（水平）
  const handleThumbPointerDownX = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = viewportRef.current;
      if (!el) return;
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      if (maxScroll <= 0 || maxTravelPxX <= 0) return;

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragStateRefX.current = {
        isDragging: true,
        startX: e.clientX,
        startScrollLeft: el.scrollLeft,
        maxTravel: maxTravelPxX,
        maxScroll,
      };
      setIsDraggingX(true);
    },
    [maxTravelPxX, viewportRef]
  );

  const handleThumbPointerMoveX = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefX.current.isDragging) return;
      e.preventDefault();
      const { startX, startScrollLeft, maxTravel, maxScroll } =
        dragStateRefX.current;
      if (maxTravel > 0 && viewportRef.current) {
        const scrollDelta = ((e.clientX - startX) / maxTravel) * maxScroll;
        const nextScroll = Math.max(
          0,
          Math.min(startScrollLeft + scrollDelta, maxScroll)
        );
        viewportRef.current.scrollLeft = nextScroll;
        const leftPx = maxScroll > 0 ? (nextScroll / maxScroll) * maxTravel : 0;
        if (thumbRefX.current) {
          thumbRefX.current.style.transform = `translate3d(${leftPx}px, 0, 0)`;
        }
      }
    },
    [thumbRefX, viewportRef]
  );

  const handleThumbPointerUpX = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefX.current.isDragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStateRefX.current.isDragging = false;
      setIsDraggingX(false);
    },
    []
  );

  const cancelDrag = useCallback(() => {
    dragStateRefY.current.isDragging = false;
    dragStateRefX.current.isDragging = false;
    setIsDraggingY(false);
    setIsDraggingX(false);
  }, []);

  useEffect(() => {
    window.addEventListener('blur', cancelDrag);
    return () => {
      window.removeEventListener('blur', cancelDrag);
    };
  }, [cancelDrag]);

  return {
    isDraggingY,
    isDraggingX,
    cancelDrag,
    handleThumbPointerDownY,
    handleThumbPointerMoveY,
    handleThumbPointerUpY,
    handleThumbPointerDownX,
    handleThumbPointerMoveX,
    handleThumbPointerUpX,
  };
}
