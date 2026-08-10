// =======================================================================
// mock daemon v0（R0-06）——审批流完整序列场景（交互式）
//
// 覆盖：移动端第一功能域（F2 审批中心）的端到端路径——
//   run 启动 → 审批请求（approval-requested，等待客户端决策）→
//   approve/deny 命令 → approval-resolved 广播 → 工具执行 → run 收口。
// 审批参数按 F2 口径：shell:write、危险级别 1、expiresAt = 请求 + 2 分钟。
// =======================================================================

import type { ScenarioDefinition } from './index.js';
import { agentStart, turnStart, messageDeltaThought, messageDeltaText, toolStart, toolUpdate, toolEnd, messageEnd, turnEnd, agentEnd, runTerminal } from './events.js';

export const approvalScenario: ScenarioDefinition = {
  id: 'approval',
  description: '审批流完整序列：run 启动 → 审批请求（等待决策）→ approval-resolved → 工具执行 → run 收口',
  sessionId: 's-mock-approval',
  runId: 'r-mock-approval-1',
  loopable: false,
  interactive: true,
  async run(ctx): Promise<void> {
    const sessionId = 's-mock-approval';
    const runId = 'r-mock-approval-1';
    const messageId = 'msg-mock-approval-1';
    const toolCallId = 'tc-mock-approve-1';
    const batchId = 'batch-mock-approval-1';

    await ctx.emit(sessionId, agentStart(sessionId, runId));
    await ctx.sleep(60);
    await ctx.emit(sessionId, turnStart(sessionId, runId, 0));
    await ctx.sleep(80);
    await ctx.emit(sessionId, messageDeltaThought(sessionId, runId, messageId));
    await ctx.sleep(60);
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, '检测到需要执行权限的操作，正在发起审批请求…'));

    // 审批闸门：登记待审批 + 发射 approval-requested，等待客户端决策
    await ctx.sleep(80);
    const decision = await ctx.requestApproval({
      requestId: 'req-mock-approval-1',
      toolCallId,
      toolName: 'shell:write',
      summary: 'npm test 需要执行权限（mock 夹具）',
      cwd: 'C:\\Software\\conex',
      sessionId,
      runId,
      arbiter: 'user',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 2 * 60 * 1000,
      dangerLevel: 1,
      paramKeys: ['script', 'cwd'],
    });

    // 决策后的续接：按决策结果播报 + 工具执行 + 收口
    await ctx.sleep(80);
    const decidedText = decision.decision === 'approved' ? '已批准，开始执行…' : '已拒绝，跳过执行…';
    await ctx.emit(sessionId, messageDeltaText(sessionId, runId, messageId, decidedText));
    await ctx.sleep(100);
    await ctx.emit(sessionId, toolStart(sessionId, runId, batchId, {
      id: toolCallId,
      toolName: 'shell:write',
      summary: 'npm test',
      input: { script: 'npm test', cwd: 'C:\\Software\\conex' },
      category: 'terminal',
      concurrency: 'sequential',
    }));
    await ctx.sleep(80);
    await ctx.emit(sessionId, toolUpdate(sessionId, runId, batchId, toolCallId, '> conex@0.1.0 test\n> vitest run'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolUpdate(sessionId, runId, batchId, toolCallId, '✓ 42 tests passed (3.2s)'));
    await ctx.sleep(60);
    await ctx.emit(sessionId, toolEnd(sessionId, runId, batchId, {
      id: toolCallId,
      toolName: 'shell:write',
      output: { text: '✓ 42 tests passed (3.2s)' },
      isError: false,
      durationMs: 3200,
    }));
    await ctx.sleep(80);
    await ctx.emit(sessionId, messageEnd(sessionId, runId, messageId, '已批准执行：npm test 全量通过（42/42）。', 0));
    await ctx.sleep(80);
    await ctx.emit(sessionId, turnEnd(sessionId, runId, 0, 1));
    await ctx.sleep(60);
    await ctx.emit(sessionId, agentEnd(sessionId, runId, 'stop'));
    await ctx.sleep(80);
    await ctx.emit(sessionId, runTerminal(sessionId, runId, 'completed'));
  },
};
