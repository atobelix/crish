import { describe, it, expect } from 'vitest';
import { createLeaf, createBranch, isLeaf } from './types';
import type { LayoutNode } from './types';
import {
  findChatLeafBySessionId,
  listChatLeaves,
  listToolLeaves,
  findDuplicateSessionChatLeaves,
  hasChatLeafForSession,
  findUnitRootId,
  removeUnitBySessionId,
  dedupeDuplicateSessionChatLeaves,
} from './conversationUnit';
import type { LayoutTree } from './types';

describe('conversationUnit — list / find / has', () => {
  it('listChatLeaves 仅返回 chat 域叶子', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool = createLeaf('terminal', ['terminal'], 'terminal');
    const root = createBranch('horizontal', chat, tool, 0.6);

    const chats = listChatLeaves(root);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.id).toBe(chat.id);
    expect(chats[0]!.sessionId).toBe('s1');
  });

  it('listToolLeaves 返回非 chat 叶子', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const diff = createLeaf('diff', ['diff'], 'diff');
    const files = createLeaf('files', ['files'], 'files');
    const toolBranch = createBranch('vertical', diff, files, 0.5);
    const root = createBranch('horizontal', chat, toolBranch, 0.6);

    const tools = listToolLeaves(root);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.panelId).sort()).toEqual(['diff', 'files']);
  });

  it('findChatLeafBySessionId 命中绑定 session 的 leaf', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const c2 = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const root = createBranch('horizontal', c1, c2, 0.5);

    const found = findChatLeafBySessionId(root, 'sess-b');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(c2.id);
  });

  it('findChatLeafBySessionId 无匹配返回 null', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(findChatLeafBySessionId(chat, 'missing')).toBeNull();
  });

  it('findChatLeafBySessionId 空 sessionId 返回 null', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(findChatLeafBySessionId(chat, '')).toBeNull();
  });

  it('hasChatLeafForSession 反映绑定存在性', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(hasChatLeafForSession(chat, 's1')).toBe(true);
    expect(hasChatLeafForSession(chat, 's2')).toBe(false);
  });

  it('未绑定 sessionId 的 chat leaf 不参与 find', () => {
    const unbound = createLeaf('chat');
    expect(unbound.sessionId).toBeUndefined();
    expect(findChatLeafBySessionId(unbound, 'any')).toBeNull();
    expect(hasChatLeafForSession(unbound, 'any')).toBe(false);
  });
});

describe('conversationUnit — findDuplicateSessionChatLeaves', () => {
  it('无重复时返回空 Map', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const root = createBranch('horizontal', c1, c2, 0.5);

    const dups = findDuplicateSessionChatLeaves(root);
    expect(dups.size).toBe(0);
  });

  it('同一 sessionId 多个 chat leaf → 归入 Map', () => {
    const a1 = createLeaf('chat', ['chat'], 'chat', 'dup-sess');
    const a2 = createLeaf('chat', ['chat'], 'chat', 'dup-sess');
    const other = createLeaf('chat', ['chat'], 'chat', 'unique');
    // (a1 | a2) | other
    const pair = createBranch('horizontal', a1, a2, 0.5);
    const root = createBranch('horizontal', pair, other, 0.5);

    const dups = findDuplicateSessionChatLeaves(root);
    expect(dups.size).toBe(1);
    expect(dups.has('dup-sess')).toBe(true);
    const leaves = dups.get('dup-sess')!;
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(dups.has('unique')).toBe(false);
  });

  it('无 sessionId 的 chat 不进入 Map', () => {
    const u1 = createLeaf('chat');
    const u2 = createLeaf('chat');
    const root = createBranch('horizontal', u1, u2, 0.5);
    expect(findDuplicateSessionChatLeaves(root).size).toBe(0);
  });

  it('重复时 findChatLeafBySessionId 返回先序第一个', () => {
    const first = createLeaf('chat', ['chat'], 'chat', 's');
    const second = createLeaf('chat', ['chat'], 'chat', 's');
    const root = createBranch('horizontal', first, second, 0.5);

    const found = findChatLeafBySessionId(root, 's');
    expect(found!.id).toBe(first.id);
  });
});

