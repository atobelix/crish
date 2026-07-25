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

function wsWithToolTabs(cards: string[], active: string): WorkspaceState {
  const ws = createDefaultWorkspace('ws-tab-test');
  ws.columns.push({
    id: `col-tools-${ws.id}`,
    widthRatio: 0.4,
    groups: [toolGroup('group-tools', cards, active)],
  });
  // chat 列收窄
  ws!.columns[0]!.widthRatio = 0.6;
  return ws;
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
    const g = ws!.columns[1]!.groups[0];
    const removedIndex = g!.cards.findIndex((c) => c.id === 'agent');
    g!.cards = g!.cards.filter((c) => c.id !== 'agent');
    afterCardRemovedFromGroup(ws, g!, g!.id, 'agent', removedIndex);

    expect(g!.activeCardId).toBe('files');
    expect(g!.cards.map((c) => c.id)).toEqual(['files', 'terminal']);
    // 主对话列仍只有 chat，未被复制
    const chatCards = ws!.columns[0]!.groups.flatMap((x) => x.cards.map((c) => c.id));
    expect(chatCards).toEqual(['chat']);
  });

  it('关唯一 agent 删除空组，不 ensure chat 进工具列', () => {
    const ws = wsWithToolTabs(['agent'], 'agent');
    const g = ws!.columns[1]!.groups[0];
    g!.cards = [];
    afterCardRemovedFromGroup(ws, g!, g!.id, 'agent', 0);

    expect(ws!.columns[1]!.groups.some((x) => x.id === 'group-tools')).toBe(false);
    // chat 列未变
    expect(ws!.columns[0]!.groups[0]!.activeCardId).toBe('chat');
    expect(ws!.columns[0]!.groups[0]!.cards.map((c) => c.id)).toEqual(['chat']);
  });

  it('非 active 被关时不改 activeCardId', () => {
    const ws = wsWithToolTabs(['files', 'agent'], 'files');
    const g = ws!.columns[1]!.groups[0];
    g!.cards = g!.cards.filter((c) => c.id !== 'agent');
    afterCardRemovedFromGroup(ws, g!, g!.id, 'agent', 1);
    expect(g!.activeCardId).toBe('files');
  });
});

describe('extractCardFromGroup / findGroupInWorkspace', () => {
  it('extract 返回 removedIndex 并 splice', () => {
    const ws = wsWithToolTabs(['overview', 'agent', 'diff'], 'agent');
    const extracted = extractCardFromGroup(ws, 'group-tools', 'agent');
    expect(extracted).toBeTruthy();
    expect(extracted!.removedIndex).toBe(1);
    expect(extracted!.sourceGroup.cards.map((c) => c.id)).toEqual(['overview', 'diff']);
    expect(findGroupInWorkspace(ws, 'group-tools')?.groupIdx).toBe(0);
  });

  it('找不到 card / group 返回 null', () => {
    const ws = wsWithToolTabs(['files'], 'files');
    expect(extractCardFromGroup(ws, 'group-tools', 'missing')).toBeNull();
    expect(extractCardFromGroup(ws, 'no-such-group', 'files')).toBeNull();
    expect(findGroupInWorkspace(ws, 'no-such')).toBeNull();
  });
});
