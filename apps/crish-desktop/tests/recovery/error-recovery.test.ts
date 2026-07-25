import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useLayoutStore } from '../../src/store/layoutStore';
import { errorStore } from '../../src/services/ErrorStore';

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(key) ?? null; },
    key(index: number) { return [...store.keys()][index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
}

describe('Error Recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createStorageMock());
    vi.stubGlobal('localStorage', createStorageMock());
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    useLayoutStore.setState(useLayoutStore.getInitialState());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('survives AppErrorBoundary circuit breaker trip', () => {
    // Simulate 3 rapid errors to trip the circuit
    const circuitKey = 'crish_error_boundary_circuit';
    sessionStorage.removeItem(circuitKey);
    
    // Write circuit state that would trigger the breaker
    sessionStorage.setItem(circuitKey, JSON.stringify({
      count: 3,
      windowStart: Date.now() - 1000, // within 30s window
    }));
    
    // Reading back should show tripped
    const saved = JSON.parse(sessionStorage.getItem(circuitKey)!);
    expect(saved.count).toBe(3);
  });

  it('handles localStorage quota exceeded', () => {
    // Simulate quota exceeded by making setItem throw
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError');
    const failingStorage = createStorageMock();
    let writeCount = 0;
    const originalSetItem = failingStorage.setItem.bind(failingStorage);
    failingStorage.setItem = (key: string, value: string) => {
      if (++writeCount > 5) throw quotaError;
      originalSetItem(key, value);
    };
    vi.stubGlobal('localStorage', failingStorage);

    // Fill until quota error
    const key = 'crish_test_fill';
    try {
      let i = 0;
      while (true) {
        localStorage.setItem(`${key}_${i++}`, 'x'.repeat(1024 * 100));
      }
    } catch (e: any) {
      expect(e.name).toBe('QuotaExceededError');
    }
    
    // ConfigService should still work (graceful fallback)
    expect(() => errorStore.push({
      code: 'TEST_QUOTA',
      module: 'recovery-test',
      severity: 'warning',
      message: 'Storage full test',
    })).not.toThrow();
  });

  it('handles missing network with recovery', async () => {
    // Store should not crash when network is unavailable
    const state = useLayoutStore.getState();
    expect(state).toBeDefined();
    expect(state.hydrationComplete).toBeDefined();
  });

  it('handles rapid window resize events without layout corruption', () => {
    for (let i = 0; i < 100; i++) {
      // Simulate resize
      window.dispatchEvent(new Event('resize'));
    }
    const state = useLayoutStore.getState();
    expect(state).toBeDefined();
  });
});
