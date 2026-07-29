/**
 * planSessionCanvasDrop 纯决策单测 — 保证会话拖放不 clone chat leaf。
 */
import { describe, it, expect } from 'vitest';
import { createLeaf, createBranch } from '../../store/layout-tree/types';
import type { LayoutNode } from '../../store/layout-tree/types';
import { moveLeaf, collectLeaves } from '../../store/layout-tree/operations';
import { findChatLeafBySessionId, listChatLeaves } from '../../store/layout-tree';
import { planSessionCanvasDrop } from './useTopBarDrag';
import type { DropZone } from '../../store/layout-tree';

function splitZone(
  type: 'split-left' | 'split-right' | 'split-top' | 'split-bottom',
  targetLeafId: string
): DropZone {
  return { type, targetLeafId, confidence: 1 };
}

describe('planSessionCanvasDrop', () => {
  it('尚无 leaf → create', () => {
    const target = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const plan = planSessionCanvasDrop(
      target,
      'sess-b',
      splitZone('split-right', target.id)
    );
    expect(plan).toEqual({
      action: 'create',
      targetLeafId: target.id,
      direction: 'right',
      targetNeedsShellBind: false,
    });
  });

  it('目标无 session 时 create 标记 targetNeedsShellBind', () => {
    const target = createLeaf('chat', ['chat'], 'chat');
    const plan = planSessionCanvasDrop(
      target,
      'sess-new',
      splitZone('split-left', target.id)
    );
    expect(plan.action).toBe('create');
    if (plan.action === 'create') {
      expect(plan.targetNeedsShellBind).toBe(true);
      expect(plan.direction).toBe('left');
    }
  });

  it('已有 leaf 且落点为自身 → activate（不 clone）', () => {
    const leaf = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const plan = planSessionCanvasDrop(
      leaf,
      'sess-a',
      splitZone('split-right', leaf.id)
    );
    expect(plan).toEqual({ action: 'activate', leafId: leaf.id });
  });

  it('已有 leaf 在别处 → move 到目标旁', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const root = createBranch('horizontal', a, b, 0.5);

    const plan = planSessionCanvasDrop(
      root,
      'sess-a',
      splitZone('split-bottom', b.id)
    );
    expect(plan).toEqual({
      action: 'move',
      sourceLeafId: a.id,
      targetLeafId: b.id,
      direction: 'bottom',
    });
  });

  it('已在正确侧（相邻）→ activate，不 move', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    // a | b  — a 已在 b 的左侧
    const root = createBranch('horizontal', a, b, 0.5);

    const plan = planSessionCanvasDrop(
      root,
      'sess-a',
      splitZone('split-left', b.id)
    );
    expect(plan).toEqual({ action: 'activate', leafId: a.id });
  });

  it('已在右侧相邻 → split-right 仍 activate', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    // a | b — b 已在 a 的右侧
    const root = createBranch('horizontal', a, b, 0.5);

    const plan = planSessionCanvasDrop(
      root,
      'sess-b',
      splitZone('split-right', a.id)
    );
    expect(plan).toEqual({ action: 'activate', leafId: b.id });
  });

  it('目标 leaf 已绑定同 session → activate（不 clone）', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const root = createBranch('horizontal', a, b, 0.5);

    const plan = planSessionCanvasDrop(
      root,
      'sess-a',
      splitZone('split-right', b.id)
    );
    // findChatLeafBySessionId 命中 a；目标 b 也是 sess-a → activate a
    expect(plan.action).toBe('activate');
    if (plan.action === 'activate') {
      expect(plan.leafId).toBe(a.id);
    }
  });

  it('垂直相邻 top → activate', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    // a / b — a 在 b 上方
    const root = createBranch('vertical', a, b, 0.5);

    const plan = planSessionCanvasDrop(
      root,
      'sess-a',
      splitZone('split-top', b.id)
    );
    expect(plan).toEqual({ action: 'activate', leafId: a.id });
  });

  it('已有 leaf 拖到第三 chat 旁 → move（不 create 第三份）', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const c = createLeaf('chat', ['chat'], 'chat', 'sess-c');
    const left = createBranch('horizontal', a, b, 0.5);
    const root = createBranch('horizontal', left, c, 0.66);

    const plan = planSessionCanvasDrop(
      root,
      'sess-a',
      splitZone('split-left', c.id)
    );
    expect(plan).toEqual({
      action: 'move',
      sourceLeafId: a.id,
      targetLeafId: c.id,
      direction: 'left',
    });
  });

  it('非 split zone → none', () => {
    const leaf = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const plan = planSessionCanvasDrop(leaf, 'sess-a', {
      type: 'merge-tab',
      targetLeafId: leaf.id,
      confidence: 1,
      targetTabId: 'x',
    });
    expect(plan).toEqual({ action: 'none' });
  });

  it('目标不是 chat leaf → none', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const tool = createLeaf('terminal', ['terminal'], 'terminal');
    const root = createBranch('horizontal', chat, tool, 0.6);
    const plan = planSessionCanvasDrop(
      root,
      'sess-b',
      splitZone('split-right', tool.id)
    );
    expect(plan).toEqual({ action: 'none' });
  });
});

describe('session drag moveLeaf 不丢失 session 且不 clone', () => {
  it('move 后仍只有一个 sess-a leaf，绑定保留', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const root: LayoutNode = createBranch('horizontal', a, b, 0.5);
    const tree = { root, version: 2 };

    const plan = planSessionCanvasDrop(
      tree.root,
      'sess-a',
      splitZone('split-bottom', b.id)
    );
    expect(plan.action).toBe('move');
    if (plan.action !== 'move') return;

    const after = moveLeaf(
      tree,
      plan.sourceLeafId,
      plan.targetLeafId,
      plan.direction
    );

    const chats = listChatLeaves(after.root);
    expect(chats).toHaveLength(2);
    const moved = findChatLeafBySessionId(after.root, 'sess-a');
    expect(moved).not.toBeNull();
    expect(moved!.id).toBe(a.id);
    expect(moved!.sessionId).toBe('sess-a');
    // 仍恰好一个 sess-a
    expect(chats.filter((l) => l.sessionId === 'sess-a')).toHaveLength(1);
    expect(collectLeaves(after.root)).toHaveLength(2);
  });

  it('move 到第三 leaf 旁后仍恰好一个 sess-a', () => {
    const a = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const b = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const c = createLeaf('chat', ['chat'], 'chat', 'sess-c');
    const left = createBranch('horizontal', a, b, 0.5);
    const root: LayoutNode = createBranch('horizontal', left, c, 0.66);
    const tree = { root, version: 2 };

    const plan = planSessionCanvasDrop(
      tree.root,
      'sess-a',
      splitZone('split-bottom', c.id)
    );
    expect(plan.action).toBe('move');
    if (plan.action !== 'move') return;

    const after = moveLeaf(
      tree,
      plan.sourceLeafId,
      plan.targetLeafId,
      plan.direction
    );

    const chats = listChatLeaves(after.root);
    expect(chats).toHaveLength(3);
    expect(chats.filter((l) => l.sessionId === 'sess-a')).toHaveLength(1);
    expect(findChatLeafBySessionId(after.root, 'sess-a')!.id).toBe(a.id);
  });
});
