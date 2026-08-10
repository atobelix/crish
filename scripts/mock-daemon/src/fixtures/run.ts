// =======================================================================
// mock daemon v0（R0-06）——run 生命周期场景（可循环）
//
// 覆盖：移动端会话详情 / run 详情页的完整事件流（F1/F3 观测面）——
//   agent-start → turn-start → 流式 message-delta → message-end →
//   工具调用（shell:read / shell:write）→ turn-end → agent-end → run-terminal。
// 场景可 --loop 重复播放，用于持续观察「事件流实时刷新」体验。
// =======================================================================

import type { ScenarioDefinition } from './index.js';
import { agentStart, turnStart, messageDeltaThought, messageDeltaText, toolStart, toolUpdate, toolEnd, messageEnd, turnEnd, agentEnd, runTerminal } from './events.js';

export const runScenario: ScenarioDefinition = {
  id: 'run',
  description: 'run 生命周期：agent-start → 消息流 → 工具执行 → run-terminal（可循环）',
  sessionId: 's-mock-run',
  runId: 'r-mock-run-1',
  loopable: true,
  interactive: false,
  async run(ctx): Promise<void> {
    const sessionId = 's-mock-run';
    const runId = 'r-mock-run-1';
    const messageId = 'msg-mock-run-1';

    await ctx.emit(sessionId, agentStart(sessionId, runId));
    await ctx.sleep(60);
    await ctx.emit(sessionId, turnStart(sessionId, runId, 0));
    await ctx.sleep(80);
    await ctx.emit(sessionId, messageDeltaThought(sessionId, runId, messageId));
    await ctx.sleep(60);
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, '正在检查项目结构…'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, '发现 3 个待修复项，开始处理。'));
    await ctx.sleep(80);
    await ctx.emit(sessionId, messageEnd(sessionId, runId, messageId, '正在检查项目结构…发现 3 个待修复项，开始处理。', 0));

    // 第一轮工具调用：读文件
    await ctx.sleep(80);
    await ctx.emit(sessionId, toolStart(sessionId, runId, 'batch-mock-run-1', {
      id: 'tc-mock-run-1',
      toolName: 'shell:read',
      summary: '读取 packages/shared-types/package.json',
      input: { path: 'packages/shared-types/package.json' },
      category: 'terminal',
      concurrency: 'sequential',
    }));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolUpdate(sessionId, runId, 'batch-mock-run-1', 'tc-mock-run-1', '{\n  "name": "@crish/shared-types",\n  "version": "0.1.0",\n  ...'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolEnd(sessionId, runId, 'batch-mock-run-1', {
      id: 'tc-mock-run-1',
      toolName: 'shell:read',
      output: { text: '读取完成（12 行）' },
      isError: false,
      durationMs: 180,
    }));

    // 第二轮工具调用：写文件
    await ctx.sleep(80);
    await ctx.emit(sessionId, toolStart(sessionId, runId, 'batch-mock-run-1', {
      id: 'tc-mock-run-2',
      toolName: 'shell:write',
      summary: '更新 version 字段为 0.1.1',
      input: { path: 'packages/shared-types/package.json', content: '…' },
      category: 'terminal',
      concurrency: 'sequential',
    }));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolUpdate(sessionId, runId, 'batch-mock-run-1', 'tc-mock-run-2', '✓ 已更新 version 字段'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolEnd(sessionId, runId, 'batch-mock-run-1', {
      id: 'tc-mock-run-2',
      toolName: 'shell:write',
      output: { text: '✓ 已更新 version 字段' },
      isError: false,
      durationMs: 420,
    }));

    await ctx.sleep(80);
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, '修复完成。'));
    await ctx.sleep(80);
    await ctx.emit(sessionId, messageEnd(sessionId, runId, messageId, '修复完成。', 0));
    await ctx.sleep(60);
    await ctx.emit(sessionId, turnEnd(sessionId, runId, 0, 2));
    await ctx.sleep(60);
    await ctx.emit(sessionId, agentEnd(sessionId, runId, 'stop'));
    await ctx.sleep(80);
    await ctx.emit(sessionId, runTerminal(sessionId, runId, 'completed'));
  },
};
