/**
 * withdrawMessage 收口适配（R2-b ⑥ gap2 补点 · analysis/15 §②）：
 * 被撤回消息（含其后节点）对象已不在时间线 → 编辑会话失效广播
 * （invalidate 'withdraw'）。不恢复撤回语义——withdrawMessage 仍仅服务
 * send-failure 乐观回滚（R6 收口 D5 已收敛）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutStore } from './layoutStore';

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
    useLayoutStore.getState().createSession({
      title: 'withdraw-invalidation-test',
      id: sid,
      activate: false,
    });
    created.push(sid);
    invalidationSpy.invalidateEditObjects.mockClear();
    const wsId = useLayoutStore.getState().workspaces[0].id;
    useLayoutStore.getState().addMessage(wsId, sid, {
      id: 'msg-u1',
      sender: 'user',
      text: '你好',
      timestamp: 1,
    });
    useLayoutStore.getState().addMessage(wsId, sid, {
      id: 'msg-a1',
      sender: 'assistant',
      text: '回复',
      timestamp: 2,
    });
    useLayoutStore.getState().addMessage(wsId, sid, {
      id: 'msg-a2',
      sender: 'assistant',
      text: '第二轮',
      timestamp: 3,
    });
  });

  afterEach(() => {
    for (const s of created.splice(0)) {
      useLayoutStore.getState().deleteSession(s);
    }
  });

  it('撤回中间消息 → 被撤回消息（含其后节点）id 收到 invalidate(withdraw) + 时间线截断', () => {
    useLayoutStore.getState().withdrawMessage('ws-1', sid, 'msg-a1');

    const sess = useLayoutStore.getState().sessionsById[sid];
    expect(sess.messages.map((m) => m.id)).toEqual(['msg-u1']);
    expect(invalidationSpy.invalidateEditObjects).toHaveBeenCalledWith(
      ['msg-a1', 'msg-a2'],
      'withdraw'
    );
  });

  it('目标不存在 → 不截断、不广播', () => {
    useLayoutStore.getState().withdrawMessage('ws-1', sid, 'msg-no-such');

    const sess = useLayoutStore.getState().sessionsById[sid];
    expect(sess.messages).toHaveLength(3);
    expect(invalidationSpy.invalidateEditObjects).not.toHaveBeenCalled();
  });
});
