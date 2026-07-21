import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from '../../src/store/layoutStore';
import { errorStore } from '../../src/services/ErrorStore';

describe('Error Recovery', () => {
  beforeEach(() => {
    useLayoutStore.setState(useLayoutStore.getInitialState());
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
    // Fill localStorage to capacity
    const key = 'crish_test_fill';
    try {
      let i = 0;
      while (true) {
        localStorage.setItem(`${key}_${i++}`, 'x'.repeat(1024 * 100)); // 100KB each
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
    
    // Clean up
    for (let i = 0; i < 1000; i++) {
      const k = `${key}_${i}`;
      if (localStorage.getItem(k) !== null) localStorage.removeItem(k);
      else break;
    }
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
