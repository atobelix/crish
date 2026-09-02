import { describe, it, expect } from 'vitest';
import { createLeaf, createBranch, isLeaf, LAYOUT_TREE_VERSION } from './types';
import type { LayoutNode, LayoutTree } from './types';
import { createSessionTab, createDraftTab } from './sessionTabModel';
import {
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
  findDuplicateSessionChatLeaves,
  hasChatLeafForSession,
  dedupeDuplicateSessionChatLeaves,
} from './conversationUnit';

function chatLeaf(sessionId: string, id?: string) {
  return createLeaf({
    id,
    tabs: [createSessionTab({ sessionId, tabId: `tab-${sessionId}` })],
  });
}

describe('conversationUnit — list / find / has', () => {
  it('listChatLeaves 返回全部 chat 叶', () => {
    const c1 = chatLeaf('s1', 'A');
    const c2 = chatLeaf('s2', 'B');
    const root = createBranch('horizontal', c1, c2, 0.5);
    const chats = listChatLeaves(root);
    expect(chats).toHaveLength(2);
  });

  it('listToolLeaves 在 v3 合法树上为空', () => {
    const root = createBranch(
      'horizontal',
      chatLeaf('s1'),
      chatLeaf('s2'),
      0.5
    );
    expect(listToolLeaves(root)).toHaveLength(0);
  });

  it('findChatLeafBySessionId 命中 tabs[].sessionId', () => {
    const c1 = chatLeaf('sess-a', 'A');
    const c2 = chatLeaf('sess-b', 'B');
    const root = createBranch('horizontal', c1, c2, 0.5);
    const found = findChatLeafBySessionId(root, 'sess-b');
    expect(found?.id).toBe('B');
  });

  it('findChatLeafBySessionId 空 / 无匹配 → null', () => {
    const chat = chatLeaf('s1');
    expect(findChatLeafBySessionId(chat, 'missing')).toBeNull();
    expect(findChatLeafBySessionId(chat, '')).toBeNull();
  });

  it('hasChatLeafForSession 反映 tabs 绑定', () => {
    const chat = chatLeaf('s1');
    expect(hasChatLeafForSession(chat, 's1')).toBe(true);
    expect(hasChatLeafForSession(chat, 's2')).toBe(false);
  });

  it('draft 叶不匹配真实 session', () => {
    const unbound = createLeaf();
    expect(findChatLeafBySessionId(unbound, 'any')).toBeNull();
  });
});

describe('conversationUnit — findDuplicateSessionChatLeaves', () => {
  it('无重复时返回空 Map', () => {
    const root = createBranch(
      'horizontal',
      chatLeaf('s1'),
      chatLeaf('s2'),
      0.5
    );
    expect(findDuplicateSessionChatLeaves(root).size).toBe(0);
  });

  it('同一 sessionId 多个 chat leaf → 归入 Map', () => {
    const a1 = chatLeaf('dup-sess', 'a1');
    const a2 = chatLeaf('dup-sess', 'a2');
    const other = chatLeaf('unique', 'ok');
    const pair = createBranch('horizontal', a1, a2, 0.5);
    const root = createBranch('horizontal', pair, other, 0.5);
    const dups = findDuplicateSessionChatLeaves(root);
    expect(dups.size).toBe(1);
    expect(dups.get('dup-sess')!.map((l) => l.id).sort()).toEqual(
      ['a1', 'a2'].sort()
    );
  });

  it('两个不同 draft 不算重复', () => {
    const root = createBranch(
      'horizontal',
      createLeaf({ tabs: [createDraftTab()] }),
      createLeaf({ tabs: [createDraftTab()] }),
      0.5
    );
    expect(findDuplicateSessionChatLeaves(root).size).toBe(0);
  });

  it('重复时 findChatLeafBySessionId 返回先序第一个', () => {
    const first = chatLeaf('s', 'first');
    const second = chatLeaf('s', 'second');
    const root = createBranch('horizontal', first, second, 0.5);
    expect(findChatLeafBySessionId(root, 's')!.id).toBe('first');
  });
});

describe('conversationUnit — pure / no mutation', () => {
  it('查询不修改输入树', () => {
    const root: LayoutNode = createBranch(
      'horizontal',
      chatLeaf('s1'),
      chatLeaf('s2'),
      0.5
    );
    const before = JSON.stringify(root);
    void findChatLeafBySessionId(root, 's1');
    void listChatLeaves(root);
    void listToolLeaves(root);
    void hasChatLeafForSession(root, 's1');
    void findDuplicateSessionChatLeaves(root);
    expect(JSON.stringify(root)).toBe(before);
    expect(isLeaf(chatLeaf('x'))).toBe(true);
  });
});

describe('conversationUnit — dedupeDuplicateSessionChatLeaves', () => {
  it('保留先序第一个 tab，另一叶若空则 prune', () => {
    const a1 = chatLeaf('dup', 'a1');
    const a2 = chatLeaf('dup', 'a2');
    const other = chatLeaf('ok', 'ok');
    const pair = createBranch('horizontal', a1, a2, 0.5);
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: createBranch('horizontal', pair, other, 0.5),
    };
    const next = dedupeDuplicateSessionChatLeaves(tree);
    expect(findDuplicateSessionChatLeaves(next.root).size).toBe(0);
    expect(findChatLeafBySessionId(next.root, 'dup')?.id).toBe('a1');
    expect(findChatLeafBySessionId(next.root, 'ok')?.id).toBe('ok');
    expect(listChatLeaves(next.root)).toHaveLength(2);
  });

  it('无重复时返回同一引用', () => {
    const tree: LayoutTree = {
      version: LAYOUT_TREE_VERSION,
      root: createBranch(
        'horizontal',
        chatLeaf('s1'),
        chatLeaf('s2'),
        0.5
      ),
    };
    expect(dedupeDuplicateSessionChatLeaves(tree)).toBe(tree);
  });
});
