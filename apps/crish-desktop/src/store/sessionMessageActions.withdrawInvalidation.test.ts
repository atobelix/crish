/**
 * withdrawMessage 收口适配（R2-b ⑥ gap2 补点 · analysis/15 §②）：
 * 被撤回消息（含其后节点）对象已不在时间线 → 编辑会话失效广播
 * （invalidate 'withdraw'）。不恢复撤回语义——withdrawMessage 仍仅服务
 * send-failure 乐观回滚（R6 收口 D5 已收敛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from './sessionStore';

const invalidationSpy = vi.hoisted(() => ({
  invalidateEditObjects: vi.fn(),
}));
vi.mock('../api/chat-bridge/editSessionConsumer', () => ({
  editSessionConsumer: {
    open: vi.fn(),
    commit: vi.fn(),
    invalidate: vi.fn(),
    isOpen: vi.fn(),
  },
  invalidateEditObjects: invalidationSpy.invalidateEditObjects,
  bindEditSession: vi.fn(),
  getBoundEditSession: vi.fn(() => null),
  isEditSessionConsumerBound: vi.fn(() => false),
}));

describe('withdrawMessage 收口适配（R2-b ⑥ 失效广播）', () => {
  const created: string[] = [];
  let sid = '';

  beforeEach(() => {
    sid = `sess-withdraw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useSessionStore.getState().createSession({
      title: 'withdraw-invalidation-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
    invalidationSpy.invalidateEditObjects.mockClear();
    const wsId = 'ws-1';
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-u1',
      sender: 'user',
      text: '你好',
      timestamp: 1,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a1',
      sender: 'assistant',
      text: '回复',
      timestamp: 2,
    });
    useSessionStore.getState().addMessage(wsId, sid, {
      id: 'msg-a2',
      sender: 'assistant',
      text: '第二轮',
      timestamp: 3,
    });
  });

  afterEach(() => {
    for (const s of created.splice(0)) {
      useSessionStore.getState().deleteSession(s);
    }
  });

  it('撤回中间消息 → 精确摘除目标节点，保留后续时间线与排队追问，仅失效被撤回节点', () => {
    // 增加一条 queued 的追问
    useSessionStore.getState().addMessage('ws-1', sid, {
      id: 'msg-u2-queued',
      sender: 'user',
      text: '排队追问',
      timestamp: 4,
      status: 'queued',
    });

    useSessionStore.getState().withdrawMessage('ws-1', sid, 'msg-a1');

    const sess = useSessionStore.getState().sessionsById[sid];
    expect(sess?.messages.map((m) => m.id)).toEqual(['msg-u1', 'msg-a2', 'msg-u2-queued']);
    expect(invalidationSpy.invalidateEditObjects).toHaveBeenCalledWith(
      ['msg-a1'],
      'withdraw'
    );
  });

  it('撤回带有 toolCalls 的助手消息 → 派生工具回执节点一同被摘除', () => {
    useSessionStore.getState().addMessage('ws-1', sid, {
      id: 'msg-a-tools',
      sender: 'assistant',
      text: '调用工具',
      timestamp: 10,
      toolCalls: [{ id: 'tc-exec-1', name: 'run_cmd', args: '{}', status: 'completed' }],
    });
    useSessionStore.getState().addMessage('ws-1', sid, {
      id: 'msg-tool-result',
      sender: 'tool',
      timestamp: 11,
      toolCallResults: [{ id: 'tc-exec-1', output: 'ok' }],
    });
    useSessionStore.getState().addMessage('ws-1', sid, {
      id: 'msg-u3',
      sender: 'user',
      text: '后续问题',
      timestamp: 12,
    });

    useSessionStore.getState().withdrawMessage('ws-1', sid, 'msg-a-tools');

    const sess = useSessionStore.getState().sessionsById[sid];
    expect(sess?.messages.map((m) => m.id)).not.toContain('msg-a-tools');
    expect(sess?.messages.map((m) => m.id)).not.toContain('msg-tool-result');
    expect(sess?.messages.map((m) => m.id)).toContain('msg-u3');
  });

  it('目标不存在 → 不截断、不广播', () => {
    useSessionStore.getState().withdrawMessage('ws-1', sid, 'msg-no-such');

    const sess = useSessionStore.getState().sessionsById[sid];
    expect(sess?.messages).toHaveLength(3);
    expect(invalidationSpy.invalidateEditObjects).not.toHaveBeenCalled();
  });
});
