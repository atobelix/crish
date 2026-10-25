// @vitest-environment jsdom
import React, { lazy } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TreeLeafPanel } from '../TreeLeafPanel';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import { useLayoutStore } from '../../../store/layoutStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import { useSessionExecutionTrackerStore } from '../../../store/sessionExecutionTrackerStore';
import {
  createSessionTab,
  createTerminalTab,
  createBrowserTab,
  createDraftTab,
  findDuplicateRealSessionIds,
  findTabBySessionId,
  isChatTab,
  isTerminalTab,
  isBrowserTab,
  type UnifiedTab,
} from '../../../store/layout-tree/sessionTabModel';
import {
  collectLeaves,
  findNodeById,
  isBranch,
  isLeaf,
} from '../../../store/layout-tree/operations';
import type {
  LayoutNode,
  LayoutLeaf,
  LayoutBranch,
} from '../../../store/layout-tree/types';
import {
  registerBuiltInViews,
  resetBuiltInViewsRegistrationFlagForTesting,
  type ViewFactoryMap,
  type ViewRenderContext,
} from '../../../services/view-registry';
import { getCompositionRoot } from '../../../app/compositionRoot';

// ── Mock Tauri APIs and PTY Registry ─────────────────────────────────
const ptyMocks = vi.hoisted(() => ({
  ensurePtyForSession: vi.fn(async () => 'pty-mock-empirical'),
  killPtyForSession: vi.fn(async () => undefined),
  killPtyForSessionBackground: vi.fn(),
  killAllPtys: vi.fn(async () => undefined),
}));

vi.mock('../../../api/ptyRegistry', () => ptyMocks);

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

// ── View Registry Setup for Dynamic Resolution ─────────────────────────
const testViews: ViewFactoryMap = {
  chat: () => (ctx: ViewRenderContext) => (
    <div
      data-testid={`view-chat-${ctx.sessionId || 'draft'}`}
      data-session={ctx.sessionId}
    >
      Chat View: {ctx.sessionId || 'draft'}
    </div>
  ),
  terminal: () => (ctx: ViewRenderContext) => (
    <div
      data-testid={`view-terminal-${ctx.params?.terminalKey}`}
      data-cwd={ctx.params?.cwd as string}
    >
      Terminal View: {ctx.params?.terminalKey as string} (
      {ctx.params?.cwd as string})
    </div>
  ),
  preview: () => (ctx: ViewRenderContext) => (
    <div
      data-testid={`view-preview-${ctx.sessionId || 'unknown'}`}
      data-target={ctx.params?.target as string}
    >
      Preview View: {ctx.params?.target as string}
    </div>
  ),
};

function findLeafInTree(node: LayoutNode, id: string): LayoutLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return (
    findLeafInTree(node.children[0], id) || findLeafInTree(node.children[1], id)
  );
}

function countTotalTabsInTree(node: LayoutNode): number {
  const leaves = collectLeaves(node);
  return leaves.reduce((sum, leaf) => sum + leaf.tabs.length, 0);
}

