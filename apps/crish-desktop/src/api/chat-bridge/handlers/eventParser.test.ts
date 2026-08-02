/**
 * 单一解析入口测试（T7）：parseBridgeEvent 收敛全部事件形态。
 *
 * 覆盖：生成解析器直出（规范载荷）、宽容归一（缺信封字段）、
 * 历史别名（text-delta / run-completed / run-failed / run-cancelled）、
 * legacy 信封（subagent-* / error）、未知事件 parseErr（供 unknown-case 登记）。
 */
import { describe, expect, it } from 'vitest';
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
});
