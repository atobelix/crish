import type { PricingEngine } from './pricing-engine';

export interface TokenLedgerEntry {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  model: string;
  provider: string;
  timestamp: number;
  toolExecutions?: Array<{
    toolName: string;
    callId: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    success: boolean;
    outputSize: number;
    inputTokenEstimate: number;
    outputTokenEstimate: number;
  }>;
}

export class TokenLedger {
  private entries: TokenLedgerEntry[] = [];
  private currentPartial: Partial<TokenLedgerEntry> | null = null;
  private pricingEngine: PricingEngine;

  constructor(pricingEngine: PricingEngine) {
    this.pricingEngine = pricingEngine;
  }

  recordPartial(update: Partial<TokenLedgerEntry>): void {
    if (!this.currentPartial) {
      this.currentPartial = { ...update };
    } else {
      Object.assign(this.currentPartial, update);
    }
  }

  recordFinal(update: TokenLedgerEntry): void {
    const merged = this.currentPartial
      ? { ...this.currentPartial, ...update }
      : { ...update };

    if (merged.costUsd === undefined || merged.costUsd === 0) {
      const cost = this.pricingEngine.calculateCost(merged.model, {
        inputTokens: merged.inputTokens,
        outputTokens: merged.outputTokens,
        cacheReadTokens: merged.cacheReadTokens,
        cacheCreationTokens: merged.cacheWriteTokens,
        reasoningTokens: merged.reasoningTokens,
      });
      merged.costUsd = cost.totalCost;
    }

    this.entries.push(merged as TokenLedgerEntry);
    this.currentPartial = null;
  }

  getTotalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0);
  }

  getCacheHitRatio(): number {
    let totalRead = 0;
    let totalWrite = 0;
    for (const e of this.entries) {
      totalRead += e.cacheReadTokens;
      totalWrite += e.cacheWriteTokens;
    }
    const total = totalRead + totalWrite;
    return total === 0 ? 0 : totalRead / total;
  }

  getLargestTurns(n: number): TokenLedgerEntry[] {
    return [...this.entries]
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
      .slice(0, n);
  }

  getUsageByTool(
    toolName: string,
  ): { calls: number; totalCost: number; avgDurationMs: number } {
    let calls = 0;
    let totalDurationMs = 0;
    let toolCostSum = 0;

    for (const entry of this.entries) {
      const execs = entry.toolExecutions;
      if (!execs) continue;
      for (const te of execs) {
        if (te.toolName !== toolName) continue;
        calls++;
        totalDurationMs += te.durationMs;
        const entryTotalTokens = entry.inputTokens + entry.outputTokens;
        const teTokens = te.inputTokenEstimate + te.outputTokenEstimate;
        if (teTokens > 0 && entryTotalTokens > 0) {
          toolCostSum += entry.costUsd * (teTokens / entryTotalTokens);
        }
      }
    }

    return {
      calls,
      totalCost: toolCostSum,
      avgDurationMs: calls > 0 ? totalDurationMs / calls : 0,
    };
  }

  getAllEntries(): TokenLedgerEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.currentPartial = null;
  }
}
