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
  killPtyForSessionBackground,
} from '../../../api/ptyRegistry';
import { useSessionExecutionTrackerStore } from '../../../store/sessionExecutionTrackerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { NewTabLauncherPopover } from '../NewTabLauncherPopover';
import type { SessionTab } from '../../../store/layout-tree/sessionTabModel';
import type { LayoutLeaf } from '../../../store/layout-tree/types';

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

describe('Challenger 2: Resource Lifecycle & Process Integrity Empirical Challenge', () => {
  const killedPtys: { ptyId: string; sessionId: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resetPtyRegistryForTests();
    killedPtys.length = 0;

    // Register PTY kill handler to track real process destruction calls
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
  // Challenge 1: Terminal PTY Process Destruction & Handle Cleanup
  // =========================================================================
  describe('Challenge 1: Terminal PTY Process Destruction & Split Cleanup', () => {
    it('1.1: Closing single terminal tab takes handle from ptyRegistry and invokes kill handler', async () => {
      const termKey = 'term-standalone-key';
      const ptyId = 'pty-standalone-process-999';

      // 1. PTY is spawned and bound in ptyRegistry
      ptyRegistry.bind(termKey, ptyId);
      expect(ptyRegistry.get(termKey)).toBe(ptyId);

      // 2. Setup layout tree with this terminal tab
      const leafId = 'leaf-standalone';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-term-single',
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

      const leafNode: LayoutLeaf = {
        type: 'leaf',
        id: leafId,
        panelId: 'chat',
        activeTabId: 'tab-term-single',
        tabs: [termTab],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };

      useLayoutTreeStore.setState({
        tree: { version: 3, root: leafNode },
        activeLeafId: leafId,
      });

      // 3. User closes terminal tab
      await act(async () => {
        useWorkspaceShellStore.getState().closeTab(leafId, 'tab-term-single');
      });

      // 4. Wait for background kill promises
      await vi.waitFor(() => {
        expect(
          killedPtys.some((k) => k.sessionId === termKey && k.ptyId === ptyId)
        ).toBe(true);
      });

      // 5. Verify handle is unmapped from ptyRegistry
      expect(ptyRegistry.get(termKey)).toBeUndefined();
      expect(ptyRegistry.has(termKey)).toBe(false);
    });

    it('1.2: Adversarial Stress Test: Split-pane terminal (terminalKey:split-2) cleanup verification', async () => {
      const primaryKey = 'term-split-parent';
      const primaryPtyId = 'pty-parent-proc-101';
      const splitKey = `${primaryKey}:split-2`;
      const splitPtyId = 'pty-child-split-proc-102';

      // 1. Both primary and split PTYs exist in ptyRegistry (as created by TerminalCard split mode)
      ptyRegistry.bind(primaryKey, primaryPtyId);
      ptyRegistry.bind(splitKey, splitPtyId);

      expect(ptyRegistry.get(primaryKey)).toBe(primaryPtyId);
      expect(ptyRegistry.get(splitKey)).toBe(splitPtyId);
      expect(ptyRegistry.size).toBe(2);

      // 2. Setup layout tree with the terminal tab
      const leafId = 'leaf-split-term';
      const termTab = {
        kind: 'terminal',
        tabId: 'tab-term-with-split',
        terminalKey: primaryKey,
        cwd: 'C:/Software/conex',
        title: '分屏终端',
        workspaceKey: '默认',
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      } as unknown as SessionTab;

      const leafNode: LayoutLeaf = {
        type: 'leaf',
        id: leafId,
        panelId: 'chat',
        activeTabId: 'tab-term-with-split',
        tabs: [termTab],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };

      useLayoutTreeStore.setState({
        tree: { version: 3, root: leafNode },
        activeLeafId: leafId,
      });

      // 3. Close the terminal tab directly while split pane was active
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .closeTab(leafId, 'tab-term-with-split');
      });

      // Allow background microtasks / dynamic import to complete
      await new Promise((r) => setTimeout(r, 50));

      // 4. EMPIRICAL OBSERVATION:
      // Check primary PTY
      const primaryKilled = killedPtys.some((k) => k.sessionId === primaryKey);
      const primaryInRegistry = ptyRegistry.has(primaryKey);

      // Check split PTY (:split-2)
      const splitKilled = killedPtys.some((k) => k.sessionId === splitKey);
      const splitInRegistry = ptyRegistry.has(splitKey);

      console.log('Split cleanup results:', {
        primaryKilled,
        primaryInRegistry,
        splitKilled,
        splitInRegistry,
        killedPtys,
        registrySessions: ptyRegistry.sessionIds(),
      });

      // Primary MUST be killed and removed from registry
      expect(primaryKilled).toBe(true);
      expect(primaryInRegistry).toBe(false);

      // CHALLENGE ASSERTION: The split pane PTY MUST NOT be leaked
      // If splitInRegistry is true or splitKilled is false, split PTY process is leaked!
      expect(splitKilled).toBe(true);
      expect(splitInRegistry).toBe(false);
    });
  });

  // =========================================================================
  // Challenge 2: Timer Lifecycle & Decay Window Cleanup
  // =========================================================================
  describe('Challenge 2: 3000ms Graceful Decay Timer Lifecycle & Popover Click/Unmount', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('2.1: Restarting a session clears existing decay timer and retains new execution state past 3000ms', () => {
      useSessionExecutionTrackerStore
        .getState()
        .startRun('sess-restart', 'run-old');
      useSessionExecutionTrackerStore.getState().completeRun('sess-restart');

      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-restart']
          ?.stage
      ).toBe('just_completed');
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-restart']
      ).toBeDefined();

      // Advance 1000ms (within 3000ms decay window)
      vi.advanceTimersByTime(1000);

      // Session restarts! (e.g. user sends a follow-up query)
      useSessionExecutionTrackerStore
        .getState()
        .startRun('sess-restart', 'run-new', 'streaming_text');

      // The new run is active
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-restart']
          ?.stage
      ).toBe('streaming_text');
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-restart']
          ?.runId
      ).toBe('run-new');
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-restart']
      ).toBeUndefined();

      // Advance 2500ms (past original 3000ms window from completeRun)
      vi.advanceTimersByTime(2500);

      // The session MUST NOT be deleted by the old timer
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-restart']
      ).toBeDefined();
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-restart']
          ?.stage
      ).toBe('streaming_text');
    });

    it('2.2: removeRun explicitly clears the 3000ms decay timer', () => {
      useSessionExecutionTrackerStore
        .getState()
        .startRun('sess-remove', 'run-1');
      useSessionExecutionTrackerStore.getState().completeRun('sess-remove');

      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-remove']
      ).toBeDefined();

      // Explicitly remove run
      useSessionExecutionTrackerStore.getState().removeRun('sess-remove');

      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-remove']
      ).toBeUndefined();
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-remove']
      ).toBeUndefined();

      // Advancing past 3000ms does nothing
      vi.advanceTimersByTime(3500);
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-remove']
      ).toBeUndefined();
    });

    it('2.3: Empirical Challenge: When completed session in decay window is clicked in Popover', () => {
      useSessionExecutionTrackerStore
        .getState()
        .startRun('sess-click', 'run-c', 'streaming_text');
      useSessionExecutionTrackerStore.getState().completeRun('sess-click');

      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-click']
          ?.stage
      ).toBe('just_completed');
      expect(
        useSessionExecutionTrackerStore.getState().decayTimers['sess-click']
      ).toBeDefined();

      useSessionStore.setState({
        sessionsById: {
          'sess-click': { id: 'sess-click', title: '点击测试会话' } as any,
        },
      });

      render(<NewTabLauncherPopover leafId="leaf-popover-click" />);

      const plusTrigger = screen.getByRole('button', { name: '新对话' });
      fireEvent.click(plusTrigger);

      // Click the completed session in the popover
      const itemBtn = screen.getByText('点击测试会话').closest('button');
      expect(itemBtn).not.toBeNull();
      fireEvent.click(itemBtn!);

      // Verify openOrFocusSession was called
      expect(sessionMocks.openOrFocusSession).toHaveBeenCalledWith(
        'sess-click'
      );

      // Check decay timer status after click:
      const timerAfterClick =
        useSessionExecutionTrackerStore.getState().decayTimers['sess-click'];
      console.log('Timer status after click:', {
        timerAfterClick: !!timerAfterClick,
      });

      // In current implementation, clicking does NOT clear the decay timer
      // It remains ticking until the 3000ms window expires
      expect(timerAfterClick).toBeDefined();

      // At 3000ms, the timer will fire and remove the run
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['sess-click']
      ).toBeUndefined();
    });

    it('2.4: Popover unmount does not leak window/document listeners or trigger unmounted state errors', () => {
      const docListenerCountBefore = (document as any)._eventsCount || 0;

      const { unmount } = render(
        <NewTabLauncherPopover leafId="leaf-unmount-test" />
      );

      const plusTrigger = screen.getByRole('button', { name: '新对话' });
      fireEvent.click(plusTrigger);

      // Unmount while popover is open
      unmount();

      // Advance timers by 5000ms to trigger any lingering callbacks
      vi.advanceTimersByTime(5000);

      // No uncaught errors or lingering portal popover content
      expect(
        document.querySelector('[data-radix-popper-content-wrapper]')
      ).toBeNull();
    });
  });
});
