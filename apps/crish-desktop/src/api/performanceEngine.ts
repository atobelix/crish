export type PerfTier = 'high' | 'balanced' | 'eco';

export async function detectPerformanceTier(): Promise<PerfTier> {
  if (typeof window === 'undefined') return 'balanced';
  
  const isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (isReducedMotion) {
    return 'eco';
  }

  const cores = navigator.hardwareConcurrency || 4;
  const memoryGigs = (navigator as any).deviceMemory || 4;

  // Measure refresh rate over a short window
  const fps = await measureMaxFps();

  // Eco Tiers: Single-board computers, virtual machines, or battery-saving systems
  if (cores < 4 || memoryGigs < 4 || fps < 45) {
    return 'eco';
  }

  // High Tiers: High-refresh monitors or multi-core modern systems
  if (cores >= 8 && fps >= 75) {
    return 'high';
  }

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
      if (elapsed >= 150) { // 150ms sampling window is enough and faster
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
    console.log(`[conex] System booted in [${tier.toUpperCase()}] performance tier.`);
  });
}
