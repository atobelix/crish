// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import {
  ptyRegistry,
  registerPtyHandlers,
  resetPtyRegistryForTests,
  killTerminalPtyBackground,
} from '../../../api/ptyRegistry';
import * as tauriInvokeMod from '../../../api/tauriInvoke';
import { useSessionExecutionTrackerStore } from '../../../store/sessionExecutionTrackerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { NewTabLauncherPopover } from '../NewTabLauncherPopover';
import type { SessionTab } from '../../../store/layout-tree/sessionTabModel';
import type {
  LayoutLeaf,
  LayoutBranch,
} from '../../../store/layout-tree/types';

// Mock compositionRoot for NewTabLauncherPopover
const shellMocks = vi.hoisted(() => ({
  addTab: vi.fn(),
  addTerminalTab: vi.fn(),
  addBrowserTab: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  openOrFocusSession: vi.fn(),
}));

vi.mock('../../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    shell: shellMocks,
    session: sessionMocks,
  }),
}));

describe('Challenger Wave 3: Resource Lifecycle & Cleanup Empirical Probes', () => {
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

    useSessionExecutionTrackerStore.getState().clearAllRuns();
  });

  afterEach(() => {
    resetPtyRegistryForTests();
    useSessionExecutionTrackerStore.getState().clearAllRuns();
  });

  // =========================================================================
  // PROBE 1: Deterministic PTY Destruction
  // =========================================================================
  describe('Probe 1: Deterministic PTY Destruction', () => {
    it('Probe 1.1: Closing single terminal tab triggers PTY destruction and unbinds from registry', async () => {
      const termKey = 'term-probe1-single';
      const ptyId = 'pty-probe1-proc-1';

      ptyRegistry.bind(termKey, ptyId);
      expect(ptyRegistry.get(termKey)).toBe(ptyId);

      const leafId = 'leaf-probe1-single';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-p1-single',
        terminalKey: termKey,
        cwd: 'C:/Software/conex',
        title: '终端 1',
        workspaceKey: '默认',
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-p1-single',
            tabs: [termTab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      // Close tab via workspaceShellStore.closeTab
      await act(async () => {
        useWorkspaceShellStore.getState().closeTab(leafId, 'tab-p1-single');
      });

      await vi.waitFor(() => {
        expect(
          killedPtys.some((k) => k.sessionId === termKey && k.ptyId === ptyId)
        ).toBe(true);
      });

      expect(ptyRegistry.get(termKey)).toBeUndefined();
      expect(ptyRegistry.has(termKey)).toBe(false);
    });

    it('Probe 1.2: Closing terminal tab via layoutTreeStore.removeTab triggers PTY kill', async () => {
      const termKey = 'term-probe1-removeTab';
      const ptyId = 'pty-probe1-removeTab-id';

      ptyRegistry.bind(termKey, ptyId);

      const leafId = 'leaf-probe1-rt';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-rt-1',
        terminalKey: termKey,
        cwd: 'C:/Software/conex',
        title: '终端 RT',
        workspaceKey: '默认',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-rt-1',
            tabs: [termTab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      useLayoutTreeStore.getState().removeTab(leafId, 'tab-rt-1');

      await vi.waitFor(() => {
        expect(
          killedPtys.some((k) => k.sessionId === termKey && k.ptyId === ptyId)
        ).toBe(true);
      });
      expect(ptyRegistry.has(termKey)).toBe(false);
    });

    it('Probe 1.3: In-place replacing active terminal tab with chat session triggers PTY destruction', async () => {
      const termKey = 'term-probe1-replace';
      const ptyId = 'pty-probe1-replace-id';

      ptyRegistry.bind(termKey, ptyId);

      const leafId = 'leaf-probe1-replace';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-term-rep',
        terminalKey: termKey,
        cwd: 'C:/Software/conex',
        title: '替换终端',
        workspaceKey: '默认',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-term-rep',
            tabs: [termTab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      // Replace active session in leaf
      useLayoutTreeStore
        .getState()
        .replaceActiveSessionInLeaf(leafId, 'sess-chat-replacement');

      await vi.waitFor(() => {
        expect(
          killedPtys.some((k) => k.sessionId === termKey && k.ptyId === ptyId)
        ).toBe(true);
      });
      expect(ptyRegistry.has(termKey)).toBe(false);
    });

    it('Probe 1.4: Tab isolation: closing one terminal tab in a multi-tab leaf does NOT kill others', async () => {
      const keyA = 'term-multi-A';
      const ptyA = 'pty-proc-A';
      const keyB = 'term-multi-B';
      const ptyB = 'pty-proc-B';

      ptyRegistry.bind(keyA, ptyA);
      ptyRegistry.bind(keyB, ptyB);

      const leafId = 'leaf-multi-term';
      const tabA = {
        kind: 'terminal',
        tabId: 'tab-A',
        terminalKey: keyA,
        title: '终端 A',
      } as unknown as SessionTab;
      const tabB = {
        kind: 'terminal',
        tabId: 'tab-B',
        terminalKey: keyB,
        title: '终端 B',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-A',
            tabs: [tabA, tabB],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      // Close only Tab A
      useLayoutTreeStore.getState().removeTab(leafId, 'tab-A');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === keyA)).toBe(true);
      });

      // Terminal B MUST remain alive and bound
      expect(killedPtys.some((k) => k.sessionId === keyB)).toBe(false);
      expect(ptyRegistry.get(keyB)).toBe(ptyB);
      expect(ptyRegistry.has(keyB)).toBe(true);
    });

    it('Probe 1.5: IPC Fallback: when killHandler is absent, invokeResult("workbench_pty_kill") is dispatched', async () => {
      // Remove custom killHandler so it tests the tauriInvoke path
      registerPtyHandlers({ kill: null });

      const invokeSpy = vi
        .spyOn(tauriInvokeMod, 'invokeResult')
        .mockResolvedValue({
          status: 'ok',
          data: undefined,
        });

      const termKey = 'term-ipc-fallback';
      const ptyId = 'pty-ipc-proc-777';
      ptyRegistry.bind(termKey, ptyId);

      const leafId = 'leaf-ipc-test';
      const tab = {
        kind: 'terminal',
        tabId: 'tab-ipc-1',
        terminalKey: termKey,
        title: 'IPC终端',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-ipc-1',
            tabs: [tab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      useLayoutTreeStore.getState().removeTab(leafId, 'tab-ipc-1');

      await vi.waitFor(() => {
        expect(invokeSpy).toHaveBeenCalledWith('workbench_pty_kill', {
          ptyId: ptyId,
          sessionId: termKey,
        });
      });

      expect(ptyRegistry.has(termKey)).toBe(false);
      invokeSpy.mockRestore();
    });

    it('Probe 1.6: resetTree and resetToSingleDraftLeaf kill all terminal PTYs across multiple leaves', async () => {
      const termK1 = 'term-tree-reset-1';
      const termK2 = 'term-tree-reset-2';
      ptyRegistry.bind(termK1, 'pty-reset-1');
      ptyRegistry.bind(termK2, 'pty-reset-2');

      const leaf1: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-reset-1',
        panelId: 'chat',
        activeTabId: 'tab-r1',
        tabs: [
          { kind: 'terminal', tabId: 'tab-r1', terminalKey: termK1 } as any,
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const leaf2: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-reset-2',
        panelId: 'chat',
        activeTabId: 'tab-r2',
        tabs: [
          { kind: 'terminal', tabId: 'tab-r2', terminalKey: termK2 } as any,
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };

      const branch: LayoutBranch = {
        type: 'branch',
        id: 'branch-root',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [leaf1, leaf2],
      };

      useLayoutTreeStore.setState({
        tree: { version: 3, root: branch },
        activeLeafId: 'leaf-reset-1',
      });

      useLayoutTreeStore.getState().resetTree();

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === termK1)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === termK2)).toBe(true);
      });

      expect(ptyRegistry.has(termK1)).toBe(false);
      expect(ptyRegistry.has(termK2)).toBe(false);
    });
  });

  // =========================================================================
  // PROBE 2: Split-Key PTY Destruction
  // =========================================================================
  describe('Probe 2: Split-Key PTY Destruction', () => {
    it('Probe 2.1: Destroying a leaf with split terminal tabs (${key}:*) cleans up all child PTY processes', async () => {
      const primaryKey = 'term-split-leaf-p';
      const primaryPtyId = 'pty-p-100';
      const split1 = `${primaryKey}:split-1`;
      const split2 = `${primaryKey}:split-2`;
      const split3 = `${primaryKey}:split-3`;
      const splitDeep = `${primaryKey}:nested:sub`;

      ptyRegistry.bind(primaryKey, primaryPtyId);
      ptyRegistry.bind(split1, 'pty-split-101');
      ptyRegistry.bind(split2, 'pty-split-102');
      ptyRegistry.bind(split3, 'pty-split-103');
      ptyRegistry.bind(splitDeep, 'pty-split-104');

      expect(ptyRegistry.size).toBe(5);

      const leafId = 'leaf-split-destroy';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-split-master',
        terminalKey: primaryKey,
        cwd: 'C:/Software/conex',
        title: '分屏终端叶',
      } as unknown as SessionTab;

      // 2-leaf tree layout: Leaf 1 (split terminal) and Leaf 2 (chat)
      const leaf1: LayoutLeaf = {
        type: 'leaf',
        id: leafId,
        panelId: 'chat',
        activeTabId: 'tab-split-master',
        tabs: [termTab],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const leaf2: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-other-chat',
        panelId: 'chat',
        activeTabId: 'tab-chat-survivor',
        tabs: [
          {
            kind: 'chat',
            tabId: 'tab-chat-survivor',
            sessionId: 'sess-survivor',
          } as any,
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'branch',
            id: 'branch-top',
            direction: 'horizontal',
            splitRatio: 0.5,
            children: [leaf1, leaf2],
          },
        },
        activeLeafId: leafId,
      });

      // Remove the tab -> leaf becomes empty and is pruned from tree
      useLayoutTreeStore.getState().removeTab(leafId, 'tab-split-master');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === primaryKey)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === split1)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === split2)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === split3)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === splitDeep)).toBe(true);
      });

      // Verify that every single PTY was removed from registry
      expect(ptyRegistry.has(primaryKey)).toBe(false);
      expect(ptyRegistry.has(split1)).toBe(false);
      expect(ptyRegistry.has(split2)).toBe(false);
      expect(ptyRegistry.has(split3)).toBe(false);
      expect(ptyRegistry.has(splitDeep)).toBe(false);
      expect(ptyRegistry.size).toBe(0);

      // Verify leaf1 was completely pruned from tree
      const leaves = useLayoutTreeStore.getState().tree.root;
      expect(leaves.id).toBe('leaf-other-chat');
    });

    it('Probe 2.2: Cross-terminal split isolation: destroying terminal A does not kill terminal B or its splits', async () => {
      const keyA = 'term-iso-A';
      const keyA_split1 = `${keyA}:split-1`;
      const keyA_split2 = `${keyA}:split-2`;

      const keyB = 'term-iso-B';
      const keyB_split1 = `${keyB}:split-1`;

      ptyRegistry.bind(keyA, 'pty-A');
      ptyRegistry.bind(keyA_split1, 'pty-A-1');
      ptyRegistry.bind(keyA_split2, 'pty-A-2');

      ptyRegistry.bind(keyB, 'pty-B');
      ptyRegistry.bind(keyB_split1, 'pty-B-1');

      expect(ptyRegistry.size).toBe(5);

      const leafId = 'leaf-iso-test';
      const tabA = {
        kind: 'terminal',
        tabId: 'tab-iso-A',
        terminalKey: keyA,
        title: '终端 A',
      } as unknown as SessionTab;
      const tabB = {
        kind: 'terminal',
        tabId: 'tab-iso-B',
        terminalKey: keyB,
        title: '终端 B',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-iso-A',
            tabs: [tabA, tabB],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      // Remove Tab A
      useLayoutTreeStore.getState().removeTab(leafId, 'tab-iso-A');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === keyA)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === keyA_split1)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === keyA_split2)).toBe(true);
      });

      // Tab B and its splits MUST NOT be killed
      expect(killedPtys.some((k) => k.sessionId === keyB)).toBe(false);
      expect(killedPtys.some((k) => k.sessionId === keyB_split1)).toBe(false);

      expect(ptyRegistry.get(keyB)).toBe('pty-B');
      expect(ptyRegistry.get(keyB_split1)).toBe('pty-B-1');
      expect(ptyRegistry.size).toBe(2);
    });

    it('Probe 2.3: In-place replace of terminal tab with split children kills both primary and child split PTYs', async () => {
      const primaryKey = 'term-rep-with-splits';
      const splitChild = `${primaryKey}:split-child`;

      ptyRegistry.bind(primaryKey, 'pty-prim');
      ptyRegistry.bind(splitChild, 'pty-child');

      const leafId = 'leaf-rep-split';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-rep-sp',
        terminalKey: primaryKey,
        title: '分屏终端',
      } as unknown as SessionTab;

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-rep-sp',
            tabs: [termTab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: leafId,
      });

      useLayoutTreeStore
        .getState()
        .replaceActiveSessionInLeaf(leafId, 'sess-new-chat-555');

      await vi.waitFor(() => {
        expect(killedPtys.some((k) => k.sessionId === primaryKey)).toBe(true);
        expect(killedPtys.some((k) => k.sessionId === splitChild)).toBe(true);
      });

      expect(ptyRegistry.has(primaryKey)).toBe(false);
      expect(ptyRegistry.has(splitChild)).toBe(false);
    });
  });

  // =========================================================================
  // PROBE 3: Tracker Timer Cleanup
  // =========================================================================
  describe('Probe 3: Tracker Timer Cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('Probe 3.1: completeRun sets 3000ms decay timer; advancing past 3000ms clears it and removes run', () => {
      const store = useSessionExecutionTrackerStore.getState();
      store.startRun('sess-t1', 'run-1');
      store.completeRun('sess-t1');

      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-t1']
      ).toBeDefined();
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-t1']?.stage
      ).toBe('just_completed');

      // Halfway through decay window: still exists
      vi.advanceTimersByTime(1500);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-t1']
      ).toBeDefined();

      // At 3000ms: expires and removed cleanly
      vi.advanceTimersByTime(1500);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-t1']
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-t1']
      ).toBeUndefined();
    });

    it('Probe 3.2: Re-starting session clears existing decay timer via clearTimeout and avoids premature deletion', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const store = useSessionExecutionTrackerStore.getState();

      store.startRun('sess-t2', 'run-old');
      store.completeRun('sess-t2');

      const originalTimerId =
        useSessionExecutionTrackerStore.getState().decayTimers['sess-t2'];
      expect(originalTimerId).toBeDefined();

      // Advance 1000ms
      vi.advanceTimersByTime(1000);

      // Re-start session (e.g. user sends message)
      store.startRun('sess-t2', 'run-new', 'streaming_text');

      // clearTimeout MUST have been invoked with originalTimerId
      expect(clearTimeoutSpy).toHaveBeenCalledWith(originalTimerId);
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-t2']
      ).toBeUndefined();

      // Advance 2500ms (t = 3500ms since completeRun)
      vi.advanceTimersByTime(2500);

      // Session MUST NOT be deleted by the previous timer
      const item =
        useSessionExecutionTrackerStore.getState().activeRuns['sess-t2'];
      expect(item).toBeDefined();
      expect(item?.runId).toBe('run-new');
      expect(item?.stage).toBe('streaming_text');

      clearTimeoutSpy.mockRestore();
    });

    it('Probe 3.3: High-frequency churn: 50 consecutive start/complete cycles clear old timers without leaking', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const store = useSessionExecutionTrackerStore.getState();

      for (let i = 0; i < 50; i++) {
        store.startRun('sess-churn', `run-${i}`, 'thinking');
        store.completeRun('sess-churn');
      }

      // Exactly 1 timer should remain in decayTimers
      const keys = Object.keys(
        useSessionExecutionTrackerStore.getState().decayTimers
      );
      expect(keys).toEqual(['sess-churn']);

      // clearTimeout must have been called at least 49 times
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(49);

      // Advance 3000ms to allow final timer to cleanly expire
      vi.advanceTimersByTime(3000);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-churn']
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-churn']
      ).toBeUndefined();

      clearTimeoutSpy.mockRestore();
    });

    it('Probe 3.4: removeRun explicitly clears the decay timer and deletes entry from store', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const store = useSessionExecutionTrackerStore.getState();

      store.startRun('sess-remove-timer', 'run-rm');
      store.completeRun('sess-remove-timer');

      const timerId =
        useSessionExecutionTrackerStore.getState().decayTimers[
          'sess-remove-timer'
        ];
      expect(timerId).toBeDefined();

      store.removeRun('sess-remove-timer');

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns[
          'sess-remove-timer'
        ]
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers[
          'sess-remove-timer'
        ]
      ).toBeUndefined();

      // Advancing time past 3000ms has zero effect
      vi.advanceTimersByTime(5000);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns[
          'sess-remove-timer'
        ]
      ).toBeUndefined();

      clearTimeoutSpy.mockRestore();
    });

    it('Probe 3.5: clearAllRuns clears all pending timers across N concurrent sessions', () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const store = useSessionExecutionTrackerStore.getState();

      // Launch and complete 10 sessions
      for (let i = 0; i < 10; i++) {
        store.startRun(`sess-batch-${i}`, `run-${i}`);
        store.completeRun(`sess-batch-${i}`);
      }

      expect(
        Object.keys(useSessionExecutionTrackerStore.getState().decayTimers)
          .length
      ).toBe(10);

      store.clearAllRuns();

      expect(
        Object.keys(useSessionExecutionTrackerStore.getState().decayTimers)
          .length
      ).toBe(0);
      expect(
        Object.keys(useSessionExecutionTrackerStore.getState().activeRuns)
          .length
      ).toBe(0);
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(10);

      // Advance time by 10s: zero callbacks execute
      vi.advanceTimersByTime(10000);
      expect(useSessionExecutionTrackerStore.getState().activeRuns).toEqual({});

      clearTimeoutSpy.mockRestore();
    });

    it('Probe 3.6: Multi-session independent decay: expiry of session A does not disturb session B', () => {
      const store = useSessionExecutionTrackerStore.getState();

      // Session A completes at t=0
      store.startRun('sess-A', 'run-A');
      store.completeRun('sess-A');

      // 1500ms later, Session B completes at t=1500
      vi.advanceTimersByTime(1500);
      store.startRun('sess-B', 'run-B');
      store.completeRun('sess-B');

      // Advance 1500ms more (total t=3000ms for Session A)
      vi.advanceTimersByTime(1500);

      // Session A must be expired and removed
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-A']
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-A']
      ).toBeUndefined();

      // Session B must STILL be in just_completed decay window (only 1500ms has elapsed for B)
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-B']
      ).toBeDefined();
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-B']?.stage
      ).toBe('just_completed');
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-B']
      ).toBeDefined();

      // Advance another 1500ms (total t=3000ms for Session B)
      vi.advanceTimersByTime(1500);

      // Now Session B is also cleanly removed
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-B']
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-B']
      ).toBeUndefined();
    });
  });

  // =========================================================================
  // PROBE 4: Event Listener Cleanup
  // =========================================================================
  describe('Probe 4: Event Listener Cleanup on Popover Mount/Unmount', () => {
    it('Probe 4.1: Mounting and unmounting Popover without opening has zero net listener leak', () => {
      const docAddSpy = vi.spyOn(document, 'addEventListener');
      const docRemoveSpy = vi.spyOn(document, 'removeEventListener');
      const winAddSpy = vi.spyOn(window, 'addEventListener');
      const winRemoveSpy = vi.spyOn(window, 'removeEventListener');

      const initialDocAdds = docAddSpy.mock.calls.length;
      const initialDocRms = docRemoveSpy.mock.calls.length;
      const initialWinAdds = winAddSpy.mock.calls.length;
      const initialWinRms = winRemoveSpy.mock.calls.length;

      const { unmount } = render(
        <NewTabLauncherPopover leafId="leaf-p4-closed" />
      );
      unmount();

      const docDelta =
        docAddSpy.mock.calls.length -
        initialDocAdds -
        (docRemoveSpy.mock.calls.length - initialDocRms);
      const winDelta =
        winAddSpy.mock.calls.length -
        initialWinAdds -
        (winRemoveSpy.mock.calls.length - initialWinRms);

      expect(docDelta).toBe(0);
      expect(winDelta).toBe(0);

      docAddSpy.mockRestore();
      docRemoveSpy.mockRestore();
      winAddSpy.mockRestore();
      winRemoveSpy.mockRestore();
    });

    it('Probe 4.2: Unmounting Popover WHILE OPEN cleans up all Radix portal and document listeners', () => {
      const docListeners = new Map<
        string,
        Array<(...args: unknown[]) => void>
      >();

      const origAdd = document.addEventListener.bind(document);
      const origRemove = document.removeEventListener.bind(document);

      vi.spyOn(document, 'addEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          if (!docListeners.has(type)) docListeners.set(type, []);
          docListeners.get(type)!.push(listener);
          return origAdd(type, listener, options);
        }
      );

      vi.spyOn(document, 'removeEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          if (docListeners.has(type)) {
            const list = docListeners.get(type)!;
            const idx = list.indexOf(listener);
            if (idx >= 0) list.splice(idx, 1);
          }
          return origRemove(type, listener, options);
        }
      );

      const { unmount } = render(
        <NewTabLauncherPopover leafId="leaf-p4-open" />
      );

      // Open popover
      const plusTrigger = screen.getByRole('button', { name: '新对话' });
      act(() => {
        fireEvent.click(plusTrigger);
      });

      // Verify popover portal content is mounted
      expect(
        document.querySelector('[data-radix-popper-content-wrapper]')
      ).not.toBeNull();

      // Unmount while open
      act(() => {
        unmount();
      });

      // Verify portal content was unmounted from DOM
      expect(
        document.querySelector('[data-radix-popper-content-wrapper]')
      ).toBeNull();

      // Check remaining active document listeners registered during the popover lifecycle
      let remainingCount = 0;
      docListeners.forEach((arr) => {
        remainingCount += arr.length;
      });

      expect(remainingCount).toBe(0);

      vi.restoreAllMocks();
    });

    it('Probe 4.3: Opening, dismissing with Escape, and unmounting leaves zero lingering listeners', () => {
      const docListeners = new Map<
        string,
        Array<(...args: unknown[]) => void>
      >();

      const origAdd = document.addEventListener.bind(document);
      const origRemove = document.removeEventListener.bind(document);

      vi.spyOn(document, 'addEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          if (!docListeners.has(type)) docListeners.set(type, []);
          docListeners.get(type)!.push(listener);
          return origAdd(type, listener, options);
        }
      );

      vi.spyOn(document, 'removeEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          if (docListeners.has(type)) {
            const list = docListeners.get(type)!;
            const idx = list.indexOf(listener);
            if (idx >= 0) list.splice(idx, 1);
          }
          return origRemove(type, listener, options);
        }
      );

      const { unmount } = render(
        <NewTabLauncherPopover leafId="leaf-p4-esc" />
      );

      const plusTrigger = screen.getByRole('button', { name: '新对话' });
      act(() => {
        fireEvent.click(plusTrigger);
      });

      // Press Escape
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      act(() => {
        unmount();
      });

      let remainingCount = 0;
      docListeners.forEach((arr) => {
        remainingCount += arr.length;
      });

      expect(remainingCount).toBe(0);
      vi.restoreAllMocks();
    });

    it('Probe 4.4: 25 rapid mount/open/close/unmount cycles show ZERO listener accumulation', () => {
      const origAdd = document.addEventListener.bind(document);
      const origRemove = document.removeEventListener.bind(document);

      const trackedListeners = new Set<(...args: unknown[]) => void>();
      let uncountedRemoves = 0;

      vi.spyOn(document, 'addEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          trackedListeners.add(listener);
          return origAdd(type, listener, options);
        }
      );

      vi.spyOn(document, 'removeEventListener').mockImplementation(
        (type: string, listener: any, options?: any) => {
          if (trackedListeners.has(listener)) {
            trackedListeners.delete(listener);
          } else {
            uncountedRemoves++;
          }
          return origRemove(type, listener, options);
        }
      );

      for (let i = 0; i < 25; i++) {
        const { unmount } = render(
          <NewTabLauncherPopover leafId={`leaf-cycle-${i}`} />
        );
        const plusTrigger = screen.getByRole('button', { name: '新对话' });
        act(() => {
          fireEvent.click(plusTrigger);
        });
        act(() => {
          unmount();
        });
      }

      // No lingering listeners should remain from the 25 cycles
      expect(trackedListeners.size).toBe(0);

      vi.restoreAllMocks();
    });
  });
});