describe('TreeTabManagement Empirical Stress & Invariant Fuzzing Harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBuiltInViewsRegistrationFlagForTesting();
    registerBuiltInViews(testViews);
    useLayoutStore.setState({ chatMainSurface: 'chat' });
  });

  afterEach(() => {
    act(() => {
      useSessionExecutionTrackerStore.getState().clearAllRuns();
    });
  });

  // =========================================================================
  // Challenge 1: Rapid Sequential Session Switches across Deep Multi-Branch Layouts
  // =========================================================================
  describe('Challenge 1: Rapid Sequential Session Switches & Tab Count Conservation (Δ = 0)', () => {
    it('executes 50 rapid sequential switches across 5 asymmetric tree leaves with 30-session pool, strictly preserving tab count and zero duplicates', async () => {
      // 1. Build an asymmetric 5-leaf binary tree:
      // branch1(leaf-1, branch2(leaf-2, branch3(leaf-3, branch4(leaf-4, leaf-5))))
      const leafIds = ['leaf-1', 'leaf-2', 'leaf-3', 'leaf-4', 'leaf-5'];
      const initialLeaves: LayoutLeaf[] = leafIds.map((id, index) => ({
        type: 'leaf',
        id,
        panelId: 'chat',
        activeTabId: `tab-${id}-1`,
        tabs: [
          createSessionTab({
            sessionId: `session-init-${index * 2 + 1}`,
            tabId: `tab-${id}-1`,
            title: `Session ${index * 2 + 1}`,
          }),
          createSessionTab({
            sessionId: `session-init-${index * 2 + 2}`,
            tabId: `tab-${id}-2`,
            title: `Session ${index * 2 + 2}`,
          }),
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      }));

      const branch4: LayoutBranch = {
        type: 'branch',
        id: 'b-4',
        direction: 'vertical',
        splitRatio: 0.5,
        children: [initialLeaves[3]!, initialLeaves[4]!],
      };
      const branch3: LayoutBranch = {
        type: 'branch',
        id: 'b-3',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [initialLeaves[2]!, branch4],
      };
      const branch2: LayoutBranch = {
        type: 'branch',
        id: 'b-2',
        direction: 'vertical',
        splitRatio: 0.5,
        children: [initialLeaves[1]!, branch3],
      };
      const rootBranch: LayoutBranch = {
        type: 'branch',
        id: 'b-1',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [initialLeaves[0]!, branch2],
      };

      const initialTotalTabs = 10; // 5 leaves * 2 tabs

      useLayoutTreeStore.setState({
        tree: { version: 3, root: rootBranch },
        activeLeafId: 'leaf-1',
      });

      // Populate initial sessions + 30 pool sessions in sessionStore
      const initSessions = Array.from({ length: 10 }, (_, i) => ({
        id: `session-init-${i + 1}`,
        title: `Session ${i + 1}`,
        folder: '默认',
        messages: [],
      }));
      const poolSessions = Array.from({ length: 30 }, (_, i) => ({
        id: `session-pool-${i + 1}`,
        title: `Pool Session ${i + 1}`,
        folder: '默认',
        messages: [],
      }));
      const sessions = [...initSessions, ...poolSessions];
      useSessionStore.setState({
        sessions: sessions as any,
        sessionsById: Object.fromEntries(sessions.map((s) => [s.id, s])) as any,
        activeSessionId: 'session-init-1',
      });

      // Pseudo-random deterministic generator for repeatability
      let seed = 42;
      const pseudoRandom = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      // Execute 50 rapid sequential switches
      for (let step = 0; step < 50; step++) {
        const targetLeafIdx = Math.floor(pseudoRandom() * leafIds.length);
        const targetLeafId = leafIds[targetLeafIdx]!;

        // 70% chance from 30-session pool, 30% chance from initial sessions
        const isFromPool = pseudoRandom() > 0.3;
        const targetSessionId = isFromPool
          ? `session-pool-${Math.floor(pseudoRandom() * 30) + 1}`
          : `session-init-${Math.floor(pseudoRandom() * 10) + 1}`;

        // Focus target leaf first, then open session
        useLayoutTreeStore.setState({ activeLeafId: targetLeafId });

        await act(async () => {
          useWorkspaceShellStore
            .getState()
            .openOrFocusSession(targetSessionId, {
              activeLeafId: targetLeafId,
            });
        });

        const currentRoot = useLayoutTreeStore.getState().tree.root;

        // Invariant 1: Total tabs across tree must strictly equal initialTotalTabs (Δ = 0)
        const currentTotalTabs = countTotalTabsInTree(currentRoot);
        expect(
          currentTotalTabs,
          `Step ${step}: In-place reuse violated! Total tabs changed from ${initialTotalTabs} to ${currentTotalTabs}`
        ).toBe(initialTotalTabs);

        // Invariant 2: Leaf count must strictly remain 5
        const currentLeaves = collectLeaves(currentRoot);
        expect(currentLeaves).toHaveLength(5);

        // Invariant 3: Zero duplicate real session bindings across the entire tree
        const duplicates = findDuplicateRealSessionIds(currentRoot);
        expect(
          duplicates.size,
          `Step ${step}: Duplicate real session bindings detected: ${Array.from(duplicates.keys()).join(', ')}`
        ).toBe(0);

        // Invariant 4: Every leaf must have valid activeTabId that exists in leaf.tabs
        for (const leaf of currentLeaves) {
          expect(leaf.tabs.length).toBeGreaterThan(0);
          const activeHit = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
          expect(
            activeHit,
            `Step ${step}: Leaf ${leaf.id} has invalid activeTabId ${leaf.activeTabId}`
          ).toBeDefined();
        }

        // Invariant 5: Global active session matches targetSessionId
        expect(useSessionStore.getState().activeSessionId).toBe(
          targetSessionId
        );
      }
    });
  });

  // =========================================================================
  // Challenge 2: Rapid Draft Creation, Materialization & Sidebar Transitions
  // =========================================================================
  describe('Challenge 2: Draft State Transitions & Anti-Leakage Invariants', () => {
    it('handles 20 rapid cycles of blank draft entering followed by sidebar clicks without leaking ghost drafts', async () => {
      const leafId = 'leaf-draft-fuzz';
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: '',
            tabs: [],
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

      for (let i = 1; i <= 20; i++) {
        const sid = `draft-materialize-session-${i}`;

        // 1. Enter blank draft mode
        await act(async () => {
          if (
            typeof useLayoutTreeStore.getState().resetToSingleDraftLeaf ===
            'function'
          ) {
            useLayoutTreeStore.getState().resetToSingleDraftLeaf?.();
          } else {
            useLayoutTreeStore.setState({
              tree: {
                version: 3,
                root: {
                  type: 'leaf',
                  id: leafId,
                  panelId: 'chat',
                  activeTabId: '',
                  tabs: [],
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
          }
        });

        // Verify draft state: activeTabId === '', tabs.length === 0
        let root = useLayoutTreeStore.getState().tree.root;
        const currentLeafId =
          useLayoutTreeStore.getState().activeLeafId ||
          (root.type === 'leaf' ? root.id : leafId);
        let leaf = findLeafInTree(root, currentLeafId);
        expect(leaf?.activeTabId).toBe('');
        expect(leaf?.tabs).toHaveLength(0);

        // 2. Click sidebar session -> smooth materialization
        await act(async () => {
          useWorkspaceShellStore
            .getState()
            .openOrFocusSession(sid, { activeLeafId: currentLeafId });
        });

        // Verify materialized: exactly 1 tab, non-empty activeTabId, matches sid
        root = useLayoutTreeStore.getState().tree.root;
        leaf = findLeafInTree(root, currentLeafId);
        expect(leaf?.tabs).toHaveLength(1);
        expect(leaf?.tabs[0].sessionId).toBe(sid);
        expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);

        // Invariant: no __pending_draft__ session ID remains committed
        expect(leaf?.tabs[0].sessionId.startsWith('__pending_draft__')).toBe(
          false
        );
      }
    });

    it('materializes draft cleanly when leaf has committed tabs plus an active draft slot', async () => {
      const leafId = 'leaf-committed-plus-draft';
      const existingTab = createSessionTab({
        sessionId: 'existing-committed-1',
        title: 'Committed 1',
      });

      // Leaf has 1 committed tab, but activeTabId is '' (user clicked '+' to compose)
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: '', // Draft mode
            tabs: [existingTab],
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

      // User clicks sidebar session
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('new-session-from-sidebar');
      });

      const root = useLayoutTreeStore.getState().tree.root;
      const leaf = findLeafInTree(root, leafId);

      // Invariant: Draft slot is materialized as a new tab alongside existing tab (tabs.length === 2)
      expect(leaf?.tabs).toHaveLength(2);
      expect(leaf?.tabs.map((t) => t.sessionId)).toEqual([
        'existing-committed-1',
        'new-session-from-sidebar',
      ]);
      expect(leaf?.activeTabId).toBe(leaf?.tabs[1].tabId);

      // Now with 2 tabs, click a 3rd session from sidebar -> should in-place replace active tab (Δ = 0)
      await act(async () => {
        useWorkspaceShellStore.getState().openOrFocusSession('third-session');
      });

      const leafAfterReplace = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      expect(leafAfterReplace?.tabs).toHaveLength(2);
      expect(leafAfterReplace?.tabs.map((t) => t.sessionId)).toEqual([
        'existing-committed-1',
        'third-session',
      ]);
    });
  });

  // =========================================================================
  // Challenge 3: Deep Tree Splits & Mixed Tab Polymorphism in All 4 Directions
  // =========================================================================
  describe('Challenge 3: Deep Tree Splits & Mixed Tab Polymorphism (Chat, Terminal, Browser)', () => {
    it('performs deep 6-level recursive splits with mixed tabs in left, right, top, bottom directions, maintaining tree balance and metadata', async () => {
      const srcLeafId = 'leaf-root-mixed';
      const chatTab = createSessionTab({
        tabId: 'tab-chat-1',
        sessionId: 'sess-chat-1',
        title: 'Deep Chat',
      });
      const termTab = createTerminalTab({
        tabId: 'tab-term-1',
        terminalKey: 'term-key-alpha',
        cwd: 'C:/Software/conex',
        title: 'Terminal 1',
      });
      const browserTab = createBrowserTab({
        tabId: 'tab-browser-1',
        url: 'http://localhost:5173/preview',
        title: 'Crish Web Preview',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: srcLeafId,
            panelId: 'chat',
            activeTabId: 'tab-chat-1',
            tabs: [chatTab, termTab, browserTab],
            dock: {
              collapsed: true,
              openPanelIds: [],
              activePanelId: null,
              widthRatio: 0.5,
            },
          },
        },
        activeLeafId: srcLeafId,
      });

      // Split 1: Split Terminal Tab to 'bottom' (vertical)
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(srcLeafId, 'tab-term-1', srcLeafId, 'bottom');
      });

      let root = useLayoutTreeStore.getState().tree.root;
      expect(root.type).toBe('branch');
      expect((root as LayoutBranch).direction).toBe('vertical');
      expect(collectLeaves(root)).toHaveLength(2);

      const bottomLeaf = (root as LayoutBranch).children[1] as LayoutLeaf;
      expect(bottomLeaf.tabs).toHaveLength(1);
      expect(isTerminalTab(bottomLeaf.tabs[0])).toBe(true);
      expect((bottomLeaf.tabs[0] as any).cwd).toBe('C:/Software/conex');

      // Split 2: Split Browser Tab from top leaf to 'right' (horizontal)
      const topLeaf = (root as LayoutBranch).children[0] as LayoutLeaf;
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(topLeaf.id, 'tab-browser-1', topLeaf.id, 'right');
      });

      root = useLayoutTreeStore.getState().tree.root;
      expect(collectLeaves(root)).toHaveLength(3);

      // Find the leaf containing browser tab
      const browserLeaf = collectLeaves(root).find((l) =>
        l.tabs.some((t) => t.tabId === 'tab-browser-1')
      );
      expect(browserLeaf).toBeDefined();
      expect(isBrowserTab(browserLeaf!.tabs[0])).toBe(true);
      expect((browserLeaf!.tabs[0] as any).url).toBe(
        'http://localhost:5173/preview'
      );

      // Split 3: Split Chat Tab to 'top' (vertical)
      const chatLeaf = collectLeaves(root).find((l) =>
        l.tabs.some((t) => t.tabId === 'tab-chat-1')
      )!;
      // Add a dummy tab to chatLeaf first so splitTab can split
      const dummyTab = createSessionTab({
        tabId: 'tab-chat-dummy',
        sessionId: 'sess-dummy',
        title: 'Dummy',
      });
      await act(async () => {
        useLayoutTreeStore.getState().addTab(chatLeaf.id, dummyTab);
      });

      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(chatLeaf.id, 'tab-chat-1', chatLeaf.id, 'top');
      });

      root = useLayoutTreeStore.getState().tree.root;
      expect(collectLeaves(root)).toHaveLength(4);

      // Split 4: Split to 'left' (horizontal)
      const leavesBefore4 = collectLeaves(root);
      const splitTarget = leavesBefore4[0]!;
      const extraTab = createTerminalTab({
        tabId: 'tab-term-2',
        terminalKey: 'term-key-beta',
        cwd: 'C:/Software/conex/crates',
        title: 'Terminal 2',
      });
      await act(async () => {
        useLayoutTreeStore.getState().addTab(splitTarget.id, extraTab);
        useLayoutTreeStore
          .getState()
          .splitTab(splitTarget.id, 'tab-term-2', splitTarget.id, 'left');
      });

      root = useLayoutTreeStore.getState().tree.root;
      expect(collectLeaves(root)).toHaveLength(5);

      // Invariant: Total tabs across all 5 leaves must be conserved (3 initial + 2 added = 5)
      expect(countTotalTabsInTree(root)).toBe(5);

      // Verify all branches have clamped splitRatio
      function verifyTreeInvariants(node: LayoutNode) {
        if (node.type === 'branch') {
          expect(node.splitRatio).toBeGreaterThanOrEqual(0.05);
          expect(node.splitRatio).toBeLessThanOrEqual(0.95);
          expect(node.children).toHaveLength(2);
          verifyTreeInvariants(node.children[0]);
          verifyTreeInvariants(node.children[1]);
        } else {
          expect(node.tabs.length).toBeGreaterThan(0);
          expect(node.activeTabId).toBeTruthy();
        }
      }
      verifyTreeInvariants(root);
    });

    it('moves mixed tabs across distant leaves preserving full polymorphism', async () => {
      const leafA: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-move-A',
        panelId: 'chat',
        activeTabId: 'tab-A-term',
        tabs: [
          createTerminalTab({
            tabId: 'tab-A-term',
            terminalKey: 'term-alpha',
            cwd: 'C:/conex',
          }),
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const leafB: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-move-B',
        panelId: 'chat',
        activeTabId: 'tab-B-web',
        tabs: [
          createBrowserTab({
            tabId: 'tab-B-web',
            url: 'https://example.com',
          }),
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
            id: 'b-move',
            direction: 'horizontal',
            splitRatio: 0.5,
            children: [leafA, leafB],
          },
        },
        activeLeafId: 'leaf-move-A',
      });

      // Move terminal tab from Leaf A into Leaf B at index 0
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .moveTab('leaf-move-A', 'tab-A-term', 'leaf-move-B', 0);
      });

      const root = useLayoutTreeStore.getState().tree.root;
      // Leaf A became empty, so pruneEmptyLeaves pruned it! Leaf B should now be the root leaf!
      expect(root.type).toBe('leaf');
      const survivingLeaf = root as LayoutLeaf;
      expect(survivingLeaf.tabs).toHaveLength(2);
      expect(survivingLeaf.tabs[0].tabId).toBe('tab-A-term');
      expect(isTerminalTab(survivingLeaf.tabs[0])).toBe(true);
      expect(survivingLeaf.tabs[1].tabId).toBe('tab-B-web');
      expect(isBrowserTab(survivingLeaf.tabs[1])).toBe(true);
    });
  });

  // =========================================================================
  // Challenge 4: Adversarial Edge Cases & Vulnerability Probing
  // =========================================================================
  describe('Challenge 4: Adversarial Architectural Vulnerability Probing', () => {
    it('Probe 1: Verifies whether workspaceShellStore.activateTab can activate a Terminal or Browser tab', async () => {
      // In TreeLeafPanel / PaneHeader, clicking a tab calls sessionShell().activateTab(leafId, tabId),
      // which delegates to workspaceShellStore.activateTab(leafId, tabId).
      // Let's test if workspaceShellStore.activateTab succeeds for TerminalTab and BrowserTab.
      const leafId = 'leaf-probe-activation';
      const chatTab = createSessionTab({
        tabId: 't-chat-probe',
        sessionId: 'sess-probe-1',
        title: 'Chat',
      });
      const termTab = createTerminalTab({
        tabId: 't-term-probe',
        terminalKey: 'term-probe-key',
        cwd: 'C:/Software/conex',
        title: 'Terminal Probe',
      });
      const browserTab = createBrowserTab({
        tabId: 't-web-probe',
        url: 'https://docs.rs',
        title: 'Docs',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-chat-probe',
            tabs: [chatTab, termTab, browserTab],
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

      // Try activating the Terminal tab via workspaceShellStore.activateTab
      await act(async () => {
        useWorkspaceShellStore.getState().activateTab(leafId, 't-term-probe');
      });

      const leafAfterTerm = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );

      // EMPIRICAL CHECK: Does workspaceShellStore.activateTab work for terminal tabs?
      // If treeSessionQuery.ts:isSessionTab rejects terminal tabs (because sessionId is undefined),
      // treeFindTabByTabId returns null and activateTab exits early!
      const canActivateTerminalViaShell =
        leafAfterTerm?.activeTabId === 't-term-probe';

      // Now test layoutTreeStore.activateTab directly as baseline
      if (!canActivateTerminalViaShell) {
        // Direct layoutTreeStore.activateTab bypasses treeSessionQuery
        await act(async () => {
          useLayoutTreeStore.getState().activateTab(leafId, 't-term-probe');
        });
        const leafDirect = findLeafInTree(
          useLayoutTreeStore.getState().tree.root,
          leafId
        );
        expect(leafDirect?.activeTabId).toBe('t-term-probe');
      }

      // Assert whether shell activation works
      expect(
        canActivateTerminalViaShell,
        'CRITICAL DEFECT: workspaceShellStore.activateTab failed to activate TerminalTab! Cause: treeSessionQuery.isSessionTab requires sessionId string.'
      ).toBe(true);
    });

    it('Probe 2: Verifies whether TreeLeafPanel properly renders a genuine BrowserTab created via createBrowserTab() without phantom draft hijacking', async () => {
      // Standard createBrowserTab creates a tab with kind: 'browser', url: '...', and sessionId: undefined.
      // If resolveLeafSessionId falls back to mintDraftSessionId(leaf.id), isLeafDraft becomes true,
      // readActiveTab(leaf, true) returns undefined, and TreeLeafPanel renders chat draft instead of preview!
      const leafId = 'leaf-probe-browser-render';
      const browserTab = createBrowserTab({
        tabId: 't-pure-browser',
        url: 'https://conex.dev',
        title: 'Conex Official',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 't-pure-browser',
            tabs: [browserTab],
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

      render(
        <TreeLeafPanel
          leaf={findLeafInTree(
            useLayoutTreeStore.getState().tree.root,
            leafId
          )!}
          rect={{ x: 0, y: 0, width: 1, height: 1 }}
          isActive={true}
        />
      );

      // Should render the preview view, NOT the chat view
      await waitFor(() => {
        expect(
          screen.queryByTestId('view-preview-t-pure-browser')
        ).toBeInTheDocument();
      });

      expect(screen.queryByTestId('view-chat-draft')).not.toBeInTheDocument();
    });
  });
});
