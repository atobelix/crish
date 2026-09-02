import { describe, it, expect, beforeEach } from 'vitest';
import { useEphemeralChatStore } from '../ephemeralChatStore';

describe('ephemeralChatStore — 瞬态进行时状态机与自愈测试', () => {
  beforeEach(() => {
    useEphemeralChatStore.getState().clearAll();
  });

  it('初始状态：所有会话瞬态状态均为 undefined/null', () => {
    const s = useEphemeralChatStore.getState();
    expect(s.statusBySession['session_1']).toBeUndefined();
  });

  it('单例去重：同一会话多次写入错误，后到的错误直接原子覆盖，不产生堆叠', () => {
    const store = useEphemeralChatStore.getState();

    store.setEphemeralStatus('session_1', {
      id: 'net_1',
      kind: 'network',
      message: '网络连接超时',
      retryable: true,
      timestamp: 1000,
    });

    let current = useEphemeralChatStore.getState().statusBySession['session_1'];
    expect(current).toBeDefined();
    expect(current?.message).toBe('网络连接超时');
    expect(current?.kind).toBe('network');

    // 覆盖新错误
    store.setEphemeralStatus('session_1', {
      id: 'auth_1',
      kind: 'auth',
      message: 'API Key 失效，请重新配置',
      retryable: false,
      timestamp: 2000,
    });

    current = useEphemeralChatStore.getState().statusBySession['session_1'];
    expect(current?.message).toBe('API Key 失效，请重新配置');
    expect(current?.kind).toBe('auth');
    // 键池中仍然只有该会话的唯一实例
    expect(Object.keys(useEphemeralChatStore.getState().statusBySession)).toEqual(['session_1']);
  });

  it('四大自愈：clearEphemeralStatus 触发后瞬间卸载，恢复干净纯洁状态', () => {
    const store = useEphemeralChatStore.getState();

    store.setEphemeralStatus('session_2', {
      id: 'err_2',
      kind: 'generic',
      message: '服务暂时不可用',
      retryable: true,
      timestamp: 3000,
    });

    expect(useEphemeralChatStore.getState().statusBySession['session_2']).toBeDefined();

    // 模拟发送新消息或点击重试时触发自愈清空
    store.clearEphemeralStatus('session_2');

    expect(useEphemeralChatStore.getState().statusBySession['session_2']).toBeUndefined();
  });

  it('会话隔离：不同会话的瞬态错误互不干扰', () => {
    const store = useEphemeralChatStore.getState();

    store.setEphemeralStatus('session_A', {
      id: 'err_A',
      kind: 'network',
      message: 'A 错误',
      retryable: true,
      timestamp: 10,
    });

    store.setEphemeralStatus('session_B', {
      id: 'err_B',
      kind: 'server_error',
      message: 'B 错误',
      retryable: true,
      timestamp: 20,
    });

    const state = useEphemeralChatStore.getState();
    expect(state.statusBySession['session_A']?.message).toBe('A 错误');
    expect(state.statusBySession['session_B']?.message).toBe('B 错误');

    store.clearEphemeralStatus('session_A');
    expect(useEphemeralChatStore.getState().statusBySession['session_A']).toBeUndefined();
    expect(useEphemeralChatStore.getState().statusBySession['session_B']?.message).toBe('B 错误');
  });
});
