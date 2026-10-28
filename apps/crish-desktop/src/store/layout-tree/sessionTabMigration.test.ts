import { describe, expect, it } from 'vitest';
import {
  createLeaf,
  createBranch,
  createDefaultTree,
  LAYOUT_TREE_VERSION,
  isLeaf,
  isBranch,
  type LayoutLeaf,
  type LayoutBranch,
  type LayoutTree,
} from './types';
import {
  createSessionTab,
  createDraftTab,
  isDraftSessionId,
  PENDING_DRAFT_SESSION_ID,
  findDuplicateRealSessionIds,
  listChatLeaves,
  listRealSessionIds,
} from './sessionTabModel';
import {
  migrateToLeafOwnedTabs,
  migrateLegacyDockStateToV2,
} from './sessionTabMigration';
import { collectSpatialLeaves } from './dockLayoutModel';
import { validateRestorableLayoutTree } from './layoutRestorePolicy';
import { collectLeaves } from './layoutTreeQuery';

describe('migrateToLeafOwnedTabs', () => {
  it('6.2 重复 sessionId：保留先序，prune 空叶', () => {
    const result = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'branch',
          id: 'b',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'leaf',
              id: 'A',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's1',
            },
            {
              type: 'leaf',
              id: 'B',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's1',
            },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findDuplicateRealSessionIds(result.tree.root).size).toBe(0);
    const leaves = collectLeaves(result.tree.root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.tabs.map((t) => t.sessionId)).toEqual(['s1']);
    expect(validateRestorableLayoutTree(result.tree).ok).toBe(true);
  });

  it('6.3 空 tabs / string tabs=chat 不得写成 sessionId=chat', () => {
    const empty = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'leaf',
          id: 'L',
          panelId: 'chat',
          tabs: [],
          activeTab: 'chat',
        },
      },
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      const leaf = empty.tree.root as LayoutLeaf;
      expect(leaf.tabs).toHaveLength(0);
      expect(leaf.activeTabId).toBe('');
    }

    const panelAsTab = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'leaf',
          id: 'L2',
          panelId: 'chat',
          tabs: ['chat'],
          activeTab: 'chat',
        },
      },
    });
    expect(panelAsTab.ok).toBe(true);
    if (panelAsTab.ok) {
      const leaf = panelAsTab.tree.root as LayoutLeaf;
      expect(leaf.tabs).toHaveLength(0);
      expect(leaf.activeTabId).toBe('');
    }
  });

  it('6.4 H(H(chatA, toolA), chatB) 折叠 tool，坞跟 s1', () => {
    const result = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'branch',
          id: 'root',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'branch',
              id: 'unitA',
              direction: 'horizontal',
              splitRatio: 0.62,
              children: [
                {
                  type: 'leaf',
                  id: 'chatA',
                  panelId: 'chat',
                  tabs: ['chat'],
                  activeTab: 'chat',
                  sessionId: 's1',
                },
                {
                  type: 'leaf',
                  id: 'toolA',
                  panelId: 'terminal',
                  tabs: ['terminal'],
                  activeTab: 'terminal',
                  sessionId: 's1',
                },
              ],
            },
            {
              type: 'leaf',
              id: 'chatB',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's2',
            },
          ],
        },
      },
      openTabsMap: { 对话: ['s1', 's2'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.version).toBe(LAYOUT_TREE_VERSION);
    expect(isBranch(result.tree.root)).toBe(true);
    const root = result.tree.root as LayoutBranch;
    expect(root.direction).toBe('horizontal');
    const chats = listChatLeaves(result.tree.root);
    expect(chats).toHaveLength(2);
    expect(
      collectLeaves(result.tree.root).every((l) => l.panelId === 'chat')
    ).toBe(true);
    const a = chats.find((l) => l.tabs.some((t) => t.sessionId === 's1'))!;
    const b = chats.find((l) => l.tabs.some((t) => t.sessionId === 's2'))!;
    expect(a.tabs).toHaveLength(1);
    expect(b.tabs).toHaveLength(1);
    expect(a).not.toHaveProperty('sessionId');
    const dock = a.tabs[0]!.dock;
    expect(dock.collapsed).toBe(false);
    expect((dock as any).openPanelIds).toBeUndefined();
    expect((dock as any).activePanelId).toBeUndefined();
    expect(dock.tree).toBeDefined();
    const leaf = dock.tree.root as any;
    expect(leaf.tabs.map((t: any) => t.viewId)).toContain('terminal');
    expect(dock.widthRatio).toBeCloseTo(0.38);
    expect(b.tabs[0]!.dock.collapsed).toBe(true);
    expect((b.tabs[0]!.dock as any).openPanelIds).toBeUndefined();
    const v = validateRestorableLayoutTree(result.tree);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.chatCount).toBe(2);
      expect(v.multiUnit).toBe(true);
    }
  });

  it('6.5 extras 并入活动叶，不新建叶', () => {
    const single = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'leaf',
          id: 'L',
          panelId: 'chat',
          tabs: ['chat'],
          activeTab: 'chat',
          sessionId: 's1',
        },
      },
      openTabsMap: { 对话: ['s1', 's2', 's3'] },
    });
    expect(single.ok).toBe(true);
    if (single.ok) {
      const leaf = single.tree.root as LayoutLeaf;
      expect(leaf.tabs.map((t) => t.sessionId)).toEqual(['s1', 's2', 's3']);
    }

    const two = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'branch',
          id: 'b',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'leaf',
              id: 'A',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's1',
            },
            {
              type: 'leaf',
              id: 'B',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's2',
            },
          ],
        },
      },
      openTabsMap: { 对话: ['s1', 's2', 's3'] },
      activeLeafId: 'B',
    });
    expect(two.ok).toBe(true);
    if (two.ok) {
      const leaves = collectLeaves(two.tree.root);
      const a = leaves.find((l) => l.id === 'A')!;
      const b = leaves.find((l) => l.id === 'B')!;
      expect(a.tabs.map((t) => t.sessionId)).toEqual(['s1']);
      expect(b.tabs.map((t) => t.sessionId)).toEqual(['s2', 's3']);
    }
  });

  it('6.6 tool-only / 损坏 → 回退', () => {
    const cases: unknown[] = [
      {
        version: 2,
        root: {
          type: 'leaf',
          id: 't',
          panelId: 'terminal',
          tabs: ['terminal'],
          activeTab: 'terminal',
        },
      },
      {
        version: 2,
        root: {
          type: 'branch',
          id: 'b',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'leaf',
              id: 'only-one',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
            },
          ],
        },
      },
      null,
    ];
    for (const tree of cases) {
      const r = migrateToLeafOwnedTabs({ tree });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('unrecoverable');
      expect(validateRestorableLayoutTree(r.tree).ok).toBe(true);
      const leaf = r.tree.root as LayoutLeaf;
      expect(isLeaf(leaf)).toBe(true);
      expect(leaf.tabs).toHaveLength(0);
      expect(leaf.activeTabId).toBe('');
    }

    const mixed = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'branch',
          id: 'b',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'leaf',
              id: 'v2',
              panelId: 'chat',
              tabs: ['chat'],
              activeTab: 'chat',
              sessionId: 's1',
            },
            createLeaf({
              id: 'v3',
              tabs: [createSessionTab({ sessionId: 's2', tabId: 't2' })],
            }),
          ],
        },
      },
    });
    expect(mixed.ok).toBe(false);
  });

  it('6.7 幂等 v3：真实 tab 不重铸', () => {
    const first = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'leaf',
          id: 'L',
          panelId: 'chat',
          tabs: ['chat'],
          activeTab: 'chat',
          sessionId: 's1',
        },
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tabId = (first.tree.root as LayoutLeaf).tabs[0]!.tabId;
    const second = migrateToLeafOwnedTabs({ tree: first.tree });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.tree.root as LayoutLeaf).tabs[0]!.tabId).toBe(tabId);
    expect((second.tree.root as LayoutLeaf).tabs[0]!.sessionId).toBe('s1');
    expect(second.didMigrate).toBe(false);
  });

  it('6.8 全局哨兵叶 → 空的新对话界面', () => {
    const r = migrateToLeafOwnedTabs({
      tree: {
        version: 2,
        root: {
          type: 'leaf',
          id: 'L',
          panelId: 'chat',
          tabs: ['chat'],
          activeTab: 'chat',
          sessionId: PENDING_DRAFT_SESSION_ID,
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const leaf = r.tree.root as LayoutLeaf;
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
    const v = validateRestorableLayoutTree(r.tree);
    expect(v.ok).toBe(true);
  });
});

describe('validateRestorableLayoutTree v3', () => {
  it('createDefaultTree ok', () => {
    const v = validateRestorableLayoutTree(createDefaultTree());
    expect(v.ok).toBe(true);
  });

  it('两叶不同 draft ok（不再报 multi-unit-unbound-chat）', () => {
    const tree: LayoutTree = {
      version: 3,
      root: createBranch(
        'horizontal',
        createLeaf({ tabs: [createDraftTab()] }),
        createLeaf({ tabs: [createDraftTab()] }),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.multiUnit).toBe(true);
  });

  it('两叶同一真实 s1 → duplicate-session-binding', () => {
    const t1 = createSessionTab({ sessionId: 's1', tabId: 'a' });
    const t2 = createSessionTab({ sessionId: 's1', tabId: 'b' });
    const tree: LayoutTree = {
      version: 3,
      root: createBranch(
        'horizontal',
        createLeaf({ tabs: [t1] }),
        createLeaf({ tabs: [t2] }),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('duplicate-session-binding');
  });

  it('activeTabId 指向已删 tab', () => {
    const tab = createSessionTab({ sessionId: 's1', tabId: 'keep' });
    const leaf = createLeaf({ tabs: [tab], activeTabId: 'keep' });
    const broken = {
      ...leaf,
      activeTabId: 'gone',
    };
    const v = validateRestorableLayoutTree({ version: 3, root: broken });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('active-tab-missing');
  });

  it('全局哨兵 → illegal-global-draft', () => {
    const tab = {
      ...createSessionTab({ sessionId: 's1', tabId: 't' }),
      sessionId: PENDING_DRAFT_SESSION_ID,
    };
    const leaf = createLeaf({ tabs: [tab] });
    // createLeaf 会重铸全局哨兵；直接造损坏叶
    const dirty: LayoutLeaf = {
      type: 'leaf',
      id: 'L',
      panelId: 'chat',
      tabs: [tab],
      activeTabId: tab.tabId,
    };
    const v = validateRestorableLayoutTree({ version: 3, root: dirty });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('illegal-global-draft');
    void leaf;
  });

  it('v2 形状未 migrate → malformed-structure', () => {
    const v2 = {
      version: 2,
      root: {
        type: 'leaf',
        id: 'L',
        panelId: 'chat',
        tabs: ['chat'],
        activeTab: 'chat',
        sessionId: 's1',
      },
    } as unknown as LayoutTree;
    const v = validateRestorableLayoutTree(v2);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed-structure');
  });

  it('I1 listRealSessionIds 不含 draft', () => {
    const root = createBranch(
      'horizontal',
      createLeaf({ tabs: [createDraftTab()] }),
      createLeaf({
        tabs: [createSessionTab({ sessionId: 's1', tabId: 't' })],
      }),
      0.5
    );
    expect(listRealSessionIds(root)).toEqual(['s1']);
  });

  it('拥有 Tabs 但 activeTabId 为空的破坏态，迁移后必定自愈激活首个 Tab', () => {
    const brokenTree = {
      version: LAYOUT_TREE_VERSION,
      root: {
        type: 'leaf',
        id: 'L1',
        panelId: 'chat',
        tabs: [
          {
            tabId: 'tab-auto-1',
            sessionId: 'sess-auto-1',
            title: '会话1',
            workspaceKey: 'conex',
          },
          {
            tabId: 'tab-auto-2',
            sessionId: 'sess-auto-2',
            title: '会话2',
            workspaceKey: 'conex',
          },
        ],
        activeTabId: '', // 破坏态：有 Tab 但无激活
      },
    };
    const res = migrateToLeafOwnedTabs({ tree: brokenTree });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const leaves = collectLeaves(res.tree.root);
      expect(leaves[0]!.activeTabId).toBe('tab-auto-1');
    }
  });
});

describe('migrateLegacyDockStateToV2 一次性冷迁移', () => {
  it('带有旧 openPanelIds: [terminal, files] 的数据一次性转换后，dock.tree 包含 2 个 ToolTab 且无旧字段残留', () => {
    const legacy = {
      collapsed: false,
      widthRatio: 0.45,
      openPanelIds: ['terminal', 'files'],
      activePanelId: 'files',
    };

    const migrated = migrateLegacyDockStateToV2(legacy);

    // 结构验证
    expect(migrated.collapsed).toBe(false);
    expect(migrated.widthRatio).toBe(0.45);
    expect(migrated.tree).toBeDefined();

    // 严格断言：旧字段彻底清退
    expect((migrated as any).openPanelIds).toBeUndefined();
    expect((migrated as any).activePanelId).toBeUndefined();

    // 树内容验证：包含 2 个 ToolTab
    const leaves = collectSpatialLeaves(migrated.tree.root);
    expect(leaves).toHaveLength(1);
    const leaf = leaves[0]!;
    expect(leaf.tabs).toHaveLength(2);
    expect(leaf.tabs[0]!.viewId).toBe('terminal');
    expect(leaf.tabs[1]!.viewId).toBe('files');

    // activePanelId = 'files' 正确激活对应 Tab
    expect(leaf.activeTabId).toBe(leaf.tabs[1]!.tabId);
    expect(migrated.tree.activeDockLeafId).toBe(leaf.id);
  });

  it('若输入已包含合法 DockTree，保留该 tree 并严格剥离旧字段', () => {
    const rawWithTree = {
      collapsed: false,
      widthRatio: 0.6,
      openPanelIds: ['terminal'],
      activePanelId: 'terminal',
      tree: {
        root: {
          type: 'leaf',
          id: 'custom_leaf',
          tabs: [{ tabId: 'dtab_diff_1', viewId: 'diff' }],
          activeTabId: 'dtab_diff_1',
        },
        activeDockLeafId: 'custom_leaf',
        version: 2,
      },
    };

    const migrated = migrateLegacyDockStateToV2(rawWithTree);
    expect(migrated.collapsed).toBe(false);
    expect(migrated.widthRatio).toBe(0.6);
    expect(migrated.tree.version).toBe(2);
    expect((migrated as any).openPanelIds).toBeUndefined();
    expect((migrated as any).activePanelId).toBeUndefined();
    const leaves = collectSpatialLeaves(migrated.tree.root);
    expect(leaves[0]!.id).toBe('custom_leaf');
    expect(leaves[0]!.tabs[0]!.viewId).toBe('diff');
  });

  it('空或无效输入返回合法默认 V2 右坞', () => {
    const emptyResult = migrateLegacyDockStateToV2(null);
    expect(emptyResult.collapsed).toBe(true);
    expect(emptyResult.widthRatio).toBe(0.5);
    expect(emptyResult.tree).toBeDefined();
    expect((emptyResult as any).openPanelIds).toBeUndefined();
    expect((emptyResult as any).activePanelId).toBeUndefined();
  });
});
