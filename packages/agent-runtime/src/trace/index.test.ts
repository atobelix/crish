import { describe, expect, it } from 'vitest';
import { getTraceContext, withTraceContext } from './index';

describe('trace', () => {
  it('should isolate context between concurrent sessions', async () => {
    const ctx1 = { traceId: 'trace-1', spanId: 'span-1', sourceLayer: 'agent-1' };
    const ctx2 = { traceId: 'trace-2', spanId: 'span-2', sourceLayer: 'agent-2' };

    const task1 = withTraceContext(ctx1, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return getTraceContext();
    });

    const task2 = withTraceContext(ctx2, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getTraceContext();
    });

    const [res1, res2] = await Promise.all([task1, task2]);
    expect(res1?.traceId).toBe('trace-1');
    expect(res2?.traceId).toBe('trace-2');
  });

  it('should not leak trace state via enterWith', () => {
    expect(getTraceContext()).toBeUndefined();
    const ctx = { traceId: 'trace-scoped', spanId: 'span-scoped', sourceLayer: 'test' };

    withTraceContext(ctx, () => {
      expect(getTraceContext()?.traceId).toBe('trace-scoped');
    });

    expect(getTraceContext()).toBeUndefined();
  });
});
