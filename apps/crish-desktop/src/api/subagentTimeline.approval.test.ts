/**
 * R7b：subagentTimeline 与桥接镜像的时序契约——桥接层可能先于 tool-start
 * 投影落下 pending 条目（携带 approvalMeta），迟到的 tool-start 不得把
 * 待审批降级为 running、不得动 approvalMeta，仅补 startedAt。
 */
import { describe, expect, it } from 'vitest';
import { applySubagentEventToMessages } from './subagentTimeline';
import type { MessageToolCall, SessionMessage } from '../store/types';

function asstWith(tool: MessageToolCall): SessionMessage[] {
  return [
    {
      id: 'am-1',
      sender: 'assistant',
      text: '',
      timestamp: 1,
      status: 'processing',
      toolCalls: [tool],
      blocks: [{ type: 'tool_call', id: tool.id }],
    } as SessionMessage,
  ];
}

const META = {
  riskLevel: 'medium',
  source: 'backend',
  requester: { runId: 'run-sub-1', subagentId: 'ag-1', label: '检索代码' },
  arbiter: 'user',
} as const;

describe('applySubagentEventToMessages · R7b 待审批不降级', () => {
  it('tool-start 迟到：pending_approval 保持、approvalMeta 不动、startedAt 补写', () => {
    const messages = asstWith({
      id: 'tc-1',
      name: 'shell',
      arguments: '{"command":"npm test"}',
      status: 'pending_approval',
      approvalMeta: { ...META },
    });
    const next = applySubagentEventToMessages(messages, {
      type: 'tool-start',
      call: {
        id: 'tc-1',
        toolName: 'shell',
        input: { command: 'npm test' },
        summary: '需要执行测试',
      },
    });
    const tc = next[0]!.toolCalls![0]!;
    expect(tc.status).toBe('pending_approval');
    expect(tc.approvalMeta).toEqual(META);
    expect(typeof tc.startedAt).toBe('number');
  });

  it('tool-start 对 running 条目行为不变（仍 running，可补 startedAt）', () => {
    const messages = asstWith({
      id: 'tc-1',
      name: 'shell',
      status: 'running',
    });
    const next = applySubagentEventToMessages(messages, {
      type: 'tool-start',
      call: { id: 'tc-1', toolName: 'shell', input: { command: 'ls' } },
    });
    const tc = next[0]!.toolCalls![0]!;
    expect(tc.status).toBe('running');
    expect(typeof tc.startedAt).toBe('number');
    expect(tc.approvalMeta).toBeUndefined();
  });

  it('tool-start 对终态条目行为不变（success 不回退）', () => {
    const messages = asstWith({
      id: 'tc-1',
      name: 'shell',
      status: 'success',
      output: 'ok',
    });
    const next = applySubagentEventToMessages(messages, {
      type: 'tool-start',
      call: { id: 'tc-1', toolName: 'shell' },
    });
    expect(next[0]!.toolCalls![0]!.status).toBe('success');
  });

  it('tool-end 照常收口 pending 条目（success + 输出）', () => {
    const messages = asstWith({
      id: 'tc-1',
      name: 'shell',
      status: 'pending_approval',
      approvalMeta: { ...META },
    });
    const next = applySubagentEventToMessages(messages, {
      type: 'tool-end',
      result: { toolCallId: 'tc-1', output: { text: 'done' }, durationMs: 5 },
    });
    const tc = next[0]!.toolCalls![0]!;
    expect(tc.status).toBe('success');
    expect(tc.output).toBe('done');
  });
});
