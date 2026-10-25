// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useLayoutTreeStore } from './layoutTreeStore';
import { useWorkspaceShellStore } from '../workspace-shell/workspaceShellStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  ptyRegistry,
  registerPtyHandlers,
  resetPtyRegistryForTests,
} from '../../api/ptyRegistry';
import { findNodeById } from './operations';
import type { LayoutLeaf } from './types';
import type { TerminalTab, BrowserTab } from './sessionTabModel';

describe('LayoutTreeStore & Shell: Terminal and Browser Tab First-Class Integration', () => {
  const killedPtys: { ptyId: string; sessionId: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resetPtyRegistryForTests();
    killedPtys.length = 0;

    registerPtyHandlers({
      kill: async (ptyId: string, sessionId: string) => {
        killedPtys.push({ ptyId, sessionId });
      },
    });

    useLayoutTreeStore.getState().resetTree();
  });

  afterEach(() => {
    resetPtyRegistryForTests();
  });

  describe('addTerminalTab & addBrowserTab in layoutTreeStore', () => {
    it('addTerminalTab creates first-class TerminalTab and pushes to history', () => {
      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      const beforePast = useLayoutTreeStore.getState().past.length;

      const created = useLayoutTreeStore
        .getState()
        .addTerminalTab(activeLeafId, {
          cwd: 'C:/projects/my-app',
          title: '我的终端',
        });

      expect(created.kind).toBe('terminal');
      expect(created.title).toBe('我的终端');
      expect(created.cwd).toBe('C:/projects/my-app');
      expect(created.terminalKey).toBeTruthy();

      const leaf = findNodeById(
        useLayoutTreeStore.getState().tree.root,
        activeLeafId
      ) as LayoutLeaf;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].tabId).toBe(created.tabId);
      expect(leaf.activeTabId).toBe(created.tabId);
      expect(useLayoutTreeStore.getState().past.length).toBe(beforePast + 1);
    });

    it('addBrowserTab creates first-class BrowserTab with default and custom options', () => {
      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      const created = useLayoutTreeStore
        .getState()
        .addBrowserTab(activeLeafId, {
          url: 'https://example.com',
          title: '示例网页',
        });

      expect(created.kind).toBe('browser');
      expect(created.url).toBe('https://example.com');
      expect(created.title).toBe('示例网页');

      const leaf = findNodeById(
        useLayoutTreeStore.getState().tree.root,
        activeLeafId
      ) as LayoutLeaf;
      expect(leaf.tabs.some((t) => t.tabId === created.tabId)).toBe(true);
      expect(leaf.activeTabId).toBe(created.tabId);
    });
  });

  describe('Deterministic PTY destruction on tab close, replace, and tree reset', () => {
    it('removeTab on a terminal tab takes handle from ptyRegistry and invokes kill', async () => {
      const termKey = 'term-test-key-1';
      const ptyId = 'pty-proc-1';
      ptyRegistry.bind(termKey, ptyId);

      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      const tab = useLayoutTreeStore.getState().addTerminalTab(activeLeafId, {
        terminalKey: termKey,
      });

      // Remove tab
      useLayoutTreeStore.getState().removeTab(activeLeafId, tab.tabId);

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === termKey)).toBe(true);
      });
    });

    it('replaceActiveSessionInLeaf kills active terminal PTY when replaced with chat session', async () => {
      const termKey = 'term-test-key-replace';
      const ptyId = 'pty-proc-replace';
      ptyRegistry.bind(termKey, ptyId);

      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      useLayoutTreeStore.getState().addTerminalTab(activeLeafId, {
        terminalKey: termKey,
      });

      // In-place replace active tab with real chat session
      useLayoutTreeStore
        .getState()
        .replaceActiveSessionInLeaf(activeLeafId, 'sess-real-new');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === termKey)).toBe(true);
      });
    });

    it('resetToSingleDraftLeaf and resetTree kill all active terminal PTYs in tree', async () => {
      const termKey1 = 'term-reset-1';
      const termKey2 = 'term-reset-2';
      ptyRegistry.bind(termKey1, 'pty-1');
      ptyRegistry.bind(termKey2, 'pty-2');

      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      useLayoutTreeStore
        .getState()
        .addTerminalTab(activeLeafId, { terminalKey: termKey1 });
      useLayoutTreeStore
        .getState()
        .addTerminalTab(activeLeafId, { terminalKey: termKey2 });

      useLayoutTreeStore.getState().resetToSingleDraftLeaf('默认');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === termKey1)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === termKey2)).toBe(true);
      });
    });
  });

  describe('WorkspaceShellStore & CompositionRoot Facades', () => {
    it('workspaceShellStore.addTerminalTab and addBrowserTab work seamlessly', () => {
      const shell = useWorkspaceShellStore.getState();
      const termTab = shell.addTerminalTab(undefined, {
        title: '终端集成测试',
      });
      expect(termTab).toBeDefined();
      expect(termTab.kind).toBe('terminal');
      expect(termTab.title).toBe('终端集成测试');

      const browserTab = shell.addBrowserTab(undefined, {
        url: 'https://github.com',
      });
      expect(browserTab).toBeDefined();
      expect(browserTab.kind).toBe('browser');
      expect(browserTab.url).toBe('https://github.com');
    });

    it('compositionRoot.shell exposes addTerminalTab and addBrowserTab', () => {
      const root = getCompositionRoot();
      expect(typeof root.shell.addTerminalTab).toBe('function');
      expect(typeof root.shell.addBrowserTab).toBe('function');

      const termTab = root.shell.addTerminalTab(undefined, {
        title: 'Facade终端',
      });
      expect(termTab.title).toBe('Facade终端');

      const browserTab = root.shell.addBrowserTab(undefined, {
        title: 'Facade浏览器',
      });
      expect(browserTab.title).toBe('Facade浏览器');
    });
  });
});
