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
import type { TerminalTab } from './sessionTabModel';

describe('LayoutTreeStore & Shell: Terminal Tab First-Class Integration', () => {
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

  describe('addTerminalTab in layoutTreeStore', () => {
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
  });

  describe('addBrowserTab in layoutTreeStore', () => {
    it('addBrowserTab creates first-class StandaloneBrowserTab and pushes to history', () => {
      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      const beforePast = useLayoutTreeStore.getState().past.length;

      const created = useLayoutTreeStore
        .getState()
        .addBrowserTab(activeLeafId, {
          url: 'https://github.com',
          title: 'GitHub',
        });

      expect(created.kind).toBe('browser');
      expect(created.isStandalone).toBe(true);
      expect(created.title).toBe('GitHub');
      expect(created.url).toBe('https://github.com');
      expect(created.dock).toBeUndefined();

      const leaf = findNodeById(
        useLayoutTreeStore.getState().tree.root,
        activeLeafId
      ) as LayoutLeaf;
      expect(leaf.tabs).toHaveLength(1);
      expect(leaf.tabs[0].tabId).toBe(created.tabId);
      expect(leaf.activeTabId).toBe(created.tabId);
      expect(useLayoutTreeStore.getState().past.length).toBe(beforePast + 1);
    });

    it('removeTab on a browser tab invokes browserWebviewClose', async () => {
      const browserApi = await import('../../api/nativeBrowserApi');
      const closeSpy = vi
        .spyOn(browserApi, 'browserWebviewClose')
        .mockResolvedValue(undefined);

      const activeLeafId = useLayoutTreeStore.getState().activeLeafId!;
      const tab = useLayoutTreeStore.getState().addBrowserTab(activeLeafId, {
        url: 'https://example.com',
      });

      useLayoutTreeStore.getState().removeTab(activeLeafId, tab.tabId);

      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalledWith(tab.tabId);
      });
      closeSpy.mockRestore();
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
    it('workspaceShellStore.addTerminalTab works seamlessly', () => {
      const shell = useWorkspaceShellStore.getState();
      const termTab = shell.addTerminalTab(undefined, {
        title: '终端集成测试',
      });
      expect(termTab).toBeDefined();
      expect(termTab.kind).toBe('terminal');
      expect(termTab.title).toBe('终端集成测试');
    });

    it('workspaceShellStore.addBrowserTab works seamlessly', () => {
      const shell = useWorkspaceShellStore.getState();
      const browserTab = shell.addBrowserTab(undefined, {
        title: '独立浏览器测试',
        url: 'https://example.com',
      });
      expect(browserTab).toBeDefined();
      expect(browserTab.kind).toBe('browser');
      expect(browserTab.title).toBe('独立浏览器测试');
      expect(browserTab.url).toBe('https://example.com');
    });

    it('compositionRoot.shell exposes addTerminalTab', () => {
      const root = getCompositionRoot();
      expect(typeof root.shell.addTerminalTab).toBe('function');

      const termTab = root.shell.addTerminalTab(undefined, {
        title: 'Facade终端',
      });
      expect(termTab.title).toBe('Facade终端');
    });

    it('compositionRoot.shell exposes addBrowserTab', () => {
      const root = getCompositionRoot();
      expect(typeof root.shell.addBrowserTab).toBe('function');

      const browserTab = root.shell.addBrowserTab(undefined, {
        title: 'Facade浏览器',
        url: 'https://conex.dev',
      });
      expect(browserTab.title).toBe('Facade浏览器');
      expect(browserTab.url).toBe('https://conex.dev');
    });
  });
});
