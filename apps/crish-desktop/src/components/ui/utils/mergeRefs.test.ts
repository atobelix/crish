// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mergeRefs } from './mergeRefs';

describe('mergeRefs', () => {
  it('assigns DOM node to object refs and calls function refs', () => {
    const objectRef = { current: null as HTMLDivElement | null };
    const functionRef = vi.fn();
    const element = document.createElement('div');

    const combined = mergeRefs(objectRef, functionRef);
    combined(element);

    expect(objectRef.current).toBe(element);
    expect(functionRef).toHaveBeenCalledWith(element);
  });

  it('handles null / undefined refs safely', () => {
    const objectRef = { current: null as HTMLDivElement | null };
    const element = document.createElement('div');

    const combined = mergeRefs(undefined, objectRef, null);
    expect(() => combined(element)).not.toThrow();
    expect(objectRef.current).toBe(element);
  });

  it('executes cleanup callbacks on unmount according to React 19 Ref Cleanup spec', () => {
    const cleanup = vi.fn();
    const callbackRef = vi.fn(() => cleanup);
    const element = document.createElement('div');

    const combined = mergeRefs(callbackRef);
    const cleanupReturn = combined(element);

    expect(callbackRef).toHaveBeenCalledWith(element);
    expect(cleanup).not.toHaveBeenCalled();

    if (typeof cleanupReturn === 'function') {
      cleanupReturn();
      expect(cleanup).toHaveBeenCalledTimes(1);
    } else {
      expect.fail('Expected cleanup callback to be returned');
    }
  });
});
