export type PerfTier = 'high' | 'balanced' | 'eco';

export async function detectPerformanceTier(): Promise<PerfTier> {
  if (typeof window === 'undefined') return 'balanced';

  const isReducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;
  if (isReducedMotion) {
    return 'eco';
  }

  const cores = navigator.hardwareConcurrency || 4;
  const memoryGigs =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 4;

  // Measure refresh rate over a short window
  const fps = await measureMaxFps();

  // eco：真正低端（≤2 核 / ≤2GB / FPS 不稳定 < 30）
  // 4GB 主流机应落在 balanced，不再被误判 eco
  if (cores <= 2 || memoryGigs <= 2 || fps < 30) {
    return 'eco';
  }
  // high：8核+ 且 8GB+ 且高刷新
  if (cores >= 8 && memoryGigs >= 8 && fps >= 75) {
    return 'high';
  }
  // balanced：覆盖 4–8GB / 4–8 核主流办公机
  return 'balanced';
}

function measureMaxFps(): Promise<number> {
  if (typeof requestAnimationFrame === 'undefined') {
    return Promise.resolve(60);
  }

  return new Promise((resolve) => {
    let frameCount = 0;
    const start = performance.now();

    function check(now: number) {
      frameCount++;
      const elapsed = now - start;
      if (elapsed >= 150) {
        // 150ms sampling window is enough and faster
        resolve(Math.round((frameCount * 1000) / elapsed));
      } else {
        requestAnimationFrame(check);
      }
    }
    requestAnimationFrame(check);
  });
}

/**
 * Bootstraps the HTML attributes synchronously to prevent flash of un-optimized styles
 */
export function initPerformanceAttributes() {
  if (typeof window === 'undefined') return;
  const html = document.documentElement;

  // Set default to balanced before async checks complete
  html.setAttribute('data-perf-tier', 'balanced');

  detectPerformanceTier().then((tier) => {
    html.setAttribute('data-perf-tier', tier);
    console.log(
      `[conex] System booted in [${tier.toUpperCase()}] performance tier.`
    );
  });
}
