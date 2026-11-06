import { describe, expect, it } from 'vitest';
import { applySubagentEventToMessages } from './subagentTimeline';
import type { SessionMessage } from '../store/types';

/** 引擎 ToolBatchCall 形状：id + toolName + input + summary */
function engineToolStart(call: {
  id: string;
  toolName: string;
  input?: Record<string, unknown>;
  intent?: string;
}) {
  return {
    type: 'tool-start',
    call: {
      id: call.id,
      toolName: call.toolName,
      input: call.input ?? {},
      intent: call.intent,
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
        intent: '读取 a.ts',
      })
    );

    const asst1 = messages.find((m) => m.sender === 'assistant');
    expect(asst1).toBeTruthy();
    expect(asst1!.status).toBe('processing');
    expect(asst1!.toolCalls).toHaveLength(1);
    expect(asst1!.toolCalls![0]).toMatchObject({
      id: 'tc-1',
      name: 'read_file',
      status: 'running',
      intent: '读取 a.ts',
    });
    expect(asst1!.toolCalls![0]!.arguments).toContain('src/a.ts');
    // R4a：tool-start 落 startedAt（本地接收时刻近似，此前从不写）
    expect(typeof asst1!.toolCalls![0]!.startedAt).toBe('number');
    expect(asst1!.toolCalls![0]!.durationMs).toBeUndefined();
    expect(
      asst1!.blocks?.some((b) => b.type === 'tool_call' && b.id === 'tc-1')
    ).toBe(true);
    // 分段记账：streamTextOffset 已随单一偏移模型删除，tool-start 不再写它；
    // 交错顺序由 blocks 中 tool_call 块的位置本身承载。
    expect(asst1!.streamTextOffset).toBeUndefined();

    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({
        id: 'tc-1',
        toolName: 'read_file',
        text: 'export const x = 1',
      })
    );

    const asst2 = messages.find((m) => m.sender === 'assistant');
    expect(asst2!.toolCalls).toHaveLength(1);
    expect(asst2!.toolCalls![0]).toMatchObject({
      id: 'tc-1',
      status: 'success',
      output: 'export const x = 1',
    });
    // R4a：tool-end 落 durationMs——引擎 ToolBatchResult 实测值（夹具 12）优先
    expect(asst2!.toolCalls![0]!.durationMs).toBe(12);
  });

  it('backfills timing: derived duration without engine value, orphan end keeps engine duration only', () => {
    let messages: SessionMessage[] = [];

    // 无引擎 durationMs 的 tool-end：以本地 end-start 差近似
    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 't-noengine', toolName: 'read_file' })
    );
    messages = applySubagentEventToMessages(messages, {
      type: 'tool-end',
      result: {
        id: 't-noengine',
        toolName: 'read_file',
        output: { text: 'ok' },
        isError: false,
      },
    });
    let asst = messages.find((m) => m.sender === 'assistant')!;
    const derived = asst.toolCalls!.find((t) => t.id === 't-noengine')!;
    expect(typeof derived.startedAt).toBe('number');
    expect(typeof derived.durationMs).toBe('number');
    expect(derived.durationMs!).toBeGreaterThanOrEqual(0);

    // 孤儿 tool-end（漏收 start）：引擎 durationMs 照实落，startedAt 不伪造
    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({ id: 't-orphan', toolName: 'read_file', text: 'x' })
    );
    asst = messages.find((m) => m.sender === 'assistant')!;
    const orphan = asst.toolCalls!.find((t) => t.id === 't-orphan')!;
    expect(orphan.durationMs).toBe(12);
    expect(orphan.startedAt).toBeUndefined();

    // 重放 tool-end 不覆盖已落 durationMs（补写幂等）
    messages = applySubagentEventToMessages(messages, {
      type: 'tool-end',
      result: {
        id: 't-noengine',
        toolName: 'read_file',
        output: { text: 'ok' },
        isError: false,
        durationMs: 999,
      },
    });
    asst = messages.find((m) => m.sender === 'assistant')!;
    expect(asst.toolCalls!.find((t) => t.id === 't-noengine')!.durationMs).toBe(
      derived.durationMs
    );
  });

  it('matches tool-end by id among concurrent tools and supports orphan end', () => {
    let messages: SessionMessage[] = [];

    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'a', toolName: 'read_file', input: { path: 'a' } })
    );
    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'b', toolName: 'read_file', input: { path: 'b' } })
    );

    // 后启动的 b 先结束，不应误改 a
    messages = applySubagentEventToMessages(
      messages,
      engineToolEnd({ id: 'b', text: 'content-b' })
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
      })
    );
    asst = messages.find((m) => m.sender === 'assistant')!;
    const orphan = asst.toolCalls!.find((t) => t.id === 'orphan-1');
    expect(orphan).toMatchObject({
      name: 'run_terminal_command',
      status: 'error',
      output: 'boom',
    });
    expect(
      asst.blocks?.some((b) => b.type === 'tool_call' && b.id === 'orphan-1')
    ).toBe(true);

    // 重放 tool-start 不应把已 success 的工具打回 running
    messages = applySubagentEventToMessages(
      messages,
      engineToolStart({ id: 'b', toolName: 'read_file', input: { path: 'b' } })
    );
    asst = messages.find((m) => m.sender === 'assistant')!;
    expect(asst.toolCalls!.find((t) => t.id === 'b')!.status).toBe('success');
  });
});
