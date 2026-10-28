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
  createTerminalTab,
  createBrowserTab,
  createDefaultDock,
  DEFAULT_RIGHT_DOCK,
  normalizeSessionTab,
  mintDraftTab,
  mintDraftSessionId,
  isDraftSessionId,
  isRealSessionId,
  isChatTab,
  isTerminalTab,
  isBrowserTab,
  PENDING_DRAFT_SESSION_ID,
  listRealSessionIds,
  findDuplicateRealSessionIds,
} from './sessionTabModel';
import { collectSpatialLeaves } from './dockLayoutModel';

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

describe('Phase 1 任务 3: 会话标签模型彻底收敛与一次性冷迁移', () => {
  it('RightToolDockState 唯一单一真理源收敛为 tree: DockTree，彻底删除 openPanelIds 与 activePanelId', () => {
    expect(DEFAULT_RIGHT_DOCK.collapsed).toBe(true);
    expect(DEFAULT_RIGHT_DOCK.widthRatio).toBe(0.5);
    expect(DEFAULT_RIGHT_DOCK.tree).toBeDefined();
    expect(DEFAULT_RIGHT_DOCK.tree.version).toBe(2);

    // 绝对禁止残留旧字段
    expect((DEFAULT_RIGHT_DOCK as any).openPanelIds).toBeUndefined();
    expect((DEFAULT_RIGHT_DOCK as any).activePanelId).toBeUndefined();

    const created = createDefaultDock();
    expect(created.collapsed).toBe(true);
    expect(created.tree).toBeDefined();
    expect((created as any).openPanelIds).toBeUndefined();
    expect((created as any).activePanelId).toBeUndefined();
  });

  it('确立 SessionTab = ChatTab | StandaloneTerminalTab | StandaloneBrowserTab 正交类型体系', () => {
    // 1. ChatTab
    const chat = createSessionTab({ sessionId: 'session-123', title: '对话A' });
    expect(isChatTab(chat)).toBe(true);
    expect(isTerminalTab(chat)).toBe(false);
    expect(isBrowserTab(chat)).toBe(false);
    expect(chat.kind).toBe('chat');
    expect(chat.sessionId).toBe('session-123');
    expect(chat.dock).toBeDefined();
    expect((chat.dock as any).openPanelIds).toBeUndefined();

    // 2. StandaloneTerminalTab
    const term = createTerminalTab({ cwd: 'C:\\Users\\orange' });
    expect(isTerminalTab(term)).toBe(true);
    expect(isChatTab(term)).toBe(false);
    expect(isBrowserTab(term)).toBe(false);
    expect(term.kind).toBe('terminal');
    expect(term.isStandalone).toBe(true);
    expect(term.terminalKey).toMatch(/^standalone:term_/);
    expect(term.cwd).toBe('C:\\Users\\orange');
    expect(term.dock).toBeUndefined();
    expect(term.sessionId).toBeUndefined();

    // 3. StandaloneBrowserTab
    const browser = createBrowserTab({
      url: 'https://example.com',
      title: '示例',
    });
    expect(isBrowserTab(browser)).toBe(true);
    expect(isChatTab(browser)).toBe(false);
    expect(isTerminalTab(browser)).toBe(false);
    expect(browser.kind).toBe('browser');
    expect(browser.isStandalone).toBe(true);
    expect(browser.url).toBe('https://example.com');
    expect(browser.title).toBe('示例');
    expect(browser.dock).toBeUndefined();
    expect(browser.sessionId).toBeUndefined();
  });

  it('normalizeSessionTab 将 kind === browser 规范化为 StandaloneBrowserTab', () => {
    const legacyBrowser = {
      kind: 'browser',
      tabId: 'browser-tab-1',
      url: 'https://example.com',
      title: '独立浏览器',
      workspaceKey: '对话',
    };

    const normalized = normalizeSessionTab(legacyBrowser);
    expect(normalized.kind).toBe('browser');
    expect(isBrowserTab(normalized)).toBe(true);
    expect(normalized.tabId).toBe('browser-tab-1');
    if (normalized.kind === 'browser') {
      expect(normalized.url).toBe('https://example.com');
      expect(normalized.isStandalone).toBe(true);
      expect(normalized.dock).toBeUndefined();
      expect(normalized.title).toBe('独立浏览器');
    }
  });

  it('normalizeSessionTab 将 kind === terminal 规范化为 isStandalone: true 且无 dock', () => {
    const legacyTerminal = {
      kind: 'terminal',
      tabId: 'term-tab-1',
      terminalKey: 'term_123',
      cwd: 'C:\\Software',
      title: '旧终端',
      dock: { collapsed: false, openPanelIds: ['files'] }, // 错误挂载的 dock
    };

    const normalized = normalizeSessionTab(legacyTerminal);
    expect(normalized.kind).toBe('terminal');
    if (normalized.kind === 'terminal') {
      expect(normalized.isStandalone).toBe(true);
      expect(normalized.terminalKey).toBe('standalone:term_123');
      expect(normalized.cwd).toBe('C:\\Software');
      expect(normalized.dock).toBeUndefined(); // 绝不允许挂载右坞！
    }
  });

  it('normalizeSessionTab 对旧版 dock 扁平数据进行一次性冷迁移升水为 DockTree，并彻底清除旧字段', () => {
    const legacyTab = {
      kind: 'chat',
      tabId: 'chat-tab-1',
      sessionId: 'sess-real-1',
      title: '真实对话',
      dock: {
        collapsed: false,
        widthRatio: 0.42,
        openPanelIds: ['terminal', 'files'],
        activePanelId: 'files',
      },
    };

    const normalized = normalizeSessionTab(legacyTab);
    expect(normalized.kind).toBe('chat');
    if (normalized.kind === 'chat') {
      expect(normalized.dock.collapsed).toBe(false);
      expect(normalized.dock.widthRatio).toBe(0.42);
      expect((normalized.dock as any).openPanelIds).toBeUndefined();
      expect((normalized.dock as any).activePanelId).toBeUndefined();

      const leaves = collectSpatialLeaves(normalized.dock.tree.root);
      expect(leaves).toHaveLength(1);
      const leaf = leaves[0]!;
      expect(leaf.tabs).toHaveLength(2);
      expect(leaf.tabs.map((t) => t.viewId)).toEqual(['terminal', 'files']);
      expect(leaf.activeTabId).toBe(leaf.tabs[1]!.tabId); // files 激活
    }
  });
});
