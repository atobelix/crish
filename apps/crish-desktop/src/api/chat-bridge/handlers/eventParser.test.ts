/**
 * 单一解析入口测试（T7）：parseBridgeEvent 收敛全部事件形态。
 *
 * 覆盖：生成解析器直出（规范载荷）、宽容归一（缺信封字段）、
 * 历史别名（text-delta / run-completed / run-failed / run-cancelled）、
 * legacy 信封（subagent-* / error）、未知事件 parseErr（供 unknown-case 登记）。
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { parseBridgeEvent } from './eventParser';
import { logger } from '../../../services/LoggerService';
import type {
  AgentEvent,
  CacheDomainEvent,
  MissAttribution,
  RunCacheStats,
} from '../../../../../../packages/shared-types/src/events';

describe('parseBridgeEvent（T7 单一解析入口）', () => {
  it('规范 message-delta 载荷经生成解析器直出具体信封类型', () => {
    const r = parseBridgeEvent({
      type: 'message-delta',
      sessionId: 's',
      timestamp: 't',
      messageId: 'm',
      block: { type: 'text', text: 'hi' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.kind).toBe('engine');
      if (r.data.kind === 'engine') {
        expect(r.data.type).toBe('message-delta');
        expect(r.data.event.type).toBe('message-delta');
        expect(r.data.event.block.type).toBe('text');
      }
    }
  });

  it('宽容形态 message-delta（缺信封字段）经归一器兜底', () => {
    const r = parseBridgeEvent({
      type: 'message-delta',
      block: { type: 'thought', text: '想' },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.block.type).toBe('thought');
    }
  });

  it('text-delta 别名归一为 message-delta 文本块', () => {
    const r = parseBridgeEvent({ type: 'text-delta', text: 'hi' });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.type).toBe('message-delta');
      expect(r.data.originalType).toBe('text-delta');
      const block = r.data.event.block;
      expect(block.type).toBe('text');
      if (block.type === 'text') expect(block.text).toBe('hi');
    }
  });

  it('run-completed / run-failed / run-cancelled 归一为 run-terminal 且保留 originalType', () => {
    for (const [alias, terminal] of [
      ['run-completed', 'completed'],
      ['run-failed', 'failed'],
      ['run-cancelled', 'cancelled'],
    ] as const) {
      const r = parseBridgeEvent({ type: alias, terminal });
      expect(r.ok).toBe(true);
      if (r.ok && r.data.kind === 'engine') {
        expect(r.data.type).toBe('run-terminal');
        expect(r.data.originalType).toBe(alias);
        expect(r.data.event.terminal).toBe(terminal);
      }
    }
  });

  it('run-terminal 拼写变体 canceled / error / FAILED 归一为规范枚举', () => {
    const canceled = parseBridgeEvent({
      type: 'run-terminal',
      terminal: 'canceled',
    });
    expect(canceled.ok).toBe(true);
    if (canceled.ok && canceled.data.kind === 'engine') {
      expect(canceled.data.event.terminal).toBe('cancelled');
    }
    const error = parseBridgeEvent({ type: 'run-terminal', terminal: 'error' });
    if (error.ok && error.data.kind === 'engine') {
      expect(error.data.event.terminal).toBe('failed');
    }
    const upper = parseBridgeEvent({
      type: 'run-terminal',
      terminal: 'FAILED',
    });
    if (upper.ok && upper.data.kind === 'engine') {
      expect(upper.data.event.terminal).toBe('failed');
    }
  });

  it('subagent-* 与 error 走 legacy 信封', () => {
    for (const type of [
      'subagent-started',
      'subagent-event',
      'subagent-ended',
      'error',
    ]) {
      const r = parseBridgeEvent({ type, subagentId: 'sa-1' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.kind).toBe('legacy');
        if (r.data.kind === 'legacy') expect(r.data.type).toBe(type);
      }
    }
  });

  it('未知事件 parseErr（供 EventRouter unknown-case 登记，不静默吞）', () => {
    for (const input of [
      null,
      [],
      'x',
      {},
      { type: '' },
      { type: 'nope-event' },
    ]) {
      const r = parseBridgeEvent(input);
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('approval-requested 嵌套 request 与平铺形状均归一出 toolCallId / parameters', () => {
    const nested = parseBridgeEvent({
      type: 'approval-requested',
      request: {
        toolCallId: 'tc-a',
        toolName: 'shell_command',
        parameters: { command: 'ls' },
      },
    });
    expect(nested.ok).toBe(true);
    if (nested.ok && nested.data.kind === 'engine') {
      expect(nested.data.event.request.toolCallId).toBe('tc-a');
      expect(nested.data.event.request.toolName).toBe('shell_command');
    }
    const flat = parseBridgeEvent({
      type: 'approval-requested',
      toolCallId: 'tc-b',
      toolName: 'shell_command',
      input: { command: 'git status' },
    });
    expect(flat.ok).toBe(true);
    if (flat.ok && flat.data.kind === 'engine') {
      expect(flat.data.event.request.parameters).toMatchObject({
        command: 'git status',
      });
    }
  });

  it('approval-resolved 决策映射：approved 放行、denied/expired/未知拒绝', () => {
    const approved = parseBridgeEvent({
      type: 'approval-resolved',
      toolCallId: 't1',
      decision: 'approved',
    });
    expect(approved.ok).toBe(true);
    if (approved.ok && approved.data.kind === 'engine') {
      expect(approved.data.event.decision).toBe('approved');
    }
    const expired = parseBridgeEvent({
      type: 'approval-resolved',
      toolCallId: 't2',
      decision: 'expired',
    });
    if (expired.ok && expired.data.kind === 'engine') {
      expect(expired.data.event.decision).toBe('expired');
    }
    const weird = parseBridgeEvent({
      type: 'approval-resolved',
      toolCallId: 't3',
      decision: 'maybe',
    });
    if (weird.ok && weird.data.kind === 'engine') {
      expect(weird.data.event.decision).toBe('denied');
    }
    const behavior = parseBridgeEvent({
      type: 'approval-resolved',
      toolCallId: 't4',
      decision: { behavior: 'allow' },
    });
    if (behavior.ok && behavior.data.kind === 'engine') {
      expect(behavior.data.event.decision).toBe('approved');
    }
  });

  it('宽容路径 tool-batch-start 保留 calls（缺 summary 触发宽容归一，不丢批内调用）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-start',
      sessionId: 's',
      batchId: 'b-1',
      calls: [
        {
          id: 'c-1',
          toolName: 'shell_command',
          summary: 'ls',
          input: { command: 'ls' },
          category: 'terminal',
          concurrency: 'sequential',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.type).toBe('tool-batch-start');
      expect(r.data.event.calls).toHaveLength(1);
      const call = r.data.event.calls[0];
      expect(call.id).toBe('c-1');
      expect(call.toolName).toBe('shell_command');
      expect(call.input).toMatchObject({ command: 'ls' });
    }
  });

  it('宽容路径 tool-batch-start 逐项别名与默认值（toolCallId/name、缺 category 回退 terminal）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-start',
      batchId: 'b-2',
      calls: [
        {
          toolCallId: 'c-2',
          name: 'read_file',
          summary: '读文件',
          input: { path: 'a.txt' },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      const call = r.data.event.calls[0];
      expect(call.id).toBe('c-2');
      expect(call.toolName).toBe('read_file');
      expect(call.category).toBe('terminal');
      expect(call.concurrency).toBe('sequential');
    }
  });

  it('宽容路径 tool-batch-end 保留 calls（缺 timestamp 触发宽容归一，不丢批内结果）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-end',
      sessionId: 's',
      batchId: 'b-3',
      calls: [
        {
          id: 'r-1',
          toolName: 'shell_command',
          output: 'done',
          isError: false,
          durationMs: 10,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.type).toBe('tool-batch-end');
      expect(r.data.event.calls).toHaveLength(1);
      const result = r.data.event.calls[0];
      expect(result.id).toBe('r-1');
      expect(result.toolName).toBe('shell_command');
      expect(result.output).toMatchObject({ text: 'done' });
      expect(result.isError).toBe(false);
      expect(result.durationMs).toBe(10);
    }
  });

  it('宽容路径 tool-batch-end 结果别名与 error 真值（toolCallId 优先、error 非空判定）', () => {
    const r = parseBridgeEvent({
      type: 'tool-batch-end',
      batchId: 'b-4',
      calls: [{ toolCallId: 'r-2', name: 'write_file', error: 'boom' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      const result = r.data.event.calls[0];
      expect(result.id).toBe('r-2');
      expect(result.toolName).toBe('write_file');
      expect(result.isError).toBe(true);
    }
  });

  it('宽容路径 tool-batch-start/end 缺 calls 时回退空数组并记录可观测日志', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const start = parseBridgeEvent({
        type: 'tool-batch-start',
        batchId: 'b-5',
      });
      expect(start.ok).toBe(true);
      if (start.ok && start.data.kind === 'engine') {
        expect(start.data.event.calls).toEqual([]);
      }
      const end = parseBridgeEvent({ type: 'tool-batch-end', batchId: 'b-6' });
      expect(end.ok).toBe(true);
      if (end.ok && end.data.kind === 'engine') {
        expect(end.data.event.calls).toEqual([]);
      }
      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((c) => JSON.stringify(c[1] ?? {}));
      expect(
        messages.some(
          (m) => m.includes('tool-batch-start') && m.includes('calls')
        )
      ).toBe(true);
      expect(
        messages.some(
          (m) => m.includes('tool-batch-end') && m.includes('calls')
        )
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parseBridgeEvent（P5 S3 缓存测量域三事件）', () => {
  const fullStats = {
    promptTokens: 12000,
    completionTokens: 400,
    totalTokens: 12400,
    cacheReadTokens: 9000,
    cacheWriteTokens: 500,
    cacheMissTokens: 2500,
    sampleCount: 1,
    hitRatio: 0.75,
    writeRatio: 0.04,
    missedTokens: 0,
    warmUntilMs: 1754200000000,
  };

  it('规范 cache-stats-updated 载荷（stats 完整）经生成解析器直出', () => {
    const r = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
      timestamp: 't',
      stats: fullStats,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.type).toBe('cache-stats-updated');
      expect(r.data.event.stats).toMatchObject({
        cacheReadTokens: 9000,
        hitRatio: 0.75,
      });
    }
  });

  it('宽容 cache-stats-updated（缺 stats/部分字段）经归一器兜底，计数缺省 0 不抛', () => {
    const noStats = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
    });
    expect(noStats.ok).toBe(true);
    if (noStats.ok && noStats.data.kind === 'engine') {
      expect(noStats.data.event.stats.promptTokens).toBe(0);
      expect(noStats.data.event.stats.hitRatio).toBeUndefined();
    }
    const partial = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
      timestamp: 't',
      stats: { promptTokens: 100 },
    });
    expect(partial.ok).toBe(true);
    if (partial.ok && partial.data.kind === 'engine') {
      expect(partial.data.event.stats.promptTokens).toBe(100);
      expect(partial.data.event.stats.completionTokens).toBe(0);
    }
  });

  it('cache-stats-updated stats null 语义：null = 未上报（隐藏）区别于 0', () => {
    const r = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
      stats: {
        cacheReadTokens: 0,
        hitRatio: null,
        writeRatio: null,
        warmUntilMs: null,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect('hitRatio' in r.data.event.stats).toBe(false);
      expect('writeRatio' in r.data.event.stats).toBe(false);
      expect('warmUntilMs' in r.data.event.stats).toBe(false);
      expect(r.data.event.stats.cacheReadTokens).toBe(0);
    }
    const zero = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
      stats: { hitRatio: 0, cacheReadTokens: 0 },
    });
    if (zero.ok && zero.data.kind === 'engine') {
      expect(zero.data.event.stats.hitRatio).toBe(0);
    }
  });

  it('规范 cache-waste-alert 载荷经生成解析器直出（含 missedCostUsd）', () => {
    const r = parseBridgeEvent({
      type: 'cache-waste-alert',
      sessionId: 's',
      timestamp: 't',
      attribution: 'model-switch',
      missedTokens: 21000,
      idleMs: 3000,
      modelChanged: true,
      missedCostUsd: 0.03,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.attribution).toBe('model-switch');
      expect(r.data.event.missedTokens).toBe(21000);
      expect(r.data.event.missedCostUsd).toBe(0.03);
    }
  });

  it('宽容 cache-waste-alert（未知 attribution / 缺字段）兜底 unknown 与 0，不抛', () => {
    const r = parseBridgeEvent({
      type: 'cache-waste-alert',
      sessionId: 's',
      attribution: 'bogus-attribution',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.attribution).toBe('unknown');
      expect(r.data.event.missedTokens).toBe(0);
      expect(r.data.event.idleMs).toBe(0);
      expect(r.data.event.modelChanged).toBe(false);
      expect(r.data.event.missedCostUsd).toBeUndefined();
    }
  });

  it('cache-waste-alert runId 信封注入值读入且 missedCostUsd null = 未上报', () => {
    const r = parseBridgeEvent({
      type: 'cache-waste-alert',
      sessionId: 's',
      runId: 'r-9',
      attribution: 'prefix-changed',
      missedCostUsd: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.runId).toBe('r-9');
      expect('missedCostUsd' in r.data.event).toBe(false);
    }
  });

  it('规范 cold-cache-warning 载荷经生成解析器直出', () => {
    const r = parseBridgeEvent({
      type: 'cold-cache-warning',
      sessionId: 's',
      timestamp: 't',
      ttlSeconds: 300,
      idleMs: 360000,
      resendEstimateTokens: 12400,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.ttlSeconds).toBe(300);
      expect(r.data.event.resendEstimateTokens).toBe(12400);
    }
  });

  it('宽容 cold-cache-warning（全缺字段）兜底 0，不抛', () => {
    const r = parseBridgeEvent({ type: 'cold-cache-warning' });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.ttlSeconds).toBe(0);
      expect(r.data.event.idleMs).toBe(0);
      expect(r.data.event.resendEstimateTokens).toBe(0);
      expect(r.data.event.runId).toBeUndefined();
    }
  });

  it('类型导出：CacheDomainEvent 三变体并入 AgentEvent 联合（编译期契约）', () => {
    expectTypeOf<MissAttribution>().toEqualTypeOf<
      | 'model-switch'
      | 'compaction'
      | 'prefix-changed'
      | 'idle-ttl-expired'
      | 'cold'
      | 'zero-read'
      | 'low-read'
      | 'unknown'
    >();
    expectTypeOf<RunCacheStats>().toHaveProperty(
      'cacheReadTokens',
      'number | undefined'
    );
    expectTypeOf<RunCacheStats>().toHaveProperty(
      'hitRatio',
      'number | undefined'
    );
    const ev = {
      type: 'cache-stats-updated',
      sessionId: 's',
      timestamp: 't',
      stats: {},
    } satisfies AgentEvent;
    expect(ev.type).toBe('cache-stats-updated');
    const alert = {
      type: 'cache-waste-alert',
      sessionId: 's',
      timestamp: 't',
      attribution: 'zero-read',
      missedTokens: 20000,
    } satisfies CacheDomainEvent;
    expect(alert.attribution).toBe('zero-read');
  });
});

describe('parseBridgeEvent（P6 S4：message-end 携带 metadata.usage 与缓存事件未知字段容忍）', () => {
  it('message-end 完整消息携带 metadata.usage（ProviderUsage camelCase）解析成功且 usage 结构化可读', () => {
    const r = parseBridgeEvent({
      type: 'message-end',
      sessionId: 's',
      message: {
        id: 'm-1',
        role: 'assistant',
        createdAt: 't',
        blocks: [{ type: 'text', text: 'hi' }],
        metadata: {
          usage: {
            promptTokens: 12000,
            cacheReadTokens: 9000,
            cacheWriteTokens: 500,
          },
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.type).toBe('message-end');
      const usage = (r.data.event.message.metadata as { usage?: unknown })
        ?.usage;
      expect(usage).toMatchObject({
        promptTokens: 12000,
        cacheReadTokens: 9000,
        cacheWriteTokens: 500,
      });
    }
  });

  it('宽容路径 message-end：缺信封字段（sessionId）→ 归一器直通 message，metadata.usage 原样保留', () => {
    const r = parseBridgeEvent({
      type: 'message-end',
      message: {
        id: 'm-2',
        role: 'assistant',
        createdAt: 't',
        blocks: [],
        metadata: { usage: { promptTokens: 100, cached_tokens: 70 } },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      const usage = (r.data.event.message.metadata as { usage?: unknown })
        ?.usage;
      expect(usage).toMatchObject({ promptTokens: 100, cached_tokens: 70 });
    }
  });

  it('message-end 缺 message → parseErr（宽容归一器不伪造消息，不静默吞）', () => {
    const r = parseBridgeEvent({ type: 'message-end', sessionId: 's' });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.length).toBeGreaterThan(0);
  });

  it('cache-stats-updated 未知字段容忍：多余字段不破坏解析，已知字段语义保留', () => {
    const r = parseBridgeEvent({
      type: 'cache-stats-updated',
      sessionId: 's',
      stats: { promptTokens: 100, futureField: { nested: 1 } },
      extraTopLevel: 'ignored',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.stats.promptTokens).toBe(100);
      expect('futureField' in r.data.event.stats).toBe(false);
    }
  });

  it('cache-waste-alert 未知字段容忍：多余字段不改变归因与计数语义', () => {
    const r = parseBridgeEvent({
      type: 'cache-waste-alert',
      sessionId: 's',
      attribution: 'cold',
      missedTokens: 20000,
      vendorNote: 'extra',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.attribution).toBe('cold');
      expect(r.data.event.missedTokens).toBe(20000);
    }
  });

  it('cold-cache-warning 未知字段容忍：多余字段不改变 TTL 与重发估算', () => {
    const r = parseBridgeEvent({
      type: 'cold-cache-warning',
      sessionId: 's',
      ttlSeconds: 300,
      unknownField: [1, 2],
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.ttlSeconds).toBe(300);
      expect(r.data.event.resendEstimateTokens).toBe(0);
    }
  });
});

describe('parseBridgeEvent（14-T5 数据面 10 类宽容归一：strict 失败后生效）', () => {
  it('task-* 七类缺字段/类型漂移输入归一成功且字段落默认值', () => {
    const started = parseBridgeEvent({
      type: 'task-started',
      isDaemon: 'true',
    });
    expect(started.ok).toBe(true);
    if (started.ok && started.data.kind === 'engine') {
      expect(started.data.type).toBe('task-started');
      expect(started.data.event.taskId).toBe('');
      expect(started.data.event.command).toBe('');
      expect(started.data.event.ownerRunId).toBe('');
      expect(started.data.event.isDaemon).toBe(false);
    }

    const output = parseBridgeEvent({ type: 'task-output', taskId: 't-1' });
    expect(output.ok).toBe(true);
    if (output.ok && output.data.kind === 'engine') {
      expect(output.data.event.taskId).toBe('t-1');
      expect(output.data.event.line).toBeUndefined();
      expect(output.data.event.lineCount).toBeUndefined();
    }

    const heartbeat = parseBridgeEvent({ type: 'task-heartbeat' });
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok && heartbeat.data.kind === 'engine') {
      expect(heartbeat.data.event.taskId).toBe('');
      expect(heartbeat.data.event.resource).toEqual({});
    }

    const suspicious = parseBridgeEvent({
      type: 'task-suspicious',
      silenceMs: '500',
    });
    expect(suspicious.ok).toBe(true);
    if (suspicious.ok && suspicious.data.kind === 'engine') {
      expect(suspicious.data.event.silenceMs).toBe(0);
      expect(suspicious.data.event.lastOutputAtMs).toBe(0);
    }

    const completed = parseBridgeEvent({ type: 'task-completed' });
    expect(completed.ok).toBe(true);
    if (completed.ok && completed.data.kind === 'engine') {
      expect(completed.data.event.exitCode).toBe(0);
      expect(completed.data.event.durationMs).toBe(0);
      expect(completed.data.event.lineCount).toBe(0);
    }

    const failed = parseBridgeEvent({
      type: 'task-failed',
      tail: '最后一行',
    });
    expect(failed.ok).toBe(true);
    if (failed.ok && failed.data.kind === 'engine') {
      expect(failed.data.event.exitCode).toBe(0);
      expect(failed.data.event.tail).toEqual(['最后一行']);
    }

    const killed = parseBridgeEvent({ type: 'task-killed', viaForce: 'true' });
    expect(killed.ok).toBe(true);
    if (killed.ok && killed.data.kind === 'engine') {
      expect(killed.data.event.viaForce).toBe(false);
      expect(killed.data.event.diagnostics).toBeUndefined();
    }
  });

  it('timer/cron 三类缺字段/类型漂移输入归一成功且字段落默认值', () => {
    const fired = parseBridgeEvent({ type: 'timer-fired' });
    expect(fired.ok).toBe(true);
    if (fired.ok && fired.data.kind === 'engine') {
      expect(fired.data.event.timerId).toBe('');
      expect(fired.data.event.prompt).toBe('');
      expect(fired.data.event.firedAtMs).toBe(0);
    }

    const cancelled = parseBridgeEvent({
      type: 'timer-cancelled',
      cancelledAtMs: '123',
    });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok && cancelled.data.kind === 'engine') {
      expect(cancelled.data.event.reason).toBe('');
      expect(cancelled.data.event.cancelledAtMs).toBe(0);
    }

    const cron = parseBridgeEvent({ type: 'cron-fired', iteration: '3' });
    expect(cron.ok).toBe(true);
    if (cron.ok && cron.data.kind === 'engine') {
      expect(cron.data.event.cronId).toBe('');
      expect(cron.data.event.expression).toBe('');
      expect(cron.data.event.iteration).toBe(0);
      expect(cron.data.event.firedAtMs).toBe(0);
    }
  });

  it('security-audit 宽容归一：缺 impact/枚举漂移落默认值不抛', () => {
    const r = parseBridgeEvent({
      type: 'security-audit',
      operation: 'bogus-op',
      decision: 'maybe',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.kind === 'engine') {
      expect(r.data.event.operation).toBe('command-exec');
      expect(r.data.event.decision).toBe('denied');
      expect(r.data.event.targets).toEqual([]);
      expect(r.data.event.impact).toEqual({
        fileCount: 0,
        totalSizeBytes: 0,
        directoryCount: 0,
        crossDirectory: false,
        flagged: false,
      });
    }
  });

  it('十类漂移输入全部返回 ok 而非 parseErr（不进 unknown 登记路径）', () => {
    const types = [
      'task-started',
      'task-output',
      'task-heartbeat',
      'task-suspicious',
      'task-completed',
      'task-failed',
      'task-killed',
      'timer-fired',
      'timer-cancelled',
      'cron-fired',
      'security-audit',
    ];
    for (const type of types) {
      const r = parseBridgeEvent({ type });
      expect(r.ok).toBe(true);
    }
  });

  it('strict 可解析的规范输入与宽容归一器输出等价（防双轨分叉）', () => {
    const completed = parseBridgeEvent({
      type: 'task-completed',
      sessionId: 's',
      taskId: 't-1',
      exitCode: 0,
      durationMs: 1200,
      lineCount: 42,
    });
    expect(completed.ok).toBe(true);
    if (completed.ok && completed.data.kind === 'engine') {
      expect(completed.data.event).toMatchObject({
        taskId: 't-1',
        exitCode: 0,
        durationMs: 1200,
        lineCount: 42,
      });
    }

    const fired = parseBridgeEvent({
      type: 'timer-fired',
      sessionId: 's',
      timerId: 'timer-1',
      prompt: '提醒',
      firedAtMs: 1000,
    });
    expect(fired.ok).toBe(true);
    if (fired.ok && fired.data.kind === 'engine') {
      expect(fired.data.event).toMatchObject({
        timerId: 'timer-1',
        prompt: '提醒',
        firedAtMs: 1000,
      });
    }

    const audit = parseBridgeEvent({
      type: 'security-audit',
      sessionId: 's',
      timestamp: 't',
      operation: 'delete',
      decision: 'blocked',
      targets: ['/a'],
      impact: {
        fileCount: 2,
        totalSizeBytes: 10,
        directoryCount: 1,
        crossDirectory: false,
        flagged: false,
      },
    });
    expect(audit.ok).toBe(true);
    if (audit.ok && audit.data.kind === 'engine') {
      expect(audit.data.event.operation).toBe('delete');
      expect(audit.data.event.decision).toBe('blocked');
      expect(audit.data.event.targets).toEqual(['/a']);
      expect(audit.data.event.impact.fileCount).toBe(2);
    }
  });
});
