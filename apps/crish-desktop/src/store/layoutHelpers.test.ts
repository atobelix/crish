/**
 * layoutHelpers 纯函数单测：不碰 layoutStore / zustand。
 * 覆盖：面板放置、焦点、空工作区收尾、split 边缘几何。
 */
import { describe, expect, it } from 'vitest';
import {
  adjustSameGroupReorderIndex,
  afterCardRemovedFromGroup,
  appendTerminalLine,
  clampToolTargetColIdx,
  columnInsertIndexForSplit,
  countWorkspaceCards,
  createDefaultWorkspace,
  ensureChatColumn,
  ensureToolColumn,
  extractCardFromGroup,
  filterEmptyColumnsKeepingChat,
  findCardInWorkspace,
  findGroupInWorkspace,
  focusCardInWorkspace,
  getPanelTitle,
  groupInsertIndexForSplit,
  insertCardIntoGroup,
  isChatColumn,
  isChatOnlyWorkspace,
  isRedundantColumnSplit,
  isRedundantGroupSplit,
  makePanelCard,
  makePanelGroup,
  collapseToolColumnToTabs,
  normalizeColumnWidths,
  pickActiveCardIndexAfterRemove,
  placePanelCard,
  pruneEmptyGroupsInColumn,
  pruneEmptyWorkspaceLayout,
  rebalanceGroupHeights,
  removePanelCard,
  resolveSplitEdgeFromPoint,
  resolveWorkspacePanelKey,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
  upsertDiffFile,
  DIFF_LIST_MAX,
} from './layoutHelpers';
import type { CardGroupState, FileDiff, WorkspaceState } from './types';

// ── fixtures ────────────────────────────────────────────────────────────────

function toolGroup(
  id: string,
  cards: string[],
  activeCardId: string,
  heightRatio = 1,
): CardGroupState {
  return {
    id,
    activeCardId,
    heightRatio,
    cards: cards.map((cid) => makePanelCard(cid)),
  };
}

function wsWithToolTabs(cards: string[], active: string): WorkspaceState {
  const ws = createDefaultWorkspace('ws-helpers');
  ws.columns.push({
    id: `col-tools-${ws.id}`,
    widthRatio: 0.4,
    groups: [toolGroup('group-tools', cards, active)],
  });
  ws!.columns[0]!.widthRatio = 0.6;
  return ws;
}

function bareChatWs(id = 'ws-bare'): WorkspaceState {
  return {
    id,
    columns: [
      {
        id: `col-chat-${id}`,
        widthRatio: 1,
        groups: [makePanelGroup('chat', id, { groupId: `group-chat-${id}` })],
      },
    ],
  };
}

// ── titles / panel keys ─────────────────────────────────────────────────────

describe('getPanelTitle / resolveWorkspacePanelKey / makePanelCard', () => {
  it('maps known panels and falls back to id', () => {
    expect(getPanelTitle('terminal')).toBe('终端');
    expect(getPanelTitle('chat')).toBe('对话');
    expect(getPanelTitle('unknown-x')).toBe('unknown-x');
  });

  it('resolves browser→preview, plan→tasks; floats return null', () => {
    expect(resolveWorkspacePanelKey('browser')).toBe('preview');
    expect(resolveWorkspacePanelKey('plan')).toBe('tasks');
    expect(resolveWorkspacePanelKey('settings')).toBeNull();
    expect(resolveWorkspacePanelKey('runtime')).toBeNull();
    expect(resolveWorkspacePanelKey('')).toBeNull();
    expect(resolveWorkspacePanelKey(null)).toBeNull();
    expect(resolveWorkspacePanelKey('  terminal  ')).toBe('terminal');
  });

  it('makePanelCard / makePanelGroup carry titles', () => {
    expect(makePanelCard('diff')).toEqual({ id: 'diff', title: '变更' });
    const g = makePanelGroup('files', 'ws-1', { groupId: 'g1', heightRatio: 0.5 });
    expect(g.id).toBe('g1');
    expect(g.activeCardId).toBe('files');
    expect(g.heightRatio).toBe(0.5);
    expect(g!.cards[0]!.title).toBe('文件');
  });

  it('agent side panel title is 聊天 (not Agent)', () => {
    expect(getPanelTitle('agent')).toBe('聊天');
    expect(makePanelCard('agent').title).toBe('聊天');
  });
});

