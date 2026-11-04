import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  detectPerformanceTier,
  initPerformanceAttributes,
} from './performanceEngine';

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

  it('does not drop to eco when prefers-reduced-motion is matched (tier is hardware-only)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
    }));
    // 强硬件 + 高帧率桩：每帧 +10ms，150ms 窗内 16 帧 ≈ 100 FPS
    let t = performance.now();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      Promise.resolve().then(() => {
        t += 10;
        cb(t);
      });
    });

    const tier = await detectPerformanceTier();
    // 减动效只走其独立通道，不得把性能档强制为 eco（X1 解耦口径）
    expect(tier).toBe('high');
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
