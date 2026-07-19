import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { detectPerformanceTier, initPerformanceAttributes } from './performanceEngine';

describe('Performance Tiering Engine', () => {
  beforeEach(() => {
    // Stub browser Globals
    vi.stubGlobal('navigator', {
      hardwareConcurrency: 8,
      deviceMemory: 8,
    });
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
    }));
    // Stub requestAnimationFrame in a microtask with elapsed increment to satisfy FPS window instantly and avoid timers or stack overflows
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      Promise.resolve().then(() => cb(performance.now() + 160));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('detects high tier on multi-core systems with high refresh rates', async () => {
    const tier = await detectPerformanceTier();
    // Default mock has 8 cores, 8GB RAM, and requestAnimationFrame will resolve standard FPS
    expect(['high', 'balanced', 'eco']).toContain(tier);
  });

  it('drops to eco tier when prefers-reduced-motion is matched', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
    }));

    const tier = await detectPerformanceTier();
    expect(tier).toBe('eco');
  });

  it('defaults and overrides html attributes correctly', () => {
    const attributes: Record<string, string> = {};
    const mockHtmlElement = {
      setAttribute: vi.fn((name, value) => {
        attributes[name] = value;
      }),
      getAttribute: vi.fn((name) => {
        return attributes[name] || null;
      }),
    };

    vi.stubGlobal('document', {
      documentElement: mockHtmlElement,
    });

    initPerformanceAttributes();
    expect(mockHtmlElement.getAttribute('data-perf-tier')).toBe('balanced');
  });
});
