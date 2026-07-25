import { describe, expect, it } from 'vitest';
import {
  afterCardRemovedFromGroup,
  createDefaultWorkspace,
  extractCardFromGroup,
  findGroupInWorkspace,
  pickActiveCardIndexAfterRemove,
} from './layoutHelpers';
import type { CardGroupState, WorkspaceState } from './types';

function toolGroup(
  id: string,
  cards: string[],
  activeCardId: string,
): CardGroupState {
  return {
    id,
    activeCardId,
    heightRatio: 1,
    cards: cards.map((cid) => ({ id: cid, title: cid })),
  };
}

/**
 * 构造带工具列的测试工作区。
 *
 * 治理防线 #3（noUncheckedIndexedAccess）：所有下标访问返回 T | undefined，
 * 用显式守卫替代 `ws!.columns[0]!.widthRatio = 0.6` 之类的链式非空断言。
 * 构造失败时直接抛错——测试夹具不应静默失败。
 */
function wsWithToolTabs(cards: string[], active: string): WorkspaceState {
  const ws = createDefaultWorkspace('ws-tab-test');
  ws.columns.push({
    id: `col-tools-${ws.id}`,
    widthRatio: 0.4,
    groups: [toolGroup('group-tools', cards, active)],
  });
  // chat 列收窄
  const chatCol = ws.columns[0];
  if (!chatCol) throw new Error('test fixture: default workspace missing chat column');
  chatCol.widthRatio = 0.6;
  return ws;
}

/**
 * 取工具列 group-tools；找不到直接抛错（测试夹具完整性约束）。
 * 用抛错替代链式 `!`，便于在夹具被改坏时立即定位。
 */
function getToolGroup(ws: WorkspaceState): CardGroupState {
  const toolCol = ws.columns[1];
  if (!toolCol) throw new Error('test fixture: tool column missing');
  const group = toolCol.groups[0];
  if (!group) throw new Error('test fixture: tool group missing');
  return group;
}

describe('pickActiveCardIndexAfterRemove', () => {
  it('空组返回 -1', () => {
    expect(pickActiveCardIndexAfterRemove(0, 0)).toBe(-1);
    expect(pickActiveCardIndexAfterRemove(0)).toBe(-1);
  });

  it('缺省 removedIndex 落到 0', () => {
    expect(pickActiveCardIndexAfterRemove(3)).toBe(0);
  });

  it('关中间项优先左侧邻居', () => {
    // cards [a,b,c] 去掉 index=1 → 剩 [a,c]，左侧邻居 a → 0
    expect(pickActiveCardIndexAfterRemove(2, 1)).toBe(0);
  });

  it('关首项落到新 0', () => {
    // cards [a,b,c] 去掉 0 → 剩 [b,c]，取 0
    expect(pickActiveCardIndexAfterRemove(2, 0)).toBe(0);
  });

  it('关末项落到左侧', () => {
    // cards [a,b,c] 去掉 2 → 剩 [a,b]，左侧 b → 1
    expect(pickActiveCardIndexAfterRemove(2, 2)).toBe(1);
  });
});

describe('afterCardRemovedFromGroup — 关 agent 不重开 chat', () => {
  it('关 agent 切到左侧工具 tab，不强制 chat', () => {
    const ws = wsWithToolTabs(['files', 'agent', 'terminal'], 'agent');
    const g = getToolGroup(ws);
    const removedIndex = g.cards.findIndex((c) => c.id === 'agent');
    g.cards = g.cards.filter((c) => c.id !== 'agent');
    afterCardRemovedFromGroup(ws, g, g.id, 'agent', removedIndex);

    expect(g.activeCardId).toBe('files');
    expect(g.cards.map((c) => c.id)).toEqual(['files', 'terminal']);
    // 主对话列仍只有 chat，未被复制
    const chatCol = ws.columns[0];
    if (!chatCol) throw new Error('chat column missing');
    const chatCards = chatCol.groups.flatMap((x) => x.cards.map((c) => c.id));
    expect(chatCards).toEqual(['chat']);
  });

  it('关唯一 agent 删除空组，不 ensure chat 进工具列', () => {
    const ws = wsWithToolTabs(['agent'], 'agent');
    const g = getToolGroup(ws);
    g.cards = [];
    afterCardRemovedFromGroup(ws, g, g.id, 'agent', 0);

    const toolCol = ws.columns[1];
    if (!toolCol) throw new Error('tool column missing after group removal');
    expect(toolCol.groups.some((x) => x.id === 'group-tools')).toBe(false);
    // chat 列未变
    const chatCol = ws.columns[0];
    if (!chatCol) throw new Error('chat column missing');
    const chatGroup = chatCol.groups[0];
    if (!chatGroup) throw new Error('chat group missing');
    expect(chatGroup.activeCardId).toBe('chat');
    expect(chatGroup.cards.map((c) => c.id)).toEqual(['chat']);
  });

  it('非 active 被关时不改 activeCardId', () => {
    const ws = wsWithToolTabs(['files', 'agent'], 'files');
    const g = getToolGroup(ws);
    g.cards = g.cards.filter((c) => c.id !== 'agent');
    afterCardRemovedFromGroup(ws, g, g.id, 'agent', 1);
    expect(g.activeCardId).toBe('files');
  });
});

describe('extractCardFromGroup / findGroupInWorkspace', () => {
  it('extract 返回 removedIndex 并 splice', () => {
    const ws = wsWithToolTabs(['overview', 'agent', 'diff'], 'agent');
    const extracted = extractCardFromGroup(ws, 'group-tools', 'agent');
    expect(extracted).not.toBeNull();
    if (!extracted) return; // 类型收窄：上方断言已确保非空
    expect(extracted.removedIndex).toBe(1);
    expect(extracted.sourceGroup.cards.map((c) => c.id)).toEqual([
      'overview',
      'diff',
    ]);
    expect(findGroupInWorkspace(ws, 'group-tools')?.groupIdx).toBe(0);
  });

  it('找不到 card / group 返回 null', () => {
    const ws = wsWithToolTabs(['files'], 'files');
    expect(extractCardFromGroup(ws, 'group-tools', 'missing')).toBeNull();
    expect(extractCardFromGroup(ws, 'no-such-group', 'files')).toBeNull();
    expect(findGroupInWorkspace(ws, 'no-such')).toBeNull();
  });
});
