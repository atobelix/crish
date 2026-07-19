import { useEffect } from 'react';

type PreloadTask = () => void;

const QUEUE: PreloadTask[] = [];
let scheduled = false;

function scheduleFlush(): void {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    while (QUEUE.length > 0) {
      const task = QUEUE.shift()!;
      try { task(); } catch {}
    }
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(flush, { timeout: 2000 });
  } else {
    setTimeout(flush, 1000);
  }
}

export function preload(fn: PreloadTask): void {
  QUEUE.push(fn);
  scheduleFlush();
}

export function usePreloader(): void {
  useEffect(() => {
    preload(() => {
      import('../components/DiffCard');
      import('../components/ChatMessageList');
    });
    setTimeout(() => {
      preload(() => {
        import('../components/SettingsPanel');
        import('../api/providerProfiles');
        import('../api/markdownRender');
      });
    }, 3000);
    setTimeout(() => {
      preload(() => {
        const w = new Worker(
          new URL('../workers/markdown.worker.ts', import.meta.url),
          { type: 'module' },
        );
        w.terminate();
      });
    }, 5000);
  }, []);
}
