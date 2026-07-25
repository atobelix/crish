import { describe, it, expect } from 'vitest';
import { serializeLayout, deserializeLayout, saveLayoutToStorage, loadLayoutFromStorage } from './layoutSerializer';
import type { WorkspaceState } from '../store/types';

describe('serializeLayout', () => {
  it('单列单组', () => {
    const ws: WorkspaceState = {
      id: 'ws-0',
      columns: [{
        id: 'col-chat-ws-0',
        widthRatio: 1,
        groups: [{
          id: 'group-chat-ws-0',
          heightRatio: 1,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
        }],
      }],
    };

    const result = serializeLayout(ws);
    expect(result.version).toBe(1);
    expect(result.root.type).toBe('leaf');
    expect((result.root as any).panelType).toBe('chat');
  });

  it('双列均单组', () => {
    const ws: WorkspaceState = {
      id: 'ws-0',
      columns: [
        {
          id: 'col-chat-ws-0',
          widthRatio: 0.5,
          groups: [{
            id: 'group-chat-ws-0',
            heightRatio: 1,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: '对话' }],
          }],
        },
        {
          id: 'col-files-ws-0',
          widthRatio: 0.5,
          groups: [{
            id: 'group-files-ws-0',
            heightRatio: 1,
            activeCardId: 'files',
            cards: [{ id: 'files', title: '文件' }],
          }],
        },
      ],
    };

    const result = serializeLayout(ws);
    expect(result.root.type).toBe('branch');
    expect((result.root as any).direction).toBe('horizontal');
    expect((result.root as any).children).toHaveLength(2);
    expect((result.root as any).sizes[0]).toBe(0.5);
  });
});

describe('deserializeLayout', () => {
  it('恢复单列布局', () => {
    const data = {
      version: 1,
      root: { type: 'leaf' as const, panelType: 'chat', tabs: ['card-1'], activeTab: 'card-1' },
    };

    const result = deserializeLayout(data, 'ws-0');
    expect(result.id).toBe('ws-0');
    expect(result.columns).toHaveLength(1);
    expect(result.columns?.[0]?.groups[0]?.activeCardId).toBe('card-1');
    expect(result.columns?.[0]?.groups[0]?.cards).toHaveLength(1);
  });

  it('序列化再反序列化保持结构', () => {
    const ws: WorkspaceState = {
      id: 'ws-0',
      columns: [
        {
          id: 'col-chat-ws-0',
          widthRatio: 0.6,
          groups: [
            {
              id: 'group-chat-ws-0',
              heightRatio: 0.7,
              activeCardId: 'chat',
              cards: [{ id: 'chat', title: '对话' }, { id: 'agent', title: '聊天' }],
            },
            {
              id: 'group-terminal-ws-0',
              heightRatio: 0.3,
              activeCardId: 'terminal',
              cards: [{ id: 'terminal', title: '终端' }],
            },
          ],
        },
        {
          id: 'col-files-ws-0',
          widthRatio: 0.4,
          groups: [{
            id: 'group-files-ws-0',
            heightRatio: 1,
            activeCardId: 'files',
            cards: [{ id: 'files', title: '文件' }, { id: 'preview', title: '预览' }],
          }],
        },
      ],
    };

    const serialized = serializeLayout(ws);
    const restored = deserializeLayout(serialized, 'ws-0');
    expect(restored.id).toBe('ws-0');
    expect(restored.columns).toHaveLength(2);
    expect(restored.columns?.[0]?.groups).toHaveLength(2);
    expect(restored.columns?.[0]?.widthRatio).toBe(0.6);
    expect(restored.columns?.[0]?.groups[0]?.activeCardId).toBe('chat');
    expect(restored.columns?.[0]?.groups[0]?.cards.map((c) => c.id)).toEqual(['chat', 'agent']);
    expect(restored.columns?.[0]?.groups[1]?.activeCardId).toBe('terminal');
    expect(restored.columns?.[1]?.widthRatio).toBe(0.4);
    expect(restored.columns?.[1]?.groups[0]?.cards.map((c) => c.id)).toEqual(['files', 'preview']);
  });
});

describe('saveLayoutToStorage / loadLayoutFromStorage', () => {
  it('保存并恢复布局', () => {
    const ws: WorkspaceState = {
      id: 'ws-0',
      columns: [{
        id: 'col-chat-ws-0',
        widthRatio: 1,
        groups: [{
          id: 'group-chat-ws-0',
          heightRatio: 1,
          activeCardId: 'chat',
          cards: [{ id: 'chat', title: '对话' }],
        }],
      }],
    };

    saveLayoutToStorage(ws, 'test-crish-layout');
    const restored = loadLayoutFromStorage('ws-0', 'test-crish-layout');
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe('ws-0');
    expect(restored!.columns).toHaveLength(1);
  });
});
