import { describe, expect, it, vi } from 'vitest';
import { surfaceStreamFailure } from './BridgeErrorPolicy';
import type { StreamCallbacks } from '../chatApi';

describe('BridgeErrorPolicy', () => {
  it('surfaces stream failures to onRunError callback', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure('Network request failed', 'network', callbacks, 'run-1');

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(typeof msg).toBe('string');
    expect(kind).toBeDefined();
  });

  it('handles checkpoint scope error formatting', () => {
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };

    surfaceStreamFailure('checkpoint restore failed', 'checkpoint', callbacks, 'run-2');

    expect(onRunError).toHaveBeenCalledTimes(1);
  });
});