// ── geometry / empty workspace ──────────────────────────────────────────────

describe('normalize / rebalance / empty workspace', () => {
  it('normalizeColumnWidths sums to 1 and repairs non-positive ratios', () => {
    const ws = bareChatWs();
    ws.columns.push({
      id: 'col-tools-x',
      widthRatio: 0,
      groups: [toolGroup('g', ['diff'], 'diff')],
    });
    ws!.columns[0]!.widthRatio = -1;
    normalizeColumnWidths(ws);
    const sum = ws.columns.reduce((a, c) => a + c.widthRatio, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(ws.columns.every((c) => c.widthRatio > 0)).toBe(true);
  });

  it('rebalanceGroupHeights even split', () => {
    const col = {
      id: 'c',
      widthRatio: 1,
      groups: [
        toolGroup('a', ['diff'], 'diff', 0.9),
        toolGroup('b', ['tasks'], 'tasks', 0.1),
      ],
    };
    rebalanceGroupHeights(col);
    expect(col!.groups[0]!.heightRatio).toBeCloseTo(0.5);
    expect(col!.groups[1]!.heightRatio).toBeCloseTo(0.5);
  });

  it('isChatOnlyWorkspace / countWorkspaceCards', () => {
    const empty = bareChatWs();
    expect(isChatOnlyWorkspace(empty)).toBe(true);
    expect(countWorkspaceCards(empty)).toBe(1);
    expect(isChatColumn(empty.columns[0]!)).toBe(true);

    const tools = wsWithToolTabs(['agent'], 'agent');
    expect(isChatOnlyWorkspace(tools)).toBe(false);
    expect(countWorkspaceCards(tools)).toBe(2);
  });

  it('pruneEmptyGroupsInColumn + pruneEmptyWorkspaceLayout drops shells', () => {
    const ws = bareChatWs();
    ws.columns.push({
      id: 'col-tools-empty',
      widthRatio: 0.3,
      groups: [
        { id: 'empty-g', activeCardId: '', cards: [], heightRatio: 1 },
        toolGroup('keep', ['terminal'], 'terminal', 1),
      ],
    });
    // strip the keeper so whole tool col becomes empty after prune
    ws!.columns[1]!.groups[1]!.cards = [];
    pruneEmptyWorkspaceLayout(ws, true);
    expect(ws.columns.every((c) => isChatColumn(c) || c.groups.length > 0)).toBe(true);
    expect(ws.columns.some((c) => isChatColumn(c))).toBe(true);
    // empty tool col removed
    expect(ws.columns.some((c) => c.id === 'col-tools-empty')).toBe(false);
  });

  it('filterEmptyColumnsKeepingChat keeps chat even if groups empty', () => {
    const ws: WorkspaceState = {
      id: 'ws-e',
      columns: [
        { id: 'col-chat-ws-e', widthRatio: 0.5, groups: [] },
        { id: 'col-tools', widthRatio: 0.5, groups: [] },
      ],
    };
    filterEmptyColumnsKeepingChat(ws, true);
    expect(ws.columns).toHaveLength(1);
    expect(isChatColumn(ws.columns[0]!)).toBe(true);
  });

  it('pruneEmptyGroupsInColumn returns false when nothing removed', () => {
    const col = {
      id: 'c',
      widthRatio: 1,
      groups: [toolGroup('g', ['diff'], 'diff')],
    };
    expect(pruneEmptyGroupsInColumn(col)).toBe(false);
  });
});

// ── find / focus ────────────────────────────────────────────────────────────

describe('findCardInWorkspace / focusCardInWorkspace', () => {
  it('locates card with indices and focuses it', () => {
    const ws = wsWithToolTabs(['files', 'agent', 'terminal'], 'files');
    const loc = findCardInWorkspace(ws, 'agent');
    expect(loc).toMatchObject({
      colIdx: 1,
      groupIdx: 0,
      cardIdx: 1,
    });
    expect(loc!.card.id).toBe('agent');

    expect(focusCardInWorkspace(ws, 'agent')).toBe(true);
    expect(ws!.columns[1]!.groups[0]!.activeCardId).toBe('agent');
    expect(focusCardInWorkspace(ws, 'missing')).toBe(false);
  });

  it('findGroupInWorkspace null for unknown', () => {
    const ws = bareChatWs();
    expect(findGroupInWorkspace(ws, 'nope')).toBeNull();
    expect(findCardInWorkspace(ws, 'chat')?.groupIdx).toBe(0);
  });
});

// ── placement ───────────────────────────────────────────────────────────────

describe('placePanelCard / removePanelCard / ensureToolColumn', () => {
  it('places tool beside chat and focuses on second open', () => {
    const ws = bareChatWs();
    expect(isChatOnlyWorkspace(ws)).toBe(true);

    expect(placePanelCard(ws, 'terminal', { stamp: 1 })).toBe('placed');
    expect(ws.columns.length).toBe(2);
    expect(findCardInWorkspace(ws, 'terminal')).toBeTruthy();
    expect(isChatOnlyWorkspace(ws)).toBe(false);

    // already there → focus only
    ws!.columns[1]!.groups[0]!.activeCardId = 'something-else' as string;
    // force non-active: put a second card then switch
    ws!.columns[1]!.groups[0]!.cards.push(makePanelCard('diff'));
    ws!.columns[1]!.groups[0]!.activeCardId = 'diff';
    expect(placePanelCard(ws, 'terminal')).toBe('focused');
    expect(ws!.columns[1]!.groups[0]!.activeCardId).toBe('terminal');
  });

  it('browser key opens preview; settings/runtime skipped', () => {
    const ws = bareChatWs();
    expect(placePanelCard(ws, 'browser', { stamp: 2 })).toBe('placed');
    expect(findCardInWorkspace(ws, 'preview')).toBeTruthy();

    const before = countWorkspaceCards(ws);
    expect(placePanelCard(ws, 'settings')).toBe('skipped');
    expect(placePanelCard(ws, 'runtime')).toBe('skipped');
    expect(placePanelCard(ws, 'chat')).toBe('skipped');
    expect(countWorkspaceCards(ws)).toBe(before);
  });

  it('tabMode merges into first tool group', () => {
    const ws = bareChatWs();
    placePanelCard(ws, 'diff', { stamp: 10 });
    expect(placePanelCard(ws, 'tasks', { tabMode: true, stamp: 11 })).toBe('placed');
    const tool = ws.columns.find((c) => !isChatColumn(c))!;
    expect(tool.groups).toHaveLength(1);
    expect(tool!.groups[0]!.cards.map((c) => c.id)).toEqual(['diff', 'tasks']);
    expect(tool!.groups[0]!.activeCardId).toBe('tasks');
  });

  it('tabMode collapses stacked groups then merges', () => {
    const ws = bareChatWs();
    // 非 tab 模式：堆叠两个 group
    placePanelCard(ws, 'diff', { stamp: 20, tabMode: false });
    placePanelCard(ws, 'files', { stamp: 21, tabMode: false });
    const tool0 = ws.columns.find((c) => !isChatColumn(c))!;
    expect(tool0.groups.length).toBeGreaterThanOrEqual(2);

    expect(placePanelCard(ws, 'terminal', { stamp: 22, tabMode: true })).toBe('placed');
    const tool = ws.columns.find((c) => !isChatColumn(c))!;
    expect(tool.groups).toHaveLength(1);
    expect(tool!.groups[0]!.cards.map((c) => c.id)).toEqual(
      expect.arrayContaining(['diff', 'files', 'terminal']),
    );
    expect(tool!.groups[0]!.activeCardId).toBe('terminal');
  });

  it('collapseToolColumnToTabs merges multi-group tool col', () => {
    const ws = wsWithToolTabs(['diff'], 'diff');
    const tool = ws.columns.find((c) => !isChatColumn(c))!;
    tool.groups.push({
      id: 'g2',
      activeCardId: 'files',
      heightRatio: 0.5,
      cards: [makePanelCard('files')],
    });
    tool!.groups[0]!.heightRatio = 0.5;
    expect(collapseToolColumnToTabs(ws)).toBe(true);
    expect(tool.groups).toHaveLength(1);
    expect(tool!.groups[0]!.cards.map((c) => c.id)).toEqual(['diff', 'files']);
    expect(collapseToolColumnToTabs(ws)).toBe(false);
  });

  it('plan key places tasks card', () => {
    const ws = bareChatWs();
    expect(placePanelCard(ws, 'plan', { stamp: 3 })).toBe('placed');
    expect(findCardInWorkspace(ws, 'tasks')).toBeTruthy();
  });

  it('removePanelCard uses left-neighbor active and prunes empty col', () => {
    const ws = wsWithToolTabs(['files', 'agent'], 'agent');
    expect(removePanelCard(ws, 'agent')).toBe(true);
    const tools = ws.columns.find((c) => !isChatColumn(c));
    expect(tools?.groups[0]!.activeCardId).toBe('files');
    expect(tools?.groups[0]!.cards.map((c) => c.id)).toEqual(['files']);

    expect(removePanelCard(ws, 'files')).toBe(true);
    expect(isChatOnlyWorkspace(ws)).toBe(true);
    expect(ws.columns.every((c) => isChatColumn(c) || c.groups.length > 0)).toBe(true);
  });

  it('removePanelCard never strips chat; missing returns false', () => {
    const ws = bareChatWs();
    expect(removePanelCard(ws, 'chat')).toBe(false);
    expect(findCardInWorkspace(ws, 'chat')).toBeTruthy();
    expect(removePanelCard(ws, 'terminal')).toBe(false);
  });

  it('ensureToolColumn reuses existing non-chat col', () => {
    const ws = wsWithToolTabs(['diff'], 'diff');
    const a = ensureToolColumn(ws);
    const b = ensureToolColumn(ws);
    expect(a).toBe(b);
    expect(ws.columns.filter((c) => !isChatColumn(c))).toHaveLength(1);
  });
});

// ── extract / after remove / reorder ────────────────────────────────────────

describe('extract / afterCardRemoved / reorder helpers', () => {
  it('pickActiveCardIndexAfterRemove browser-style', () => {
    expect(pickActiveCardIndexAfterRemove(0, 0)).toBe(-1);
    expect(pickActiveCardIndexAfterRemove(3)).toBe(0);
    expect(pickActiveCardIndexAfterRemove(2, 1)).toBe(0);
    expect(pickActiveCardIndexAfterRemove(2, 0)).toBe(0);
    expect(pickActiveCardIndexAfterRemove(2, 2)).toBe(1);
  });

  it('extractCardFromGroup + afterCardRemovedFromGroup', () => {
    const ws = wsWithToolTabs(['overview', 'agent', 'diff'], 'agent');
    const extracted = extractCardFromGroup(ws, 'group-tools', 'agent');
    expect(extracted?.removedIndex).toBe(1);
    afterCardRemovedFromGroup(
      ws,
      extracted!.sourceGroup,
      'group-tools',
      'agent',
      extracted!.removedIndex,
    );
    expect(extracted!.sourceGroup.activeCardId).toBe('overview');
  });

  it('adjustSameGroupReorderIndex accounts for gap', () => {
    // cards [a,b,c] move a(0) to index 2 → after splice remaining 2, toIdx adjusted
    expect(adjustSameGroupReorderIndex(0, 2, 2)).toBe(1);
    expect(adjustSameGroupReorderIndex(2, 0, 2)).toBe(0);
    expect(adjustSameGroupReorderIndex(1, undefined, 2)).toBe(2);
  });

  it('insertCardIntoGroup at index and activates', () => {
    const g = toolGroup('g', ['a', 'c'], 'a');
    insertCardIntoGroup(g, makePanelCard('b'), 1);
    expect(g.cards.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(g.activeCardId).toBe('b');
  });
});

// ── split edges ─────────────────────────────────────────────────────────────

describe('resolveSplitEdgeFromPoint / insert indices / redundancy', () => {
  const W = 400;
  const H = 300;

  it('chat column: left / right zones, center null', () => {
    expect(
      resolveSplitEdgeFromPoint(W * 0.2, H / 2, W, H, { chatColumn: true }),
    ).toBe('left');
    expect(
      resolveSplitEdgeFromPoint(W * 0.8, H / 2, W, H, { chatColumn: true }),
    ).toBe('right');
    expect(
      resolveSplitEdgeFromPoint(W * 0.5, H / 2, W, H, { chatColumn: true }),
    ).toBeNull();
  });

  it('preferMergeInTabBar in header zone', () => {
    expect(
      resolveSplitEdgeFromPoint(W / 2, 10, W, H, {
        preferMergeInTabBar: true,
        tabBarH: 36,
      }),
    ).toBe('merge');
  });

  it('left/right edge padding and top/bottom', () => {
    expect(resolveSplitEdgeFromPoint(10, H / 2, W, H)).toBe('left');
    expect(resolveSplitEdgeFromPoint(W - 10, H / 2, W, H)).toBe('right');
    // below tab bar + padding → top edge
    expect(
      resolveSplitEdgeFromPoint(W / 2, 40, W, H, { tabBarH: 36 }),
    ).toBe('top');
    expect(resolveSplitEdgeFromPoint(W / 2, H - 10, W, H)).toBe('bottom');
    // center half
    expect(resolveSplitEdgeFromPoint(W / 2, H * 0.35, W, H)).toBe('top');
    expect(resolveSplitEdgeFromPoint(W / 2, H * 0.7, W, H)).toBe('bottom');
  });

  it('disableLeft / zero size', () => {
    expect(
      resolveSplitEdgeFromPoint(5, H / 2, W, H, { disableLeft: true }),
    ).toBeNull();
    expect(resolveSplitEdgeFromPoint(0, 0, 0, H)).toBeNull();
  });

  it('columnInsertIndexForSplit / groupInsertIndexForSplit', () => {
    expect(columnInsertIndexForSplit(2, 'left')).toBe(2);
    expect(columnInsertIndexForSplit(2, 'right')).toBe(3);
    expect(groupInsertIndexForSplit(1, 'top', 3)).toBe(1);
    expect(groupInsertIndexForSplit(1, 'bottom', 3)).toBe(2);
    expect(groupInsertIndexForSplit(5, 'bottom', 3)).toBe(3);
    expect(groupInsertIndexForSplit(-1, 'top', 2)).toBe(0);
  });

  it('clampToolTargetColIdx never lands on chat col when tools exist', () => {
    expect(clampToolTargetColIdx(0, 3)).toBe(1);
    expect(clampToolTargetColIdx(99, 3)).toBe(2);
    expect(clampToolTargetColIdx(1, 1)).toBe(0);
  });

  it('isRedundantColumnSplit / isRedundantGroupSplit', () => {
    expect(
      isRedundantColumnSplit({
        isOnlyCardInCol: true,
        sourceColIdx: 1,
        targetColIdx: 1,
        direction: 'left',
      }),
    ).toBe(true);
    expect(
      isRedundantColumnSplit({
        isOnlyCardInCol: true,
        sourceColIdx: 1,
        targetColIdx: 2,
        direction: 'right',
      }),
    ).toBe(false);
    expect(
      isRedundantColumnSplit({
        isOnlyCardInCol: false,
        sourceColIdx: 1,
        targetColIdx: 1,
        direction: 'left',
      }),
    ).toBe(false);

    expect(
      isRedundantGroupSplit({
        sourceColIdx: 1,
        sourceGroupIdx: 0,
        targetColIdx: 1,
        targetGroupIdx: 1,
        direction: 'top',
      }),
    ).toBe(true);
    expect(
      isRedundantGroupSplit({
        sourceColIdx: 1,
        sourceGroupIdx: 2,
        targetColIdx: 1,
        targetGroupIdx: 1,
        direction: 'bottom',
      }),
    ).toBe(true);
    expect(
      isRedundantGroupSplit({
        sourceColIdx: 1,
        sourceGroupIdx: 0,
        targetColIdx: 2,
        targetGroupIdx: 0,
        direction: 'top',
      }),
    ).toBe(false);
  });

  it('exports padding constants used by drag path', () => {
    expect(SPLIT_EDGE_PADDING_X).toBe(48);
    expect(SPLIT_EDGE_PADDING_Y).toBe(36);
  });
});

// ── ensureChatColumn ────────────────────────────────────────────────────────

describe('ensureChatColumn', () => {
  it('recreates missing chat column and card', () => {
    const ws: WorkspaceState = {
      id: 'ws-nochat',
      columns: [
        {
          id: 'col-tools',
          widthRatio: 1,
          groups: [toolGroup('g', ['diff'], 'diff')],
        },
      ],
    };
    ensureChatColumn(ws);
    expect(ws.columns.some((c) => isChatColumn(c))).toBe(true);
    expect(findCardInWorkspace(ws, 'chat')).toBeTruthy();
  });

  it('repairs invalid activeCardId inside chat group', () => {
    const ws = bareChatWs();
    ws!.columns[0]!.groups[0]!.activeCardId = 'ghost';
    ensureChatColumn(ws);
    expect(ws!.columns[0]!.groups[0]!.activeCardId).toBe('chat');
  });
});

// ── diff / terminal buffers (regression, still pure) ────────────────────────

describe('upsertDiffFile / appendTerminalLine', () => {
  it('upserts by path and caps length', () => {
    const list: FileDiff[] = [];
    const mk = (p: string, add: number): FileDiff => ({
      filePath: p,
      additions: add,
      deletions: 0,
      changes: [],
    });
    upsertDiffFile(list, mk('a.ts', 1));
    upsertDiffFile(list, mk('b.ts', 2));
    upsertDiffFile(list, mk('a.ts', 9));
    expect(list![0]!.filePath).toBe('b.ts');
    expect(list.find((f) => f.filePath === 'a.ts')?.additions).toBe(9);

    for (let i = 0; i < DIFF_LIST_MAX + 5; i++) {
      upsertDiffFile(list, mk(`f${i}.ts`, i));
    }
    expect(list.length).toBe(DIFF_LIST_MAX);
  });

  it('appendTerminalLine trims when over hard max', () => {
    const buf: string[] = [];
    expect(appendTerminalLine(buf, 'a', 3, 2)).toBe(false);
    expect(appendTerminalLine(buf, 'b', 3, 2)).toBe(false);
    expect(appendTerminalLine(buf, 'c', 3, 2)).toBe(false);
    // length 3 not yet over hardMax
    expect(buf).toEqual(['a', 'b', 'c']);
    // 4th push → over hardMax → trim to 2 (keep tail)
    expect(appendTerminalLine(buf, 'd', 3, 2)).toBe(true);
    expect(buf).toEqual(['c', 'd']);
  });
});

// ── createDefaultWorkspace smoke ────────────────────────────────────────────

describe('createDefaultWorkspace', () => {
  it('always has locked chat column', () => {
    const ws = createDefaultWorkspace('ws-def');
    expect(ws.id).toBe('ws-def');
    expect(ws.columns.some((c) => isChatColumn(c))).toBe(true);
    expect(findCardInWorkspace(ws, 'chat')).toBeTruthy();
    const sum = ws.columns.reduce((a, c) => a + c.widthRatio, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});
