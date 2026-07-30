import { describe, it, expect } from 'vitest';
import { PricingEngine } from './pricing-engine';
import { TokenLedger, type TokenLedgerEntry } from './token-ledger';

function makeEngine(): PricingEngine {
  const eng = new PricingEngine();
  eng.registerPricing({
    modelId: 'gpt-4o',
    provider: 'openai',
    inputCostPer1KTokens: 0.003,
    outputCostPer1KTokens: 0.015,
    cacheReadCostPer1KTokens: 0.0003,
    cacheCreationCostPer1KTokens: 0.00375,
    reasoningCostPer1KTokens: 0.06,
    currency: 'USD',
  });
  eng.registerPricing({
    modelId: 'claude-sonnet-4',
    provider: 'anthropic',
    inputCostPer1KTokens: 0.003,
    outputCostPer1KTokens: 0.015,
    cacheReadCostPer1KTokens: 0.0003,
    cacheCreationCostPer1KTokens: 0.00375,
    reasoningCostPer1KTokens: 0.06,
    currency: 'USD',
  });
  eng.registerPricing({
    modelId: 'm',
    provider: 'p',
    inputCostPer1KTokens: 0.001,
    outputCostPer1KTokens: 0.002,
    currency: 'USD',
  });
  return eng;
}

function entry(overrides?: Partial<TokenLedgerEntry>): TokenLedgerEntry {
  return {
    turnIndex: 0,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    model: 'gpt-4o',
    provider: 'openai',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('TokenLedger', () => {
  it('records and retrieves entries', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordFinal(entry({ turnIndex: 1 }));
    expect(ledger.getAllEntries()).toHaveLength(1);
  });

  it('accumulates partial updates before recordFinal', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordPartial({ inputTokens: 500 });
    ledger.recordPartial({ outputTokens: 300 });
    ledger.recordFinal(
      entry({ turnIndex: 0, inputTokens: 500, outputTokens: 300, costUsd: 0 })
    );
    expect(ledger.getAllEntries()).toHaveLength(1);
  });

  it('calculates total cost correctly', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordFinal(
      entry({
        turnIndex: 0,
        inputTokens: 1000,
        outputTokens: 500,
        timestamp: 1,
      })
    );
    ledger.recordFinal(
      entry({
        turnIndex: 1,
        inputTokens: 2000,
        outputTokens: 1000,
        timestamp: 2,
      })
    );
    const t1 = (1000 / 1000) * 0.003 + (500 / 1000) * 0.015;
    const t2 = (2000 / 1000) * 0.003 + (1000 / 1000) * 0.015;
    expect(ledger.getTotalCost()).toBeCloseTo(t1 + t2, 8);
  });

  it('returns cache hit ratio', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordFinal(
      entry({
        model: 'm',
        provider: 'p',
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        timestamp: 1,
      })
    );
    expect(ledger.getCacheHitRatio()).toBeCloseTo(0.8);
  });

  it('returns 0 cache hit ratio when no cache entries', () => {
    const ledger = new TokenLedger(makeEngine());
    expect(ledger.getCacheHitRatio()).toBe(0);
  });

  it('returns largest turns by total tokens', () => {
    const ledger = new TokenLedger(makeEngine());
    for (let i = 0; i < 5; i++) {
      ledger.recordFinal(
        entry({
          turnIndex: i,
          inputTokens: (i + 1) * 100,
          outputTokens: (i + 1) * 50,
          model: 'm',
          provider: 'p',
          timestamp: i,
        })
      );
    }
    const largest = ledger.getLargestTurns(2);
    expect(largest).toHaveLength(2);
    expect(largest[0]!.turnIndex).toBe(4);
    expect(largest[1]!.turnIndex).toBe(3);
  });

  it('aggregates usage by tool', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordFinal(
      entry({
        turnIndex: 0,
        inputTokens: 1000,
        outputTokens: 500,
        model: 'm',
        provider: 'p',
        timestamp: 1,
        costUsd: 0.01,
        toolExecutions: [
          {
            toolName: 'bash',
            callId: 'c1',
            startedAt: 1,
            endedAt: 100,
            durationMs: 99,
            success: true,
            outputSize: 50,
            inputTokenEstimate: 20,
            outputTokenEstimate: 10,
          },
          {
            toolName: 'read',
            callId: 'c2',
            startedAt: 1,
            endedAt: 50,
            durationMs: 49,
            success: true,
            outputSize: 30,
            inputTokenEstimate: 10,
            outputTokenEstimate: 5,
          },
        ],
      })
    );
    const bashUsage = ledger.getUsageByTool('bash');
    expect(bashUsage.calls).toBe(1);
    expect(bashUsage.avgDurationMs).toBe(99);
    expect(bashUsage.totalCost).toBeGreaterThan(0);
  });

  it('clears all state', () => {
    const ledger = new TokenLedger(makeEngine());
    ledger.recordFinal(entry({ model: 'm', provider: 'p', timestamp: 1 }));
    ledger.clear();
    expect(ledger.getAllEntries()).toHaveLength(0);
  });
});
