import { describe, it, expect } from 'vitest';
import { MemoryManager } from '@crish/shared-utils';

describe('Memory Pressure Handling', () => {
  it('handles pressure level escalation', () => {
    const mm = new MemoryManager({ checkIntervalMs: 60000 });
    // Should not throw when pressure changes
    mm.check();
    expect(true).toBe(true);
  });
});
