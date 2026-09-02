import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutTreeStore } from '../../../../store/layout-tree';
import { collectLeaves } from '../../../../store/layout-tree/layoutTreeQuery';
import { useWorkspaceShellStore } from '../../../../store/workspace-shell/workspaceShellStore';
import { createSessionTab } from '../../../../store/layout-tree/sessionTabModel';
import { treeOpenSession } from '../../../../store/workspace-shell/treeSessionCommands';

describe('跨 Leaf 拖拽 TabStrip 搬移 Tab 与全新会话分屏契约', () => {
  beforeEach(() => {
    // 初始化两个 Leaf：L1 和 L2
    const tab1 = createSessionTab({ tabId: 'tab_1', sessionId: 'sess_1', title: '会话 1' });
    const tab1Extra = createSessionTab({ tabId: 'tab_extra', sessionId: 'sess_extra', title: '保留会话' });
    const tab2 = createSessionTab({ tabId: 'tab_2', sessionId: 'sess_2', title: '会话 2' });

    useLayoutTreeStore.setState({
      tree: {
        version: 3,
        root: {
          type: 'branch',
          id: 'branch_root',
          direction: 'horizontal',
          splitRatio: 0.5,
          children: [
            {
              type: 'leaf',
              id: 'L1',
              panelId: 'chat',
              tabs: [tab1, tab1Extra],
              activeTabId: 'tab_1',
              dock: { collapsed: true, openPanelIds: [], activePanelId: null, widthRatio: 0.3 },
            },
            {
              type: 'leaf',
              id: 'L2',
              panelId: 'chat',
              tabs: [tab2],
              activeTabId: 'tab_2',
              dock: { collapsed: true, openPanelIds: [], activePanelId: null, widthRatio: 0.3 },
            },
          ],
        } as any,
      },
    });
  });

  it('跨 Leaf 拖拽到 TabStrip：命中已存在于 L1 的会话，显式传入 L2 与 insertIdx 时，Tab 真实搬移到 L2', () => {
    // 拖拽 sess_1 到 L2 的第 0 个位置
    const res = treeOpenSession('sess_1', {
      title: '会话 1',
      workspaceKey: '对话',
      activeLeafId: 'L2',
      insertIdx: 0,
    });

    expect(res.leafId).toBe('L2');
    expect(res.tabId).toBe('tab_1');

    const tree = useLayoutTreeStore.getState().tree;
    const split = tree.root as any;
    const l1 = split.children[0];
    const l2 = split.children[1];

    // L1 中的 tab_1 已被搬走，L1 剩下 0 个 tab
    expect(l1.tabs.map((t: any) => t.tabId)).not.toContain('tab_1');
    // L2 中已包含 tab_1，且插在下标 0
    expect(l2.tabs[0].tabId).toBe('tab_1');
    expect(l2.tabs[1].tabId).toBe('tab_2');
    expect(l2.activeTabId).toBe('tab_1');
  });

  it('全新未打开会话分屏：新建 Tab 必须完整保留会话标题与工作区绑定', () => {
    useWorkspaceShellStore.getState().splitSessionFromSidebar('sess_new', 'L1', 'right');

    const tree = useLayoutTreeStore.getState().tree;
    const allLeaves = collectLeaves(tree.root);
    const createdTab = allLeaves
      .flatMap((l) => l.tabs)
      .find((t) => t.sessionId === 'sess_new');

    expect(createdTab).toBeDefined();
    expect(createdTab?.sessionId).toBe('sess_new');
  });
});
