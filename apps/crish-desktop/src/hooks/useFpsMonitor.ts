import { useEffect, useRef } from 'react';

export function useFpsMonitor(enabled = process.env.NODE_ENV === 'development'): void {
  const framesRef = useRef(0);
  const lastTimeRef = useRef(performance.now());

  useEffect(() => {
    if (!enabled) return;

    let rafId: number;
    const tick = () => {
      framesRef.current++;
      const now = performance.now();
      const elapsed = now - lastTimeRef.current;

      if (elapsed >= 1000) {
        const fps = Math.round((framesRef.current * 1000) / elapsed);
        if (fps < 30) {
          console.warn(`[Perf] Low FPS: ${fps}`);
        }
        framesRef.current = 0;
        lastTimeRef.current = now;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [enabled]);
}
