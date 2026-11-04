/**
 * BG3 桌面消费面验收：tool-backgrounded / tool-settled handler
 * （store 直写回填）。
 *
 * 场景（对齐验收口径）：
 * 1. backgrounded 到达 → 承载消息的 toolCall 落 backgrounded 标记 +
 *    已运行时长，output/status 不动（占位仍在，呈现归 BG5）；
 * 2. settled 到达 → 占位 output 被终态结果**原位替换**（status /
 *    output / durationMs / finishedAt 落定、backgrounded 清除），
 *    消息序与 toolCalls 序不变（卡片不消失不跳位）；
 * 3. settled 的 error 终态 → status='error' + 错误文案；
 * 4. 未知 callId / 未知会话 → 静默跳过不抛错、不伪造条目。
 */
import { describe, expect, it, vi } from 'vitest';
import { onToolBackgrounded, onToolSettled } from './toolHandlers';
import type { HandlerEnv } from './handlerEnv';
import { useSessionStore } from '../../../store/sessionStore';

function makeEnv(): HandlerEnv {
  return {
    state: {
      cancelled: false,
      finished: false,
      assistantText: '',
      assistantThought: '',
      unsub: null,
      endTimer: null,
    },
    approvalFlow: {
      dispatch: () => {},
      snapshot: () => ({}),
    } as unknown as HandlerEnv['approvalFlow'],
    callbacks: {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onComplete: vi.fn(),
      onToolStart: vi.fn(),
      onToolSuccess: vi.fn(),
      onToolError: vi.fn(),
    } as unknown as HandlerEnv['callbacks'],
    runId: 'run-test',
    sessionId: 'sess-test',
    finish: () => {},
    tryResumeFinish: () => {},
  };
}

function backgroundedEnvelope(sessionId: string, callId: string) {
  return {
    kind: 'engine',
    type: 'tool-backgrounded',
    originalType: 'tool-backgrounded',
    event: {
      type: 'tool-backgrounded',
      sessionId,
      callId,
      toolName: 'read_file',
      elapsedMs: 20000,
    },
    raw: {
      type: 'tool-backgrounded',
      sessionId,
      callId,
      toolName: 'read_file',
      elapsedMs: 20000,
    },
  } as unknown as Parameters<typeof onToolBackgrounded>[1];
}

function settledEnvelope(
  sessionId: string,
  callId: string,
  result: Record<string, unknown>
) {
  return {
    kind: 'engine',
    type: 'tool-settled',
    originalType: 'tool-settled',
    event: {
      type: 'tool-settled',
      sessionId,
      callId,
      toolName: 'read_file',
      status: result.isError ? 'error' : 'ok',
      result: {
        id: callId,
        toolName: 'read_file',
        output: result.output,
        isError: result.isError === true,
        durationMs: result.durationMs,
      },
    },
    raw: {
      type: 'tool-settled',
      sessionId,
      callId,
      toolName: 'read_file',
      status: result.isError ? 'error' : 'ok',
      result,
    },
  } as unknown as Parameters<typeof onToolSettled>[1];
}

describe('BG3 toolHandlers（后台回注 store 直写）', () => {
  const created: string[] = [];
  let sid = '';

  beforeEach(() => {
    sid = `sess-bg3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().createSession({
      title: 'bg3-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
    const wsId = 'ws-1';
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-u1',
      sender: 'user',
      text: '读一下那个大文件',
      timestamp: 1,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a1',
      sender: 'assistant',
      text: '好的',
      timestamp: 2,
      toolCalls: [
        {
          id: 'tc-bg',
          name: 'read_file',
          status: 'success',
          output: '占位：已转入后台执行',
          durationMs: 20000,
        },
        {
          id: 'tc-other',
          name: 'list_dir',
          status: 'success',
          output: '目录内容',
        },
      ],
    });
  });

  afterEach(() => {
    for (const s of created.splice(0)) {
      useSessionStore.getState().deleteSession(s);
    }
  });

  function toolCall(callId: string) {
    const session = useSessionStore.getState().sessionsById[sid];
    const msg = session.messages.find((m) => m.id === 'msg-a1');
    return msg?.toolCalls?.find((tc) => tc.id === callId);
  }

  it('backgrounded：落标记 + 已运行时长，占位 output/status 不动', () => {
    onToolBackgrounded(makeEnv(), backgroundedEnvelope(sid, 'tc-bg'));
    const tc = toolCall('tc-bg');
    expect(tc?.backgrounded).toBe(true);
    expect(tc?.backgroundedElapsedMs).toBe(20000);
    expect(tc?.output).toBe('占位：已转入后台执行');
    expect(tc?.status).toBe('success');
    // 邻位 toolCall 不受波及
    expect(toolCall('tc-other')?.backgrounded).toBeUndefined();
  });

  it('settled：终态结果原位替换占位，消息序/toolCalls 序不变', () => {
    onToolBackgrounded(makeEnv(), backgroundedEnvelope(sid, 'tc-bg'));
    onToolSettled(
      makeEnv(),
      settledEnvelope(sid, 'tc-bg', {
        output: { text: '真实文件内容' },
        isError: false,
        durationMs: 61000,
      })
    );
    const tc = toolCall('tc-bg');
    expect(tc?.output).toBe('真实文件内容');
    expect(tc?.status).toBe('success');
    expect(tc?.durationMs).toBe(61000);
    expect(tc?.finishedAt).toBeTypeOf('number');
    expect(tc?.backgrounded).toBe(false);
    const session = useSessionStore.getState().sessionsById[sid];
    expect(session.messages.map((m) => m.id)).toEqual(['msg-u1', 'msg-a1']);
    const msg = session.messages.find((m) => m.id === 'msg-a1');
    expect(msg?.toolCalls?.map((t) => t.id)).toEqual(['tc-bg', 'tc-other']);
    expect(toolCall('tc-other')?.output).toBe('目录内容');
  });

  it('settled（error）：status=error + 错误文案回填', () => {
    onToolSettled(
      makeEnv(),
      settledEnvelope(sid, 'tc-bg', {
        output: { text: '读文件失败：不存在' },
        isError: true,
        durationMs: 3000,
      })
    );
    const tc = toolCall('tc-bg');
    expect(tc?.status).toBe('error');
    expect(tc?.output).toBe('读文件失败：不存在');
    expect(tc?.durationMs).toBe(3000);
  });

  it('未知 callId / 未知会话：静默跳过不抛错', () => {
    expect(() =>
      onToolBackgrounded(makeEnv(), backgroundedEnvelope(sid, 'tc-nope'))
    ).not.toThrow();
    expect(() =>
      onToolSettled(
        makeEnv(),
        settledEnvelope('sess-missing', 'tc-bg', {
          output: { text: 'x' },
          isError: false,
          durationMs: 1,
        })
      )
    ).not.toThrow();
    expect(toolCall('tc-bg')?.output).toBe('占位：已转入后台执行');
  });
});
