import { describe, expect, it } from 'vitest';

describe('simple-import-test', () => {
  it('loads', async () => {
    const mod = await import('./orchestrator');
    expect(mod.AgentOrchestrator).toBeDefined();
    expect(mod.isNonDurableRuntimeDelta).toBeDefined();
  }, 30000);
});
