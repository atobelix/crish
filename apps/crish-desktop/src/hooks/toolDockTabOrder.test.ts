import { describe, expect, it } from 'vitest';
import {
  createBranch,
  createLeaf,
  type LayoutNode,
} from '../store/layout-tree/types';
import {
  findToolLeafIdForPanel,
  listToolLeafIdsInUnit,
  reorderOpenPanelIds,
} from './toolDockTabOrder';

describe('reorderOpenPanelIds', () => {
  it('把 fromId 插到 beforeId 之前', () => {
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'c', 'a')).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'a', 'c')).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('beforeId 为 null 时移到末尾', () => {
    expect(reorderOpenPanelIds(['a', 'b', 'c'], 'a', null)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('fromId 不存在 / 与 beforeId 相同 → 原引用', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderOpenPanelIds(ids, 'x', 'a')).toBe(ids);
    expect(reorderOpenPanelIds(ids, 'a', 'a')).toBe(ids);
  });

  it('顺序未变 → 原引用', () => {
    const ids = ['a', 'b', 'c'];
    // a 已在 b 前
    expect(reorderOpenPanelIds(ids, 'a', 'b')).toBe(ids);
  });

  it('beforeId 不在列表中 → 追加到末尾', () => {
    expect(reorderOpenPanelIds(['a', 'b'], 'a', 'missing')).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('listToolLeafIdsInUnit / findToolLeafIdForPanel', () => {
  function multiUnitRoot(): LayoutNode {
    // unit A: H(chatA | toolA)
    // unit B: H(chatB | V(toolB1, toolB2))
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sA');
    const toolA = createLeaf('files', ['files', 'diff'], 'files', 'sA');
    const unitA = createBranch('horizontal', chatA, toolA, 0.6);

    const chatB = createLeaf('chat', ['chat'], 'chat', 'sB');
    const toolB1 = createLeaf('terminal', ['terminal'], 'terminal', 'sB');
    const toolB2 = createLeaf('overview', ['overview'], 'overview', 'sB');
    const toolSub = createBranch('vertical', toolB1, toolB2, 0.5);
    const unitB = createBranch('horizontal', chatB, toolSub, 0.6);

    return createBranch('horizontal', unitA, unitB, 0.5);
  }

  it('只返回本 unit 的 tool leaf', () => {
    const root = multiUnitRoot();
    const aIds = listToolLeafIdsInUnit(root, 'sA');
    const bIds = listToolLeafIdsInUnit(root, 'sB');
    expect(aIds.size).toBe(1);
    expect(bIds.size).toBe(2);
    // 互不包含
    for (const id of aIds) expect(bIds.has(id)).toBe(false);
  });

  it('chat-only unit → 空集合', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(listToolLeafIdsInUnit(chat, 's1').size).toBe(0);
  });

  it('未知 session → 空', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(listToolLeafIdsInUnit(chat, 'missing').size).toBe(0);
  });

  it('findToolLeafIdForPanel 命中正确 leaf', () => {
    const root = multiUnitRoot();
    const termId = findToolLeafIdForPanel(root, 'sB', 'terminal');
    const overviewId = findToolLeafIdForPanel(root, 'sB', 'overview');
    const filesId = findToolLeafIdForPanel(root, 'sA', 'files');
    expect(termId).toBeTruthy();
    expect(overviewId).toBeTruthy();
    expect(termId).not.toBe(overviewId);
    expect(filesId).toBeTruthy();
    // 跨 unit 找不到
    expect(findToolLeafIdForPanel(root, 'sA', 'terminal')).toBeNull();
  });
});
