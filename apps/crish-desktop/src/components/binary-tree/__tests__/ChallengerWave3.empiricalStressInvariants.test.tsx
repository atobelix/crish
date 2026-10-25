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

// ── Mock Tauri APIs and PTY Registry ─────────────────────────────────
const ptyMocks = vi.hoisted(() => ({
  ensurePtyForSession: vi.fn(async () => 'pty-mock-empirical-wave3'),
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
      data-testid={`view-preview-${ctx.params?.target || ctx.sessionId || 'unknown'}`}
      data-target={ctx.params?.target as string}
    >
      Preview View: {ctx.params?.target as string}
    </div>
  ),
};

function registerSessionsInStore(ids: string[]) {
  const existing = useSessionStore.getState().sessions || [];
  const existingById = useSessionStore.getState().sessionsById || {};
  const newSessions = ids.map((id) => ({
    id,
    title: `Session ${id}`,
    folder: '默认',
    messages: [],
  }));
  const merged = [...existing, ...newSessions];
  useSessionStore.setState({
    sessions: merged as any,
    sessionsById: {
      ...existingById,
      ...Object.fromEntries(newSessions.map((s) => [s.id, s])),
    } as any,
  });
}

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

describe('Challenger Wave 3: Empirical Stress & Invariant Probing Harness', () => {
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
  // Probe 1 (In-Place Reuse): 10+ sequential sidebar clicks maintain Delta = 0
  // =========================================================================
  describe('Probe 1 (In-Place Reuse): Sequential Sidebar Clicks Maintain Constant Tab Count (Δ = 0)', () => {
    it('Probe 1.1: 20 rapid sequential clicks on distinct sessions in a single leaf strictly maintain tabs.length === 1 (Δ = 0)', async () => {
      const leafId = 'leaf-probe-1-single';
      const initialTab = createSessionTab({
        sessionId: 'session-init-1',
        tabId: 'tab-init-1',
        title: 'Initial Session',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-init-1',
            tabs: [initialTab],
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

      // Populate 20 mock sessions in sessionStore
      const sessions = Array.from({ length: 20 }, (_, i) => ({
        id: `session-p1-${i + 1}`,
        title: `Session P1-${i + 1}`,
        folder: '默认',
        messages: [
          { id: `m-${i}`, sender: 'user', text: `Message in session ${i + 1}` },
        ],
      }));
      useSessionStore.setState({
        sessions: sessions as any,
        sessionsById: Object.fromEntries(sessions.map((s) => [s.id, s])) as any,
        activeSessionId: 'session-init-1',
      });

      // Execute 20 sequential clicks
      for (let i = 1; i <= 20; i++) {
        const targetSid = `session-p1-${i}`;
        await act(async () => {
          useWorkspaceShellStore.getState().openOrFocusSession(targetSid, {
            activeLeafId: leafId,
          });
        });

        const root = useLayoutTreeStore.getState().tree.root;
        const leaf = findLeafInTree(root, leafId);

        // INVARIANT 1: Tab count must strictly equal 1 (Delta = 0)
        expect(leaf?.tabs).toHaveLength(1);
        expect(countTotalTabsInTree(root)).toBe(1);

        // INVARIANT 2: Active tab matches target session
        expect(leaf?.tabs[0].sessionId).toBe(targetSid);
        expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);

        // INVARIANT 3: Global active session matches target
        expect(useSessionStore.getState().activeSessionId).toBe(targetSid);
      }
    });

    it('Probe 1.2: Multi-leaf tree (3 leaves, 6 tabs) maintains exactly 6 tabs across 30 random sequential switches (Δ = 0)', async () => {
      const leafA: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-A',
        panelId: 'chat',
        activeTabId: 'tab-A-1',
        tabs: [
          createSessionTab({
            sessionId: 's-A1',
            tabId: 'tab-A-1',
            title: 'A1',
          }),
          createSessionTab({
            sessionId: 's-A2',
            tabId: 'tab-A-2',
            title: 'A2',
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
        id: 'leaf-B',
        panelId: 'chat',
        activeTabId: 'tab-B-1',
        tabs: [
          createSessionTab({
            sessionId: 's-B1',
            tabId: 'tab-B-1',
            title: 'B1',
          }),
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const leafC: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-C',
        panelId: 'chat',
        activeTabId: 'tab-C-1',
        tabs: [
          createSessionTab({
            sessionId: 's-C1',
            tabId: 'tab-C-1',
            title: 'C1',
          }),
          createSessionTab({
            sessionId: 's-C2',
            tabId: 'tab-C-2',
            title: 'C2',
          }),
          createSessionTab({
            sessionId: 's-C3',
            tabId: 'tab-C-3',
            title: 'C3',
          }),
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };

      const branchBC: LayoutBranch = {
        type: 'branch',
        id: 'b-BC',
        direction: 'vertical',
        splitRatio: 0.5,
        children: [leafB, leafC],
      };
      const rootBranch: LayoutBranch = {
        type: 'branch',
        id: 'b-root',
        direction: 'horizontal',
        splitRatio: 0.4,
        children: [leafA, branchBC],
      };

      const initialTotalTabs = 6;
      useLayoutTreeStore.setState({
        tree: { version: 3, root: rootBranch },
        activeLeafId: 'leaf-A',
      });

      const poolSessions = Array.from({ length: 30 }, (_, i) => ({
        id: `pool-s-${i + 1}`,
        title: `Pool Session ${i + 1}`,
        folder: '默认',
        messages: [],
      }));
      useSessionStore.setState({
        sessions: poolSessions as any,
        sessionsById: Object.fromEntries(
          poolSessions.map((s) => [s.id, s])
        ) as any,
        activeSessionId: 's-A1',
      });

      const leafIds = ['leaf-A', 'leaf-B', 'leaf-C'];
      for (let step = 0; step < 30; step++) {
        const targetLeafId = leafIds[step % leafIds.length]!;
        const targetSid = `pool-s-${step + 1}`;

        useLayoutTreeStore.setState({ activeLeafId: targetLeafId });

        await act(async () => {
          useWorkspaceShellStore.getState().openOrFocusSession(targetSid, {
            activeLeafId: targetLeafId,
          });
        });

        const root = useLayoutTreeStore.getState().tree.root;

        // Invariant: Total tabs across tree must strictly equal initialTotalTabs (Δ = 0)
        expect(countTotalTabsInTree(root)).toBe(initialTotalTabs);

        // Invariant: Individual leaf tab counts must be conserved
        const currentLeafA = findLeafInTree(root, 'leaf-A');
        const currentLeafB = findLeafInTree(root, 'leaf-B');
        const currentLeafC = findLeafInTree(root, 'leaf-C');
        expect(currentLeafA?.tabs).toHaveLength(2);
        expect(currentLeafB?.tabs).toHaveLength(1);
        expect(currentLeafC?.tabs).toHaveLength(3);

        // Zero duplicate sessions in tree
        const duplicates = findDuplicateRealSessionIds(root);
        expect(duplicates.size).toBe(0);
      }
    });

    it('Probe 1.3: Clicking an already open session in another leaf switches focus without tab creation (Δ = 0)', async () => {
      registerSessionsInStore(['s-already-open', 's-other']);

      const leafA: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-A',
        panelId: 'chat',
        activeTabId: 'tab-A-1',
        tabs: [
          createSessionTab({
            sessionId: 's-already-open',
            tabId: 'tab-A-1',
            title: 'Open in A',
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
        id: 'leaf-B',
        panelId: 'chat',
        activeTabId: 'tab-B-1',
        tabs: [
          createSessionTab({
            sessionId: 's-other',
            tabId: 'tab-B-1',
            title: 'Open in B',
          }),
        ],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const rootBranch: LayoutBranch = {
        type: 'branch',
        id: 'b-root',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [leafA, leafB],
      };

      useLayoutTreeStore.setState({
        tree: { version: 3, root: rootBranch },
        activeLeafId: 'leaf-B', // Active on Leaf B
      });

      // User on Leaf B clicks 's-already-open' (which is in Leaf A)
      await act(async () => {
        useWorkspaceShellStore.getState().openOrFocusSession('s-already-open');
      });

      const root = useLayoutTreeStore.getState().tree.root;

      // Invariant: Total tabs remains 2 (Δ = 0)
      expect(countTotalTabsInTree(root)).toBe(2);

      // Invariant: Focus shifts to Leaf A
      expect(useLayoutTreeStore.getState().activeLeafId).toBe('leaf-A');
      expect(useSessionStore.getState().activeSessionId).toBe('s-already-open');
    });
  });

  // =========================================================================
  // Probe 2 (Draft Materialization): Materializing blank drafts does not produce zombie/phantom tabs
  // =========================================================================
  describe('Probe 2 (Draft Materialization): Clean Materialization Without Zombie/Phantom Tabs', () => {
    it('Probe 2.1: Blank draft leaf (activeTabId: "", tabs: []) materializes cleanly into exactly 1 tab without ghost residuals', async () => {
      const leafId = 'leaf-blank-draft';
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

      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-clean-mat');
      });

      const leaf = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      expect(leaf?.tabs).toHaveLength(1);
      expect(leaf?.tabs[0].sessionId).toBe('session-clean-mat');
      expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);

      // Invariant: Zero phantom draft session IDs
      expect(leaf?.tabs[0].sessionId.startsWith('__pending_draft__')).toBe(
        false
      );
    });

    it('Probe 2.2: Leaf with committed tabs + draft slot materializes without duplicating entries', async () => {
      const leafId = 'leaf-committed-plus-draft';
      const committedTab = createSessionTab({
        sessionId: 'session-committed',
        tabId: 'tab-committed',
        title: 'Committed Tab',
      });

      // User opened a draft on a leaf that already has a tab
      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: '', // Draft mode active
            tabs: [committedTab],
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

      // User selects a session from sidebar
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-sidebar-pick');
      });

      let leaf = findLeafInTree(
        useLayoutTreeStore.getState().tree.root,
        leafId
      );
      expect(leaf?.tabs).toHaveLength(2);
      expect(leaf?.tabs[1].sessionId).toBe('session-sidebar-pick');
      expect(leaf?.activeTabId).toBe(leaf?.tabs[1].tabId);

      // Immediately select another session -> should in-place replace the active tab (Δ = 0)
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-in-place-after-mat');
      });

      leaf = findLeafInTree(useLayoutTreeStore.getState().tree.root, leafId);
      expect(leaf?.tabs).toHaveLength(2);
      expect(leaf?.tabs.map((t) => t.sessionId)).toEqual([
        'session-committed',
        'session-in-place-after-mat',
      ]);
      expect(leaf?.activeTabId).toBe(leaf?.tabs[1].tabId);
    });

    it('Probe 2.3: 25 rapid iterations of draft-enter followed by sidebar materialization accumulates zero orphan tabs', async () => {
      const leafId = 'leaf-fuzz-draft';
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

      for (let i = 1; i <= 25; i++) {
        // Reset to draft
        act(() => {
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
        });

        // Materialize
        await act(async () => {
          useWorkspaceShellStore
            .getState()
            .openOrFocusSession(`session-rapid-${i}`, {
              activeLeafId: leafId,
            });
        });

        const leaf = findLeafInTree(
          useLayoutTreeStore.getState().tree.root,
          leafId
        );
        expect(leaf?.tabs).toHaveLength(1);
        expect(leaf?.tabs[0].sessionId).toBe(`session-rapid-${i}`);
        expect(leaf?.activeTabId).toBe(leaf?.tabs[0].tabId);
      }
    });

    it('Probe 2.4: Materializing when the clicked session is ALREADY open elsewhere focuses that tab and leaves draft clean', async () => {
      registerSessionsInStore(['session-in-B']);

      const leafA: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-A',
        panelId: 'chat',
        activeTabId: '', // Draft mode in Leaf A
        tabs: [],
        dock: {
          collapsed: true,
          openPanelIds: [],
          activePanelId: null,
          widthRatio: 0.5,
        },
      };
      const leafB: LayoutLeaf = {
        type: 'leaf',
        id: 'leaf-B',
        panelId: 'chat',
        activeTabId: 'tab-B-1',
        tabs: [
          createSessionTab({
            sessionId: 'session-in-B',
            tabId: 'tab-B-1',
            title: 'In Leaf B',
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
            id: 'b-root',
            direction: 'horizontal',
            splitRatio: 0.5,
            children: [leafA, leafB],
          },
        },
        activeLeafId: 'leaf-A',
      });

      // User in Leaf A clicks 'session-in-B'
      await act(async () => {
        useWorkspaceShellStore.getState().openOrFocusSession('session-in-B');
      });

      const root = useLayoutTreeStore.getState().tree.root;

      // Invariant: Total tabs across tree remains 1 (no duplicate tab created)
      expect(countTotalTabsInTree(root)).toBe(1);

      // Focus shifted to Leaf B
      expect(useLayoutTreeStore.getState().activeLeafId).toBe('leaf-B');
      expect(useSessionStore.getState().activeSessionId).toBe('session-in-B');
    });
  });

  // =========================================================================
  // Probe 3 (Split Invariants): Drag-and-drop splitting Terminal and Browser across all 4 directions
  // =========================================================================
  describe('Probe 3 (Split Invariants): Terminal & Browser 4-Direction Split Preserves Topology & Metadata', () => {
    it('Probe 3.1: Terminal Tab splits across all 4 directions (top, bottom, left, right) strictly preserving PTY cwd and terminalKey', async () => {
      const directions: Array<'top' | 'bottom' | 'left' | 'right'> = [
        'top',
        'bottom',
        'left',
        'right',
      ];

      for (const dir of directions) {
        const srcLeafId = `leaf-term-split-${dir}`;
        const chatTab = createSessionTab({
          tabId: `tab-chat-${dir}`,
          sessionId: `sess-chat-${dir}`,
          title: `Chat ${dir}`,
        });
        const termTab = createTerminalTab({
          tabId: `tab-term-${dir}`,
          terminalKey: `term-key-${dir}`,
          cwd: `C:/Software/conex/target-${dir}`,
          title: `Terminal ${dir}`,
        });

        useLayoutTreeStore.setState({
          tree: {
            version: 3,
            root: {
              type: 'leaf',
              id: srcLeafId,
              panelId: 'chat',
              activeTabId: `tab-term-${dir}`,
              tabs: [chatTab, termTab],
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

        // Execute splitTab
        await act(async () => {
          useLayoutTreeStore
            .getState()
            .splitTab(srcLeafId, `tab-term-${dir}`, srcLeafId, dir);
        });

        const root = useLayoutTreeStore.getState().tree.root;
        expect(root.type, `Direction ${dir}: Root must become branch`).toBe(
          'branch'
        );

        const branch = root as LayoutBranch;
        const expectedDir =
          dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical';
        expect(
          branch.direction,
          `Direction ${dir}: Expected branch direction ${expectedDir}`
        ).toBe(expectedDir);

        const leaves = collectLeaves(root);
        expect(leaves).toHaveLength(2);

        // Find leaf with terminal tab
        const termLeaf = leaves.find((l) =>
          l.tabs.some((t) => t.tabId === `tab-term-${dir}`)
        );
        expect(
          termLeaf,
          `Direction ${dir}: Terminal leaf must exist`
        ).toBeDefined();
        expect(termLeaf?.tabs).toHaveLength(1);

        const movedTerm = termLeaf!.tabs[0];
        expect(isTerminalTab(movedTerm)).toBe(true);
        expect((movedTerm as any).terminalKey).toBe(`term-key-${dir}`);
        expect((movedTerm as any).cwd).toBe(`C:/Software/conex/target-${dir}`);

        // Verify topological order
        if (dir === 'top' || dir === 'left') {
          // New leaf with terminal must be child 0
          expect(branch.children[0].id).toBe(termLeaf!.id);
        } else {
          // New leaf with terminal must be child 1
          expect(branch.children[1].id).toBe(termLeaf!.id);
        }
      }
    });

    it('Probe 3.2: Browser Tab splits across all 4 directions preserving URL target and metadata', async () => {
      const directions: Array<'top' | 'bottom' | 'left' | 'right'> = [
        'top',
        'bottom',
        'left',
        'right',
      ];

      for (const dir of directions) {
        const srcLeafId = `leaf-browser-split-${dir}`;
        const chatTab = createSessionTab({
          tabId: `tab-chat-b-${dir}`,
          sessionId: `sess-chat-b-${dir}`,
          title: `Chat ${dir}`,
        });
        const browserTab = createBrowserTab({
          tabId: `tab-browser-${dir}`,
          url: `https://example.com/${dir}`,
          title: `Browser ${dir}`,
        });

        useLayoutTreeStore.setState({
          tree: {
            version: 3,
            root: {
              type: 'leaf',
              id: srcLeafId,
              panelId: 'chat',
              activeTabId: `tab-browser-${dir}`,
              tabs: [chatTab, browserTab],
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

        // Execute splitTab
        await act(async () => {
          useLayoutTreeStore
            .getState()
            .splitTab(srcLeafId, `tab-browser-${dir}`, srcLeafId, dir);
        });

        const root = useLayoutTreeStore.getState().tree.root;
        expect(root.type).toBe('branch');

        const leaves = collectLeaves(root);
        expect(leaves).toHaveLength(2);

        const browserLeaf = leaves.find((l) =>
          l.tabs.some((t) => t.tabId === `tab-browser-${dir}`)
        );
        expect(browserLeaf).toBeDefined();

        const movedBrowser = browserLeaf!.tabs[0];
        expect(isBrowserTab(movedBrowser)).toBe(true);
        expect((movedBrowser as any).url).toBe(`https://example.com/${dir}`);
      }
    });

    it('Probe 3.3: Recursive 4-quadrant layout with mixed tabs preserves total tab count and branch ratio invariants', async () => {
      const srcLeafId = 'leaf-quadrant-root';
      const t1 = createSessionTab({
        tabId: 't-c1',
        sessionId: 's-c1',
        title: 'Chat 1',
      });
      const t2 = createTerminalTab({
        tabId: 't-term1',
        terminalKey: 'tk1',
        cwd: 'C:/app1',
      });
      const t3 = createBrowserTab({
        tabId: 't-web1',
        url: 'http://localhost:3000',
      });
      const t4 = createTerminalTab({
        tabId: 't-term2',
        terminalKey: 'tk2',
        cwd: 'C:/app2',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: srcLeafId,
            panelId: 'chat',
            activeTabId: 't-c1',
            tabs: [t1, t2, t3, t4],
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

      // Split 1: Split Terminal 1 to right
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(srcLeafId, 't-term1', srcLeafId, 'right');
      });

      // Split 2: Split Browser 1 to bottom
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(srcLeafId, 't-web1', srcLeafId, 'bottom');
      });

      // Split 3: Split Terminal 2 to top
      await act(async () => {
        useLayoutTreeStore
          .getState()
          .splitTab(srcLeafId, 't-term2', srcLeafId, 'top');
      });

      const root = useLayoutTreeStore.getState().tree.root;
      const leaves = collectLeaves(root);
      expect(leaves).toHaveLength(4);

      // Invariant: Total tabs strictly conserved = 4
      expect(countTotalTabsInTree(root)).toBe(4);

      // Recursive topology validator
      function assertValidTopology(node: LayoutNode) {
        if (node.type === 'branch') {
          expect(node.splitRatio).toBeGreaterThanOrEqual(0.05);
          expect(node.splitRatio).toBeLessThanOrEqual(0.95);
          expect(node.children).toHaveLength(2);
          assertValidTopology(node.children[0]);
          assertValidTopology(node.children[1]);
        } else {
          expect(node.tabs.length).toBeGreaterThan(0);
          expect(node.activeTabId).toBeTruthy();
        }
      }
      assertValidTopology(root);
    });
  });

  // =========================================================================
  // Probe 4 (Explicit Creation): Tab count increments ONLY on explicit actions
  // =========================================================================
  describe('Probe 4 (Explicit Creation): Tab Count Increments Strictly On Explicit User Actions', () => {
    it('Probe 4.1: Non-explicit gestures (sidebar click, leaf activation, tab switching, dock toggle) maintain Delta = 0', async () => {
      registerSessionsInStore(['sess-exp-1', 'sess-exp-2', 'sess-new-replace']);

      const leafId = 'leaf-probe-explicit';
      const tab1 = createSessionTab({
        tabId: 'tab-exp-1',
        sessionId: 'sess-exp-1',
        title: 'T1',
      });
      const tab2 = createSessionTab({
        tabId: 'tab-exp-2',
        sessionId: 'sess-exp-2',
        title: 'T2',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-exp-1',
            tabs: [tab1, tab2],
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

      const initialTotal = 2;

      // 1. Tab activation (switching between tab 1 and 2)
      await act(async () => {
        useWorkspaceShellStore.getState().activateTab(leafId, 'tab-exp-2');
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(initialTotal);

      // 2. Leaf activation
      act(() => {
        useLayoutTreeStore.getState().setActiveLeaf(leafId);
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(initialTotal);

      // 3. Dock update
      act(() => {
        useLayoutTreeStore
          .getState()
          .updateTabDock?.('tab-exp-1', { collapsed: false });
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(initialTotal);

      // 4. Sidebar click in-place replacement
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('sess-new-replace');
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(initialTotal);
    });

    it('Probe 4.2: Explicit actions (addTerminalTab, addBrowserTab, drag with insertIdx) increment tab count (Delta = +1)', async () => {
      registerSessionsInStore(['sess-base', 'sess-dropped-to-tabstrip']);

      const leafId = 'leaf-explicit-actions';
      const initialTab = createSessionTab({
        tabId: 'tab-base',
        sessionId: 'sess-base',
        title: 'Base',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-base',
            tabs: [initialTab],
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

      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(1);

      // Explicit 1: Add Terminal Tab
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .addTerminalTab?.(leafId, { cwd: 'C:/Software/conex' });
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(2);

      // Explicit 2: Add Browser Tab
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .addBrowserTab?.(leafId, { url: 'http://localhost:5173' });
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(3);

      // Explicit 3: Drag and drop from sidebar to tabstrip with insertIdx
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('sess-dropped-to-tabstrip', {
            activeLeafId: leafId,
            insertIdx: 1,
          });
      });
      expect(
        countTotalTabsInTree(useLayoutTreeStore.getState().tree.root)
      ).toBe(4);
    });
  });

  // =========================================================================
  // Probe 5 (Streaming Resilience): Session switching does not abort or drop stream chunks
  // =========================================================================
  describe('Probe 5 (Streaming Resilience): Background Stream Ingestion Decoupled From Session Switching', () => {
    it('Probe 5.1: Switching away from streaming session does not abort stream, and subsequent chunks are preserved', async () => {
      const leafId = 'leaf-streaming-test';
      const session1Tab = createSessionTab({
        tabId: 'tab-stream-1',
        sessionId: 'session-stream-1',
        title: 'Stream Session 1',
      });

      useLayoutTreeStore.setState({
        tree: {
          version: 3,
          root: {
            type: 'leaf',
            id: leafId,
            panelId: 'chat',
            activeTabId: 'tab-stream-1',
            tabs: [session1Tab],
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

      // Populate sessions in sessionStore
      useSessionStore.setState({
        sessions: [
          {
            id: 'session-stream-1',
            title: 'Stream 1',
            folder: '默认',
            messages: [],
          },
          {
            id: 'session-switch-2',
            title: 'Switch 2',
            folder: '默认',
            messages: [],
          },
          {
            id: 'session-switch-3',
            title: 'Switch 3',
            folder: '默认',
            messages: [],
          },
        ] as any,
        sessionsById: {
          'session-stream-1': {
            id: 'session-stream-1',
            title: 'Stream 1',
            folder: '默认',
            messages: [],
          },
          'session-switch-2': {
            id: 'session-switch-2',
            title: 'Switch 2',
            folder: '默认',
            messages: [],
          },
          'session-switch-3': {
            id: 'session-switch-3',
            title: 'Switch 3',
            folder: '默认',
            messages: [],
          },
        } as any,
        activeSessionId: 'session-stream-1',
      });

      // 1. Start streaming run in sessionExecutionTrackerStore
      act(() => {
        useSessionExecutionTrackerStore
          .getState()
          .startRun('session-stream-1', 'run-stream-1', 'streaming_text');
      });
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns[
          'session-stream-1'
        ]?.stage
      ).toBe('streaming_text');

      const abortSpy = vi.fn();
      (window as any).__mockStreamAbort = abortSpy;

      // 2. Switch away to session-switch-2
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-switch-2');
      });

      // Invariant: Stream was NOT aborted
      expect(abortSpy).not.toHaveBeenCalled();
      expect(useSessionStore.getState().activeSessionId).toBe(
        'session-switch-2'
      );

      // Invariant: Execution tracker still reflects session-stream-1 as streaming_text
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns[
          'session-stream-1'
        ]?.stage
      ).toBe('streaming_text');

      // 3. While active on session-switch-2, background chunks arrive for session-stream-1
      const chunks = [
        'Hello',
        ' from',
        ' headless',
        ' background',
        ' stream',
        '!',
      ];
      act(() => {
        const s1 = useSessionStore.getState().sessionsById['session-stream-1'];
        if (s1) {
          useSessionStore.setState({
            sessionsById: {
              ...useSessionStore.getState().sessionsById,
              'session-stream-1': {
                ...s1,
                messages: chunks.map((chunk, idx) => ({
                  id: `m-chunk-${idx}`,
                  sender: 'assistant',
                  text: chunk,
                  timestamp: 1000 + idx,
                })) as any,
              },
            },
          });
        }
      });

      // 4. Switch to session-switch-3
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-switch-3');
      });
      expect(abortSpy).not.toHaveBeenCalled();
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns[
          'session-stream-1'
        ]?.stage
      ).toBe('streaming_text');

      // 5. Switch back to session-stream-1
      await act(async () => {
        useWorkspaceShellStore
          .getState()
          .openOrFocusSession('session-stream-1');
      });
      expect(useSessionStore.getState().activeSessionId).toBe(
        'session-stream-1'
      );

      // Invariant: All 6 chunks are intact and present
      const messagesAfterReturn =
        useSessionStore.getState().sessionsById['session-stream-1'].messages;
      expect(messagesAfterReturn).toHaveLength(6);
      expect(messagesAfterReturn.map((m: any) => m.text).join('')).toBe(
        'Hello from headless background stream!'
      );
    });

    it('Probe 5.2: Multi-session concurrent execution tracking maintains discrete stages across switches', async () => {
      act(() => {
        useSessionExecutionTrackerStore
          .getState()
          .startRun('session-A', 'run-A', 'streaming_text');
        useSessionExecutionTrackerStore
          .getState()
          .startRun('session-B', 'run-B', 'executing_tool');
      });

      // Switch active session in shell
      await act(async () => {
        useWorkspaceShellStore.getState().openOrFocusSession('session-C');
      });

      const activeRuns = useSessionExecutionTrackerStore.getState().activeRuns;
      expect(activeRuns['session-A']?.stage).toBe('streaming_text');
      expect(activeRuns['session-B']?.stage).toBe('executing_tool');

      // Complete session-A
      act(() => {
        useSessionExecutionTrackerStore.getState().completeRun('session-A');
      });
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['session-A']
          ?.stage
      ).toBe('just_completed');
      expect(
        useSessionExecutionTrackerStore.getState().activeRuns['session-B']
          ?.stage
      ).toBe('executing_tool');
    });
  });
});
