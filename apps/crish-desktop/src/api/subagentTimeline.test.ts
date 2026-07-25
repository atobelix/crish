import { describe, expect, it } from 'vitest';
import { applySubagentEventToMessages } from './subagentTimeline';
import type { SessionMessage } from '../store/types';

/** 引擎 ToolBatchCall 形状：id + toolName + input + summary */
function engineToolStart(call: {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  summary?: string;
}) {
  return {
    type: 'tool-start',
    call: {
      id: call.id,
      toolName: call.toolName,
      input: call.input ?? {},
      summary: call.summary ?? call.toolName,
      category: 'filesystem',
      concurrency: 'exclusive',
    },
  };
}

/** 引擎 ToolBatchResult 形状：id + output.text + isError */
function engineToolEnd(result: {
  id: string;
  toolName?: string;
  text?: string;
  isError?: boolean;
}) {
  return {
    type: 'tool-end',
    result: {
      id: result.id,
      toolName: result.toolName ?? 'tool',
      output: { text: result.text ?? '' },
      isError: Boolean(result.isError),
      durationMs: 12,
    },
  };
}

describe('applySubagentEventToMessages tool-start/end', () => {
  it('projects engine tool-start then tool-end onto assistant toolCalls', () => {
    let messages: SessionMessage[] = [];

    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({
        id: 'tc-1',
        toolName: 'read_file',
        input: { path: 'src/a.ts' },
        summary: '读取 a.ts',
      }),
    );

    const asst1 = messages.find((m) => m.sender === 'assistant');
    expect(asst1).toBeTruthy();
    expect(asst1!.status).toBe('processing');
    expect(asst1!.toolCalls).toHaveLength(1);
    expect(asst1!.toolCalls![0]).toMatchObject({
      id: 'tc-1',
      name: 'read_file',
      status: 'running',
      explanation: '读取 a.ts',
    });
    expect(asst1!.toolCalls![0]!.arguments).toContain('src/a.ts');
    expect(asst1!.blocks?.some((b) => b.type === 'tool_call' && b.id === 'tc-1')).toBe(
      true,
    );
    expect(typeof asst1!.streamTextOffset).toBe('number');

    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({
        id: 'tc-1',
        toolName: 'read_file',
        text: 'export const x = 1',
      }),
    );

    const asst2 = messages.find((m) => m.sender === 'assistant');
    expect(asst2!.toolCalls).toHaveLength(1);
    expect(asst2!.toolCalls![0]).toMatchObject({
      id: 'tc-1',
      status: 'success',
      output: 'export const x = 1',
    });
  });

  it('matches tool-end by id among concurrent tools and supports orphan end', () => {
    let messages: SessionMessage[] = [];

    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'a', toolName: 'read_file', input: { path: 'a' } }),
    );
    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'b', toolName: 'read_file', input: { path: 'b' } }),
    );

    // 后启动的 b 先结束，不应误改 a
    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({ id: 'b', text: 'content-b' }),
    );

    let asst = messages.find((m) => m.sender === 'assistant')!;
    expect(asst.toolCalls!.find((t) => t.id === 'a')!.status).toBe('running');
    expect(asst.toolCalls!.find((t) => t.id === 'b')).toMatchObject({
      status: 'success',
      output: 'content-b',
    });

    // 漏收 tool-start 的 tool-end：仍应落一条终态
    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({
        id: 'orphan-1',
        toolName: 'run_terminal_command',
        text: 'boom',
        isError: true,
      }),
    );
    asst = messages.find((m) => m.sender === 'assistant')!;
    const orphan = asst.toolCalls!.find((t) => t.id === 'orphan-1');
    expect(orphan).toMatchObject({
      name: 'run_terminal_command',
      status: 'error',
      output: 'boom',
    });
    expect(asst.blocks?.some((b) => b.type === 'tool_call' && b.id === 'orphan-1')).toBe(
      true,
    );

    // 重放 tool-start 不应把已 success 的工具打回 running
    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'b', toolName: 'read_file', input: { path: 'b' } }),
    );
    asst = messages.find((m) => m.sender === 'assistant')!;
    expect(asst.toolCalls!.find((t) => t.id === 'b')!.status).toBe('success');
  });
});
