/**
 * 批 B ㉖：markMessageStoppedByUser store 动作——
 * 为用户主动停止的助手消息落呈现标记；幂等；目标不存在时静默 no-op。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from './sessionStore';
import type { SessionMessage, SessionState } from './types';

function seed() {
  const assistant = {
    id: 'a1',
    sender: 'assistant',
    timestamp: 1,
    text: '',
    status: 'processing',
  } as SessionMessage;
  const session = {
    id: 's1',
    messages: [assistant],
  } as unknown as SessionState;
  useSessionStore.setState({
    sessionsById: { s1: session },
    sessionOrder: ['s1'],
  });
}

describe('markMessageStoppedByUser（批 B ㉖）', () => {
  beforeEach(seed);

  it('为目标消息落 stoppedByUser 标记', () => {
    useSessionStore.getState().markMessageStoppedByUser('s1', 'a1');
    const msg = useSessionStore.getState().sessionsById['s1']?.messages[0];
    expect(msg?.stoppedByUser).toBe(true);
  });

  it('重复标记幂等', () => {
    const action = useSessionStore.getState().markMessageStoppedByUser;
    action('s1', 'a1');
    expect(() => action('s1', 'a1')).not.toThrow();
    expect(
      useSessionStore.getState().sessionsById['s1']?.messages[0]?.stoppedByUser
    ).toBe(true);
  });

  it('会话 / 消息不存在时静默 no-op', () => {
    const action = useSessionStore.getState().markMessageStoppedByUser;
    expect(() => action('nope', 'a1')).not.toThrow();
    expect(() => action('s1', 'nope')).not.toThrow();
    expect(
      useSessionStore.getState().sessionsById['s1']?.messages[0]?.stoppedByUser
    ).toBeUndefined();
  });
});
