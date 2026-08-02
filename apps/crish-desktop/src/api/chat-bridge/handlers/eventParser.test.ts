/**
 * 单一解析入口测试（T7）：parseBridgeEvent 收敛全部事件形态。
 *
 * 覆盖：生成解析器直出（规范载荷）、宽容归一（缺信封字段）、
 * 历史别名（text-delta / run-completed / run-failed / run-cancelled）、
 * legacy 信封（subagent-* / error）、未知事件 parseErr（供 unknown-case 登记）。
 */
import { describe, expect, it, vi } from 'vitest';
import { parseBridgeEvent } from './eventParser';

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
    const canceled = parseBridgeEvent({ type: 'run-terminal', terminal: 'canceled' });
    expect(canceled.ok).toBe(true);
    if (canceled.ok && canceled.data.kind === 'engine') {
      expect(canceled.data.event.terminal).toBe('cancelled');
    }
    const error = parseBridgeEvent({ type: 'run-terminal', terminal: 'error' });
    if (error.ok && error.data.kind === 'engine') {
      expect(error.data.event.terminal).toBe('failed');
    }
    const upper = parseBridgeEvent({ type: 'run-terminal', terminal: 'FAILED' });
    if (upper.ok && upper.data.kind === 'engine') {
      expect(upper.data.event.terminal).toBe('failed');
    }
  });

  it('subagent-* 与 error 走 legacy 信封', () => {
    for (const type of ['subagent-started', 'subagent-event', 'subagent-ended', 'error']) {
      const r = parseBridgeEvent({ type, subagentId: 'sa-1' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.kind).toBe('legacy');
        if (r.data.kind === 'legacy') expect(r.data.type).toBe(type);
      }
    }
  });

  it('未知事件 parseErr（供 EventRouter unknown-case 登记，不静默吞）', () => {
    for (const input of [null, [], 'x', {}, { type: '' }, { type: 'nope-event' }]) {
      const r = parseBridgeEvent(input);
      expect(r.ok).toBe(false);
      if (r.ok === false) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('approval-requested 嵌套 request 与平铺形状均归一出 toolCallId / parameters', () => {
    const nested = parseBridgeEvent({
      type: 'approval-requested',
      request: { toolCallId: 'tc-a', toolName: 'shell_command', parameters: { command: 'ls' } },
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
      expect(flat.data.event.request.parameters).toMatchObject({ command: 'git status' });
    }
  });

  it('approval-resolved 决策映射：approved 放行、denied/expired/未知拒绝', () => {
    const approved = parseBridgeEvent({ type: 'approval-resolved', toolCallId: 't1', decision: 'approved' });
    expect(approved.ok).toBe(true);
    if (approved.ok && approved.data.kind === 'engine') {
      expect(approved.data.event.decision).toBe('approved');
    }
    const expired = parseBridgeEvent({ type: 'approval-resolved', toolCallId: 't2', decision: 'expired' });
    if (expired.ok && expired.data.kind === 'engine') {
      expect(expired.data.event.decision).toBe('expired');
    }
    const weird = parseBridgeEvent({ type: 'approval-resolved', toolCallId: 't3', decision: 'maybe' });
    if (weird.ok && weird.data.kind === 'engine') {
      expect(weird.data.event.decision).toBe('denied');
    }
    const behavior = parseBridgeEvent({ type: 'approval-resolved', toolCallId: 't4', decision: { behavior: 'allow' } });
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
      calls: [{ toolCallId: 'c-2', name: 'read_file', summary: '读文件', input: { path: 'a.txt' } }],
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
        { id: 'r-1', toolName: 'shell_command', output: 'done', isError: false, durationMs: 10 },
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const start = parseBridgeEvent({ type: 'tool-batch-start', batchId: 'b-5' });
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
      const messages = warn.mock.calls.map((c) => String(c[1] ?? ''));
      expect(messages.some((m) => m.includes('tool-batch-start') && m.includes('calls'))).toBe(true);
      expect(messages.some((m) => m.includes('tool-batch-end') && m.includes('calls'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
