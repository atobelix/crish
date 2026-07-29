/**
 * unitTabPlacement — pure placement helpers (R4 / D2).
 */

import { describe, it, expect } from 'vitest';
import {
  createLeaf,
  createBranch,
  type LayoutNode,
} from '../layout-tree/types';
import { createDefaultDock, type TabSurface } from './types';
import {
  listChatUnits,
  isSingleChatUnit,
  tabsForUnit,
  type ChatUnitRef,
} from './unitTabPlacement';

// ── fixtures ──────────────────────────────────────────────────────────

function makeTab(
  tabId: string,
  sessionId: string,
  workspaceKey = 'general',
  title?: string
): TabSurface {
  return {
    tabId,
    kind: 'conversation',
    sessionId,
    workspaceKey,
    title: title ?? sessionId,
    rightDock: createDefaultDock(),
  };
}

function multiChatRoot(
  sessionA = 'sess-a',
  sessionB = 'sess-b'
): { root: LayoutNode; chatA: ReturnType<typeof createLeaf>; chatB: ReturnType<typeof createLeaf> } {
  const chatA = createLeaf('chat', ['chat'], 'chat', sessionA);
  const chatB = createLeaf('chat', ['chat'], 'chat', sessionB);
  const root = createBranch('horizontal', chatA, chatB, 0.5);
  return { root, chatA, chatB };
}

// ── listChatUnits / isSingleChatUnit ─────────────────────────────────

describe('listChatUnits', () => {
  it('单 chat leaf → 一个 unit，透传 sessionId', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const units = listChatUnits(chat);
    expect(units).toEqual([{ leafId: chat.id, sessionId: 's1' }]);
  });

  it('未绑定 sessionId 的 chat leaf → sessionId 省略', () => {
    const chat = createLeaf('chat');
    const units = listChatUnits(chat);
    expect(units).toHaveLength(1);
    expect(units[0]!.leafId).toBe(chat.id);
    expect(units[0]!.sessionId).toBeUndefined();
  });

  it('多 chat 先序列出；忽略 tool leaf', () => {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'a');
    const tool = createLeaf('terminal', ['terminal'], 'terminal');
    const unitA = createBranch('horizontal', chatA, tool, 0.6);
    const chatB = createLeaf('chat', ['chat'], 'chat', 'b');
    const root = createBranch('horizontal', unitA, chatB, 0.5);

    const units = listChatUnits(root);
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.sessionId)).toEqual(['a', 'b']);
    expect(units[0]!.leafId).toBe(chatA.id);
    expect(units[1]!.leafId).toBe(chatB.id);
  });

  it('纯 tool 树 → 空列表', () => {
    const t1 = createLeaf('files', ['files'], 'files');
    const t2 = createLeaf('diff', ['diff'], 'diff');
    const root = createBranch('vertical', t1, t2, 0.5);
    expect(listChatUnits(root)).toEqual([]);
  });
});

describe('isSingleChatUnit', () => {
  it('恰好 1 个 chat leaf → true', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    expect(isSingleChatUnit(chat)).toBe(true);

    const withDock = createBranch(
      'horizontal',
      chat,
      createLeaf('terminal', ['terminal'], 'terminal'),
      0.6
    );
    expect(isSingleChatUnit(withDock)).toBe(true);
  });

  it('0 或 2+ chat leaf → false', () => {
    const tool = createLeaf('files', ['files'], 'files');
    expect(isSingleChatUnit(tool)).toBe(false);

    const { root } = multiChatRoot();
    expect(isSingleChatUnit(root)).toBe(false);
  });
});

// ── tabsForUnit — single unit ────────────────────────────────────────

describe('tabsForUnit — single chat unit', () => {
  it('展示当前 workspace 全部 openTabs（多标签单窗格）', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's1');
    const units = listChatUnits(chat);
    const tabs = [
      makeTab('t1', 's1'),
      makeTab('t2', 's2'),
      makeTab('t3', 's3', 'other-ws'),
      makeTab('t4', 's4'),
    ];

    const strip = tabsForUnit(tabs, units[0]!, units, 't1', 'general');
    expect(strip.map((t) => t.tabId)).toEqual(['t1', 't2', 't4']);
  });

  it('allUnits 空时仍返回 workspace tabs（防御）', () => {
    const unit: ChatUnitRef = { leafId: 'orphan' };
    const tabs = [makeTab('t1', 's1')];
    expect(tabsForUnit(tabs, unit, [], 't1', 'general')).toEqual(tabs);
  });

  it('保持 openTabs 相对顺序', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 's-bound');
    const units = listChatUnits(chat);
    const tabs = [
      makeTab('tb', 's-b'),
      makeTab('ta', 's-a'),
      makeTab('tc', 's-c'),
    ];
    expect(
      tabsForUnit(tabs, units[0]!, units, 'ta', 'general').map((t) => t.tabId)
    ).toEqual(['tb', 'ta', 'tc']);
  });
});

// ── tabsForUnit — multi unit ─────────────────────────────────────────