describe('conversationUnit — findUnitRootId', () => {
  it('dock 折叠：仅 chat leaf → unit root = chat leaf id', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(findUnitRootId(chat, 's1')).toBe(chat.id);
  });

  it('标准 unit：H(chat | tool leaf) → unit root = 父 branch id', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool = createLeaf('terminal', ['terminal'], 'terminal');
    const unit = createBranch('horizontal', chat, tool, 0.62);

    expect(findUnitRootId(unit, 's1')).toBe(unit.id);
  });

  it('标准 unit：H(chat | tool 子树) → unit root = 父 branch id', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const diff = createLeaf('diff', ['diff'], 'diff');
    const files = createLeaf('files', ['files'], 'files');
    const toolSubtree = createBranch('vertical', diff, files, 0.5);
    const unit = createBranch('horizontal', chat, toolSubtree, 0.62);

    expect(findUnitRootId(unit, 's1')).toBe(unit.id);
  });

  it('标准 unit：H(tool | chat) 顺序反转仍识别', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool = createLeaf('overview', ['overview'], 'overview');
    const unit = createBranch('horizontal', tool, chat, 0.4);

    expect(findUnitRootId(unit, 's1')).toBe(unit.id);
  });

  it('垂直分割不算 unit：V(chat | tool) → 回退 chat leaf id', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool = createLeaf('terminal', ['terminal'], 'terminal');
    const root = createBranch('vertical', chat, tool, 0.5);

    expect(findUnitRootId(root, 's1')).toBe(chat.id);
  });

  it('两 chat 水平分屏：各自 unit root = 自身 leaf id', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const root = createBranch('horizontal', c1, c2, 0.5);

    expect(findUnitRootId(root, 's1')).toBe(c1.id);
    expect(findUnitRootId(root, 's2')).toBe(c2.id);
  });

  it('多 unit：各 session 的 H(chat|tool) 嵌套在更大树中', () => {
    // unit1 = H(chat1 | tool1), unit2 = H(chat2 | tool2)
    // root = H(unit1 | unit2)
    const chat1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool1 = createLeaf('terminal', ['terminal'], 'terminal');
    const unit1 = createBranch('horizontal', chat1, tool1, 0.6);

    const chat2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tool2 = createLeaf('files', ['files'], 'files');
    const unit2 = createBranch('horizontal', chat2, tool2, 0.6);

    const root = createBranch('horizontal', unit1, unit2, 0.5);

    expect(findUnitRootId(root, 's1')).toBe(unit1.id);
    expect(findUnitRootId(root, 's2')).toBe(unit2.id);
  });

  it('session 不存在 → null', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(findUnitRootId(chat, 'missing')).toBeNull();
  });

  it('H(chat | chat) 兄弟也是 chat → 回退 leaf id', () => {
    // 一侧不是 tool 域
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const otherChat = createLeaf('chat', ['chat'], 'chat', 's2');
    const root = createBranch('horizontal', chat, otherChat, 0.5);
    expect(findUnitRootId(root, 's1')).toBe(chat.id);
  });
});

describe('conversationUnit — pure / no mutation', () => {
  it('查询不修改输入树', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool = createLeaf('diff', ['diff'], 'diff');
    const root: LayoutNode = createBranch('horizontal', chat, tool, 0.5);
    const before = JSON.stringify(root);

    void findChatLeafBySessionId(root, 's1');
    void listChatLeaves(root);
    void listToolLeaves(root);
    void hasChatLeafForSession(root, 's1');
    void findDuplicateSessionChatLeaves(root);
    void findUnitRootId(root, 's1');

    expect(JSON.stringify(root)).toBe(before);
    expect(isLeaf(chat)).toBe(true);
  });
});

describe('conversationUnit — removeUnitBySessionId', () => {
  it('两 unit 并排：关闭 s1 只保留 s2 整 unit', () => {
    const chat1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const tool1 = createLeaf('terminal', ['terminal'], 'terminal');
    const unit1 = createBranch('horizontal', chat1, tool1, 0.6);

    const chat2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tool2 = createLeaf('files', ['files'], 'files');
    const unit2 = createBranch('horizontal', chat2, tool2, 0.6);

    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', unit1, unit2, 0.5),
    };

    const next = removeUnitBySessionId(tree, 's1');
    expect(findChatLeafBySessionId(next.root, 's1')).toBeNull();
    expect(findChatLeafBySessionId(next.root, 's2')?.id).toBe(chat2.id);
    // s2 unit 的 tool 仍在
    expect(listToolLeaves(next.root).map((t) => t.panelId)).toContain('files');
    expect(listChatLeaves(next.root)).toHaveLength(1);
  });

  it('仅 chat leaf unit：移除后邻居 promote', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    };
    const next = removeUnitBySessionId(tree, 's1');
    expect(next.root.id).toBe(c2.id);
    expect(findChatLeafBySessionId(next.root, 's2')?.id).toBe(c2.id);
  });

  it('unit 占满 root：退化为未绑定单 chat', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 'only');
    const tool = createLeaf('diff', ['diff'], 'diff');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', chat, tool, 0.62),
    };
    const next = removeUnitBySessionId(tree, 'only');
    expect(isLeaf(next.root)).toBe(true);
    expect(listChatLeaves(next.root)).toHaveLength(1);
    expect(findChatLeafBySessionId(next.root, 'only')).toBeNull();
  });

  it('session 不存在：原样返回', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const tree: LayoutTree = { version: 2, root: chat };
    expect(removeUnitBySessionId(tree, 'missing')).toBe(tree);
  });
});

describe('conversationUnit — dedupeDuplicateSessionChatLeaves', () => {
  it('保留先序第一个，移除同 session 多余 chat leaf', () => {
    const a1 = createLeaf('chat', ['chat'], 'chat', 'dup');
    const a2 = createLeaf('chat', ['chat'], 'chat', 'dup');
    const other = createLeaf('chat', ['chat'], 'chat', 'ok');
    const pair = createBranch('horizontal', a1, a2, 0.5);
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', pair, other, 0.5),
    };

    const next = dedupeDuplicateSessionChatLeaves(tree);
    const dups = findDuplicateSessionChatLeaves(next.root);
    expect(dups.size).toBe(0);
    expect(findChatLeafBySessionId(next.root, 'dup')?.id).toBe(a1.id);
    expect(findChatLeafBySessionId(next.root, 'ok')?.id).toBe(other.id);
    expect(listChatLeaves(next.root)).toHaveLength(2);
  });

  it('无重复时返回同一引用', () => {
    const c1 = createLeaf('chat', ['chat'], 'chat', 's1');
    const c2 = createLeaf('chat', ['chat'], 'chat', 's2');
    const tree: LayoutTree = {
      version: 2,
      root: createBranch('horizontal', c1, c2, 0.5),
    };
    expect(dedupeDuplicateSessionChatLeaves(tree)).toBe(tree);
  });
});
