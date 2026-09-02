import { describe, expect, it } from 'vitest';
import {
  createLeaf,
  createDefaultTree,
  createBranch,
  LAYOUT_TREE_VERSION,
  isLeaf,
} from './types';
import {
  createDraftTab,
  createSessionTab,
  mintDraftTab,
  mintDraftSessionId,
  isDraftSessionId,
  isRealSessionId,
  PENDING_DRAFT_SESSION_ID,
  listRealSessionIds,
  findDuplicateRealSessionIds,
} from './sessionTabModel';

describe('createLeaf / createDefaultTree 工厂', () => {
  it('F1 createLeaf() 单 chat 叶、无标签的新对话界面', () => {
    const leaf = createLeaf();
    expect(leaf.panelId).toBe('chat');
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
    expect(leaf).not.toHaveProperty('sessionId');
  });

  it('F2 createLeaf({ tabs: [] }) 同 F1', () => {
    const leaf = createLeaf({ tabs: [] });
    expect(leaf.tabs).toHaveLength(0);
    expect(leaf.activeTabId).toBe('');
  });

  it('F3 保持两 tab 与指定 active', () => {
    const s1 = createSessionTab({ sessionId: 's1', tabId: 't1' });
    const s2 = createSessionTab({ sessionId: 's2', tabId: 't2' });
    const leaf = createLeaf({ tabs: [s1, s2], activeTabId: s2.tabId });
    expect(leaf.tabs.map((t) => t.sessionId)).toEqual(['s1', 's2']);
    expect(leaf.activeTabId).toBe('t2');
  });

  it('F4 activeTabId 不在 tabs → 回退 tabs[0]', () => {
    const s1 = createSessionTab({ sessionId: 's1', tabId: 't1' });
    const leaf = createLeaf({ tabs: [s1], activeTabId: 'missing' });
    expect(leaf.activeTabId).toBe('t1');
  });

  it('F5 全局哨兵不得写入 SessionTab.sessionId', () => {
    const tab = createSessionTab({ sessionId: PENDING_DRAFT_SESSION_ID });
    expect(tab.sessionId).toBe(mintDraftSessionId(tab.tabId));
    expect(tab.sessionId).not.toBe(PENDING_DRAFT_SESSION_ID);
  });

  it('F6 两次 createDraftTab 不同 tabId / sessionId', () => {
    const a = createDraftTab();
    const b = createDraftTab();
    expect(a.tabId).not.toBe(b.tabId);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('F7 createDefaultTree version=3 根为 F1 形', () => {
    const tree = createDefaultTree();
    expect(tree.version).toBe(LAYOUT_TREE_VERSION);
    expect(isLeaf(tree.root)).toBe(true);
    expect(tree.root.type === 'leaf' && tree.root.tabs).toHaveLength(0);
    expect(tree.root.type === 'leaf' && tree.root.activeTabId).toBe('');
  });
});

describe('I1 扫描', () => {
  it('listRealSessionIds 不含 draft；两叶 draft + 一叶 s1 → {s1}', () => {
    const a = createLeaf({ tabs: [createDraftTab()] });
    const b = createLeaf({ tabs: [createDraftTab()] });
    const c = createLeaf({
      tabs: [createSessionTab({ sessionId: 's1', tabId: 't-s1' })],
    });
    const root = createBranch(
      'horizontal',
      createBranch('horizontal', a, b, 0.5),
      c,
      0.5
    );
    expect(listRealSessionIds(root)).toEqual(['s1']);
    expect(findDuplicateRealSessionIds(root).size).toBe(0);
    expect(isRealSessionId('s1')).toBe(true);
    expect(a.tabs).toHaveLength(0);
    expect(isRealSessionId(createDraftTab().sessionId)).toBe(false);
  });

  it('F8 createDraftTab 与 mintDraftTab 兼容 string 与 object 传参', () => {
    const fromStr = createDraftTab('项目A');
    expect(fromStr.workspaceKey).toBe('项目A');
    expect(fromStr.title).toBe('新对话');

    const fromObj = createDraftTab({
      title: '自定义标题',
      workspaceKey: '项目B',
    });
    expect(fromObj.title).toBe('自定义标题');
    expect(fromObj.workspaceKey).toBe('项目B');

    // 防御嵌套/异型对象 workspaceKey
    const fromNested = createDraftTab({
      workspaceKey: { workspaceKey: '项目C' } as unknown as string,
    });
    expect(fromNested.workspaceKey).toBe('项目C');

    const fromMintStr = mintDraftTab('项目D');
    expect(fromMintStr.workspaceKey).toBe('项目D');

    const fromMintObj = mintDraftTab({
      title: '草稿D',
      workspaceKey: '项目D',
    });
    expect(fromMintObj.title).toBe('草稿D');
    expect(fromMintObj.workspaceKey).toBe('项目D');
  });
});