describe('tabsForUnit — multi chat unit', () => {
  it('各 unit 仅展示绑定 session 的 tab（1:1）', () => {
    const { root, chatA, chatB } = multiChatRoot('sess-a', 'sess-b');
    const units = listChatUnits(root);
    const tabs = [
      makeTab('ta', 'sess-a'),
      makeTab('tb', 'sess-b'),
      makeTab('tc', 'sess-c'), // unplaced
    ];

    const stripA = tabsForUnit(tabs, units[0]!, units, 'ta', 'general');
    const stripB = tabsForUnit(tabs, units[1]!, units, 'ta', 'general');

    // active=sess-a → unplaced 落在 A
    expect(stripA.map((t) => t.sessionId)).toEqual(['sess-a', 'sess-c']);
    expect(stripB.map((t) => t.sessionId)).toEqual(['sess-b']);
    expect(units[0]!.leafId).toBe(chatA.id);
    expect(units[1]!.leafId).toBe(chatB.id);
  });

  it('leaf 有 sessionId 时 strip 必含该 session tab（若在 openTabs）', () => {
    const { root } = multiChatRoot('must-show', 'other');
    const units = listChatUnits(root);
    const tabs = [
      makeTab('tx', 'orphan'),
      makeTab('tm', 'must-show'),
      makeTab('to', 'other'),
    ];

    const strip = tabsForUnit(
      tabs,
      units[0]!,
      units,
      'to', // active on B — unplaced 不进 A
      'general'
    );
    expect(strip.map((t) => t.sessionId)).toEqual(['must-show']);
  });

  it('unplaced 仅出现在活跃 unit（active 绑定 leaf）', () => {
    const { root } = multiChatRoot('a', 'b');
    const units = listChatUnits(root);
    const tabs = [
      makeTab('ta', 'a'),
      makeTab('tb', 'b'),
      makeTab('tu1', 'u1'),
      makeTab('tu2', 'u2'),
    ];

    // active on B
    const stripA = tabsForUnit(tabs, units[0]!, units, 'tb', 'general');
    const stripB = tabsForUnit(tabs, units[1]!, units, 'tb', 'general');

    expect(stripA.map((t) => t.tabId)).toEqual(['ta']);
    expect(stripB.map((t) => t.tabId)).toEqual(['tb', 'tu1', 'tu2']);
  });

  it('active tab 本身 unplaced → unplaced 落到 allUnits[0]', () => {
    const { root } = multiChatRoot('a', 'b');
    const units = listChatUnits(root);
    const tabs = [
      makeTab('ta', 'a'),
      makeTab('tb', 'b'),
      makeTab('tu', 'unplaced'),
    ];

    const stripA = tabsForUnit(tabs, units[0]!, units, 'tu', 'general');
    const stripB = tabsForUnit(tabs, units[1]!, units, 'tu', 'general');

    expect(stripA.map((t) => t.tabId)).toEqual(['ta', 'tu']);
    expect(stripB.map((t) => t.tabId)).toEqual(['tb']);
  });

  it('无 activeTabId → unplaced 回退 first unit', () => {
    const { root } = multiChatRoot('a', 'b');
    const units = listChatUnits(root);
    const tabs = [makeTab('ta', 'a'), makeTab('tu', 'u')];

    expect(
      tabsForUnit(tabs, units[0]!, units, null, 'general').map((t) => t.tabId)
    ).toEqual(['ta', 'tu']);
    expect(
      tabsForUnit(tabs, units[1]!, units, null, 'general').map((t) => t.tabId)
    ).toEqual([]);
  });

  it('过滤非当前 workspaceKey 的 tab', () => {
    const { root } = multiChatRoot('a', 'b');
    const units = listChatUnits(root);
    const tabs = [
      makeTab('ta', 'a', 'general'),
      makeTab('ta-other', 'a', 'proj-x'), // 同 session 不同 ws — 不进 general 条
      makeTab('tu', 'u', 'general'),
      makeTab('tu-x', 'u2', 'proj-x'),
    ];

    const strip = tabsForUnit(tabs, units[0]!, units, 'ta', 'general');
    expect(strip.map((t) => t.tabId)).toEqual(['ta', 'tu']);
  });

  it('纯函数：不 mutate 输入', () => {
    const { root } = multiChatRoot();
    const units = listChatUnits(root);
    const tabs = [makeTab('ta', 'sess-a'), makeTab('tb', 'sess-b')];
    const beforeTabs = JSON.stringify(tabs);
    const beforeUnits = JSON.stringify(units);

    void tabsForUnit(tabs, units[0]!, units, 'ta', 'general');
    void tabsForUnit(tabs, units[1]!, units, 'tb', 'general');

    expect(JSON.stringify(tabs)).toBe(beforeTabs);
    expect(JSON.stringify(units)).toBe(beforeUnits);
  });

  it('unit 无 sessionId 且非 unplaced host → 空条', () => {
    const unbound = createLeaf('chat');
    const bound = createLeaf('chat', ['chat'], 'chat', 'b');
    const root = createBranch('horizontal', unbound, bound, 0.5);
    const units = listChatUnits(root);
    const tabs = [makeTab('tb', 'b'), makeTab('tu', 'u')];

    // active on bound B → unplaced on B
    expect(
      tabsForUnit(tabs, units[0]!, units, 'tb', 'general').map((t) => t.tabId)
    ).toEqual([]);
    expect(
      tabsForUnit(tabs, units[1]!, units, 'tb', 'general').map((t) => t.tabId)
    ).toEqual(['tb', 'tu']);
  });
});
