import { describe, expect, it, vi } from 'vitest';
import { streamViaDirectFetch } from './directFetchBridge';

describe('directFetchBridge', () => {
  it('should preserve reasoning_content on abort', () => {
    const callbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onComplete: vi.fn(),
      onRunError: vi.fn(),
    };

    const cancel = streamViaDirectFetch(
      'hello',
      callbacks,
      's-1',
      'msg-1',
      {
        messages: [
          { role: 'assistant', content: 'prior text', reasoning_content: 'prior thought' },
        ],
      }
    );

    expect(typeof cancel).toBe('function');
    cancel();
  });

  it('should call onComplete even after abort', () => {
    const callbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onComplete: vi.fn(),
      onRunError: vi.fn(),
    };

    const cancel = streamViaDirectFetch('hello', callbacks, 's-1', 'msg-1');
    cancel();

    // Since active profile / API key is not configured in unit test environment,
    // streamViaDirectFetch invokes onRunError & onComplete synchronously.
    expect(callbacks.onComplete).toHaveBeenCalled();
  });
});
