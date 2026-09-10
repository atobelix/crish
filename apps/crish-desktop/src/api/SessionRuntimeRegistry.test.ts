/**
 * SessionRuntimeRegistry：thinkingTitle 按会话隔离存储。
 * 与 attachments 同级；不进 yaml / SessionState。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSessionThinkingTitle,
  sessionRuntimeRegistry,
  setSessionThinkingTitle,
} from './SessionRuntimeRegistry';

afterEach(() => {
  sessionRuntimeRegistry.stopGC();
  sessionRuntimeRegistry.clearAll();
});

describe('SessionRuntimeState.thinkingTitle', () => {
  it('新建会话缺省为 null', () => {
    const state = sessionRuntimeRegistry.get('sess-a');
    expect(state.thinkingTitle).toBeNull();
    expect(state.attachments).toEqual([]);
  });

  it('save 写入 thinkingTitle，与 attachments 并存且互不覆盖', () => {
    sessionRuntimeRegistry.save('sess-a', {
      attachments: [{ id: 'att-1', name: 'a.txt' }],
      thinkingTitle: 'High',
    });
    sessionRuntimeRegistry.save('sess-a', { thinkingTitle: 'Low' });

    const state = sessionRuntimeRegistry.get('sess-a');
    expect(state.thinkingTitle).toBe('Low');
    expect(state.attachments).toEqual([{ id: 'att-1', name: 'a.txt' }]);
  });

  it('save attachments 不擦除已选 thinkingTitle', () => {
    sessionRuntimeRegistry.save('sess-a', { thinkingTitle: 'Medium' });
    sessionRuntimeRegistry.save('sess-a', {
      attachments: [{ id: 'att-2', name: 'b.png' }],
    });
    expect(sessionRuntimeRegistry.get('sess-a').thinkingTitle).toBe('Medium');
  });
});

describe('setSessionThinkingTitle / getSessionThinkingTitle', () => {
  it('按 sessionId 读写 yaml 字典 key', () => {
    setSessionThinkingTitle('sess-a', 'High');
    expect(getSessionThinkingTitle('sess-a')).toBe('High');
    expect(sessionRuntimeRegistry.get('sess-a').thinkingTitle).toBe('High');
  });

  it('会话物理隔离：A 的档位不影响 B', () => {
    setSessionThinkingTitle('sess-a', 'High');
    setSessionThinkingTitle('sess-b', 'Low');
    expect(getSessionThinkingTitle('sess-a')).toBe('High');
    expect(getSessionThinkingTitle('sess-b')).toBe('Low');

    setSessionThinkingTitle('sess-a', null);
    expect(getSessionThinkingTitle('sess-a')).toBeNull();
    expect(getSessionThinkingTitle('sess-b')).toBe('Low');
  });

  it('写入 null 表示清空（切到非思考模型）', () => {
    setSessionThinkingTitle('sess-a', 'Off');
    setSessionThinkingTitle('sess-a', null);
    expect(getSessionThinkingTitle('sess-a')).toBeNull();
    expect(sessionRuntimeRegistry.get('sess-a').thinkingTitle).toBeNull();
  });

  it('未创建 runtime 时读取为 null，且不新建槽', () => {
    expect(sessionRuntimeRegistry.size).toBe(0);
    expect(getSessionThinkingTitle('never-seen')).toBeNull();
    expect(sessionRuntimeRegistry.exists('never-seen')).toBe(false);
    expect(sessionRuntimeRegistry.size).toBe(0);
  });

  it('空 sessionId 不落幽灵槽', () => {
    setSessionThinkingTitle('', 'High');
    expect(getSessionThinkingTitle('')).toBeNull();
    expect(sessionRuntimeRegistry.exists('')).toBe(false);
    expect(sessionRuntimeRegistry.size).toBe(0);
  });

  it('remove 后档位不残留', () => {
    setSessionThinkingTitle('sess-a', 'High');
    sessionRuntimeRegistry.remove('sess-a');
    expect(sessionRuntimeRegistry.exists('sess-a')).toBe(false);
    expect(getSessionThinkingTitle('sess-a')).toBeNull();
    expect(sessionRuntimeRegistry.get('sess-a').thinkingTitle).toBeNull();
  });
});
