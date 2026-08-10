// =======================================================================
// mock daemon v0（R0-06）——缓存指标事件场景（可循环）
//
// 覆盖：缓存测量域（events.rs CacheStatsUpdated/CacheWasteAlert/
// ColdCacheWarning 三事件）在移动端观测面的展示路径——
//   冷缓存预警（run 启动）→ 消息流 → 工具执行 → 缓存浪费告警 →
//   run 收口 + cache-stats-updated（收口轨一次发射）。
// 字段取值对齐引擎阈值语义：waste 命中阈值 missed_tokens ≥ 20000 或
// missed_cost ≥ 0.1 才发射（events.rs:530-531 注释口径）。
// =======================================================================

import type { ScenarioDefinition } from './index.js';
import { agentStart, turnStart, coldCacheWarning, messageDeltaText, toolStart, toolUpdate, toolEnd, messageEnd, cacheWasteAlert, turnEnd, runTerminal, cacheStatsUpdated, agentEnd } from './events.js';

export const cacheScenario: ScenarioDefinition = {
  id: 'cache',
  description: '缓存指标事件：冷缓存预警 → 缓存浪费告警 → cache-stats-updated（可循环）',
  sessionId: 's-mock-cache',
  runId: 'r-mock-cache-1',
  loopable: true,
  interactive: false,
  async run(ctx): Promise<void> {
    const sessionId = 's-mock-cache';
    const runId = 'r-mock-cache-1';
    const messageId = 'msg-mock-cache-1';

    await ctx.emit(sessionId, agentStart(sessionId, runId));
    await ctx.sleep(60);
    await ctx.emit(sessionId, turnStart(sessionId, runId, 0));
    await ctx.sleep(80);
    await ctx.emit(sessionId, coldCacheWarning(sessionId, runId, 86400, 1_200_000, 4_200));
    await ctx.sleep(100);
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, '检测到缓存已冷却，本轮将重新计算上下文前缀。'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, messageEnd(sessionId, runId, messageId, '检测到缓存已冷却，本轮将重新计算上下文前缀。', 0));

    await ctx.sleep(80);
    await ctx.emit(sessionId, toolStart(sessionId, runId, 'batch-mock-cache-1', {
      id: 'tc-mock-cache-1',
      toolName: 'shell:read',
      summary: '读取构建日志统计缓存命中率',
      input: { path: 'logs/build.json' },
      category: 'terminal',
      concurrency: 'sequential',
    }));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolUpdate(sessionId, runId, 'batch-mock-cache-1', 'tc-mock-cache-1', 'hitRatio=0.31  miss=24500 tokens'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolEnd(sessionId, runId, 'batch-mock-cache-1', {
      id: 'tc-mock-cache-1',
      toolName: 'shell:read',
      output: { text: 'hitRatio=0.31, miss=24500 tokens' },
      isError: false,
      durationMs: 240,
    }));

    await ctx.sleep(80);
    await ctx.emit(sessionId, cacheWasteAlert(sessionId, runId, 'idle-ttl-expired', 24_500, 1_200_000, false, 0.08));
    await ctx.sleep(60);
    await ctx.emit(sessionId, turnEnd(sessionId, runId, 0, 1));
    await ctx.sleep(60);
    await ctx.emit(sessionId, runTerminal(sessionId, runId, 'completed'));
    await ctx.sleep(80);
    // 收口轨：run 收口时一次发射会话级缓存统计快照（字段同引擎 RunCacheStats 必填面）
    await ctx.emit(sessionId, cacheStatsUpdated(sessionId, runId, {
      promptTokens: 12_400,
      completionTokens: 6_800,
      totalTokens: 19_200,
      cacheReadTokens: 11_500,
      cacheWriteTokens: 900,
      cacheMissTokens: 4_800,
      sampleCount: 6,
      hitRatio: 0.75,
      writeRatio: 0.047,
      missedTokens: 4_800,
      warmUntilMs: Date.now() + 86_400_000,
    }));
    await ctx.sleep(60);
    await ctx.emit(sessionId, agentEnd(sessionId, runId, 'stop'));
  },
};
