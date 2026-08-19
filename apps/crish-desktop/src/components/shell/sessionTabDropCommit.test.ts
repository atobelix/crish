// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBranch,
  createDefaultTree,
  createLeaf,
  isBranch,
} from '../../store/layout-tree/types';
import {
  collectLeaves,
  listChatLeaves,
  setPrimaryPanelChecker,
  useLayoutTreeStore,
} from '../../store/layout-tree';
import { viewRegistry } from '../../services/view-registry';
import {
  createDefaultDock,
  useWorkspaceShellStore,
} from '../../store/workspace-shell';
import { GENERAL_FOLDER } from '../../api/projectStore';
import {
  commitSessionPaneDrop,
  commitSessionTabStripReorder,
} from './sessionTabDropCommit';

describe('commitSessionTabStripReorder', () => {
  beforeEach(() => {
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'sess-a',
          workspaceKey: GENERAL_FOLDER,
          title: 'A',
          rightDock: createDefaultDock(),
        },
        {
          tabId: 'tab-b',
          kind: 'conversation',
          sessionId: 'sess-b',
          workspaceKey: GENERAL_FOLDER,
          title: 'B',
          rightDock: createDefaultDock(),
        },
        {
          tabId: 'tab-c',
          kind: 'conversation',
          sessionId: 'sess-c',
          workspaceKey: GENERAL_FOLDER,
          title: 'C',
          rightDock: createDefaultDock(),
        },
      ],
      activeTabId: 'tab-a',
    });
  });

  it('insertIdx=0 插到剩余列表首位之前', () => {
    commitSessionTabStripReorder('sess-c', 0, ['sess-a', 'sess-b']);
    const ids = useWorkspaceShellStore
      .getState()
      .openTabs.map((t) => t.sessionId);
    expect(ids).toEqual(['sess-c', 'sess-a', 'sess-b']);
  });

  it('越界 insertIdx 追加到末尾', () => {
    commitSessionTabStripReorder('sess-a', 2, ['sess-b', 'sess-c']);
    const ids = useWorkspaceShellStore
      .getState()
      .openTabs.map((t) => t.sessionId);
    expect(ids).toEqual(['sess-b', 'sess-c', 'sess-a']);
  });
});

describe('commitSessionPaneDrop', () => {
  beforeEach(() => {
    setPrimaryPanelChecker((id) => viewRegistry.isPrimary(id));
  });

  afterEach(() => {
    useLayoutTreeStore.setState({
      tree: createDefaultTree('chat'),
      past: [],
      future: [],
    });
  });

  it('center → 不拆树，只 openOrFocusSession', () => {
    const chat = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    useLayoutTreeStore.setState({
      tree: { version: 2, root: chat },
      activeLeafId: chat.id,
      past: [],
      future: [],
    });
    useWorkspaceShellStore.setState({
      openTabs: [],
      activeTabId: null,
    });
    commitSessionPaneDrop('sess-b', chat.id, 'center', 'B');
    const chats = listChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats).toHaveLength(1);
    expect(useWorkspaceShellStore.getState().openTabs.some((t) => t.sessionId === 'sess-b')).toBe(
      true
    );
  });

  it('边缘落到已有 session 的叶 → 不 clone', () => {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
    const root = createBranch('horizontal', chatA, chatB, 0.5);
    useLayoutTreeStore.setState({
      tree: { version: 2, root },
      activeLeafId: chatA.id,
      past: [],
      future: [],
    });
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'sess-a',
          workspaceKey: GENERAL_FOLDER,
          title: 'A',
          rightDock: createDefaultDock(),
        },
      ],
      activeTabId: 'tab-a',
    });
    commitSessionPaneDrop('sess-a', chatB.id, 'right');
    const chats = listChatLeaves(useLayoutTreeStore.getState().tree.root);
    expect(chats.filter((c) => c.sessionId === 'sess-a')).toHaveLength(1);
  });

  it('边缘落到尚无 leaf 的会话 → 旁插 chat 叶', () => {
    const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
    useLayoutTreeStore.setState({
      tree: { version: 2, root: chatA },
      activeLeafId: chatA.id,
      past: [],
      future: [],
    });
    useWorkspaceShellStore.setState({
      openTabs: [
        {
          tabId: 'tab-a',
          kind: 'conversation',
          sessionId: 'sess-a',
          workspaceKey: GENERAL_FOLDER,
          title: 'A',
          rightDock: createDefaultDock(),
        },
        {
          tabId: 'tab-b',
          kind: 'conversation',
          sessionId: 'sess-b',
          workspaceKey: GENERAL_FOLDER,
          title: 'B',
          rightDock: createDefaultDock(),
        },
      ],
      activeTabId: 'tab-a',
    });
    commitSessionPaneDrop('sess-b', chatA.id, 'right');
    const tree = useLayoutTreeStore.getState().tree;
    expect(isBranch(tree.root)).toBe(true);
    const chats = listChatLeaves(tree.root);
    expect(chats).toHaveLength(2);
    expect(chats.some((c) => c.sessionId === 'sess-b')).toBe(true);
    expect(collectLeaves(tree.root).length).toBeGreaterThanOrEqual(2);
  });
});
