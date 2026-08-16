import { describe, expect, it, beforeEach } from 'vitest';
import {
  useThoughtInspectorStore,
  openThoughtInspector,
  closeThoughtInspector,
  setSearchQuery,
} from './thoughtInspectorStore';

describe('thoughtInspectorStore (FIN-03)', () => {
  beforeEach(() => {
    closeThoughtInspector();
  });

  it('初始状态为关闭，内容为空', () => {
    const state = useThoughtInspectorStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeMessageId).toBeNull();
    expect(state.activeTurnIndex).toBeNull();
    expect(state.content).toBe('');
    expect(state.searchQuery).toBe('');
  });

  it('openThoughtInspector 规范化开启模态并设置上下文', () => {
    openThoughtInspector({
      messageId: 'msg-123',
      turnIndex: 1,
      content: '正在推导算法逻辑...',
      title: '算法推导演算',
      durationSec: 3.5,
    });

    const state = useThoughtInspectorStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.activeMessageId).toBe('msg-123');
    expect(state.activeTurnIndex).toBe(1);
    expect(state.content).toBe('正在推导算法逻辑...');
    expect(state.title).toBe('算法推导演算');
    expect(state.durationSec).toBe(3.5);
  });

  it('setSearchQuery 正确更新检索词', () => {
    openThoughtInspector({
      messageId: 'msg-456',
      content: 'Hello world',
    });
    setSearchQuery('world');
    expect(useThoughtInspectorStore.getState().searchQuery).toBe('world');
  });

  it('closeThoughtInspector 关闭并完全重置状态', () => {
    openThoughtInspector({
      messageId: 'msg-789',
      content: 'Some thought',
    });
    setSearchQuery('search');
    expect(useThoughtInspectorStore.getState().isOpen).toBe(true);

    closeThoughtInspector();

    const state = useThoughtInspectorStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.activeMessageId).toBeNull();
    expect(state.content).toBe('');
    expect(state.searchQuery).toBe('');
  });
});
