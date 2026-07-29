/**
 * OPT-E9 — Layout / open-focus ownership enforce tests
 *
 * Locks write-ownership rules already documented in storeOwnership / store README /
 * desktop-composition-and-stores. Not a layoutStore rewrite — public compositionRoot
 * API + pure empty-shell helpers only.
 *
 * @see store/storeOwnership.ts
 * @see docs/architecture/desktop-composition-and-stores.md § Layout identity ownership
 * @see docs/plans/progress/architecture-dedup-inventory.md #2
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCompositionRoot,
  registerCompositionRoot,
  resetCompositionRoot,
  type CompositionRoot,
  type LayoutFacade,
  type SessionFacade,
  type ShellFacade,
} from './compositionRoot';
import {
  SHELL_TAB_OWNERSHIP,
  LAYOUT_TREE_OWNERSHIP,
  SESSION_OWNERSHIP,
} from '../store/storeOwnership';
import { useWorkspaceShellStore } from '../store/workspace-shell/workspaceShellStore';
import { findEmptyShellViolations } from '../dev/emptyShellAssert';
import { EMPTY_SESSION_TITLE } from '../api/sessionTitle';

// Avoid any accidental daemon touch if a future import pulls run control
vi.mock('../api/daemonClient', () => ({
  getDesktopDaemonClient: () => {
    throw new Error('no-daemon-in-unit');
  },
}));

function stubLayout(
  partial: Partial<LayoutFacade> & {
    setSessions?: LayoutFacade['setSessions'];
  } = {},
): LayoutFacade {
  return {
    getState: () => ({}) as never,
    getSessions: () => [],
    setSessions: vi.fn(),
    setTabModeEnabled: vi.fn(),
    getSidebarCollapsed: () => false,
    setSidebarCollapsed: vi.fn(),
    toggleSidebarCollapsed: vi.fn(),
    getPlanModeEnabled: () => false,
    setPlanModeEnabled: vi.fn(),
    togglePlanMode: vi.fn(),
    getAppSettings: () => null,
    ...partial,
  };
}

function stubSession(partial: Partial<SessionFacade> = {}): SessionFacade {
  return {
    getState: () => ({}) as never,
    getActiveSessionId: () => null as never,
    enterDraft: vi.fn(),
    openOrFocusSession: vi.fn(),
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
    archiveSession: vi.fn(),
    unarchiveSession: vi.fn(),
    branchSession: vi.fn(),
    ...partial,
  };
}

function stubShell(partial: Partial<ShellFacade> = {}): ShellFacade {
  return {
    getState: () => ({}) as never,
    openNewDraftTab: vi.fn(),
    setShellReady: vi.fn(),
    ...partial,
  };
}

describe('ownership enforce (OPT-E9)', () => {
  beforeEach(() => {
    resetCompositionRoot();
    vi.restoreAllMocks();
  });

  // ── 1. New chat UX → draft APIs (not createSession / not layout.setSessions) ──

  describe('new chat → draft APIs (not createSession)', () => {
    it('session / shell expose enterDraft + openNewDraftTab; createSession is not a facade entry', () => {
      const root = registerCompositionRoot();

      expect(typeof root.session.enterDraft).toBe('function');
      expect(typeof root.shell.openNewDraftTab).toBe('function');
      expect(typeof root.session.openOrFocusSession).toBe('function');
      // OPT-G7: pin/archive/branch 在 session 门面，不在 layout
      expect(typeof root.session.pinSession).toBe('function');
      expect(typeof root.session.unpinSession).toBe('function');
      expect(typeof root.session.archiveSession).toBe('function');
      expect(typeof root.session.unarchiveSession).toBe('function');
      expect(typeof root.session.branchSession).toBe('function');
      expect(root.layout).not.toHaveProperty('pinSession');
      expect(root.layout).not.toHaveProperty('archiveSession');
      expect(root.layout).not.toHaveProperty('branchSession');

      // User「新对话」must not mint via compositionRoot facades
      expect(root.session).not.toHaveProperty('createSession');
      expect(root.shell).not.toHaveProperty('createSession');
      expect(root.layout).not.toHaveProperty('createSession');
      expect(root.layout).not.toHaveProperty('openNewDraftTab');
      expect(root.layout).not.toHaveProperty('enterDraft');
      expect(root.tree).not.toHaveProperty('openNewDraftTab');
      expect(root.tree).not.toHaveProperty('enterDraft');
      expect(root.tree).not.toHaveProperty('createSession');
    });

    it('UX path shell.openNewDraftTab / session.enterDraft does not require layout.setSessions', () => {
      const setSessions = vi.fn();
      const openNewDraftTab = vi.fn();
      const enterDraft = vi.fn();

      const root = registerCompositionRoot({
        layout: stubLayout({ setSessions }),
        shell: stubShell({ openNewDraftTab }),
        session: stubSession({ enterDraft }),
      });

      // Path A — shortcuts / empty-state / + tab
      root.shell.openNewDraftTab('proj-a');
      expect(openNewDraftTab).toHaveBeenCalledWith('proj-a');
      expect(setSessions).not.toHaveBeenCalled();

      // Path B — session facade enterDraft (same draft contract, no mint)
      root.session.enterDraft('proj-b');
      expect(enterDraft).toHaveBeenCalledWith('proj-b');
      expect(setSessions).not.toHaveBeenCalled();
    });

    it('default shell.openNewDraftTab call-through hits workspaceShellStore (not layout.setSessions)', () => {
      const openNewDraftTab = vi.fn();
      const setSessions = vi.fn();
      useWorkspaceShellStore.setState({ openNewDraftTab });

      registerCompositionRoot({
        layout: stubLayout({ setSessions }),
        // session/shell left default → wire to real shell store methods
      });

      getCompositionRoot().shell.openNewDraftTab('folder-z');
      expect(openNewDraftTab).toHaveBeenCalledWith('folder-z');
      expect(setSessions).not.toHaveBeenCalled();
    });
  });

  // ── 2. Open/focus → openOrFocusSession facade (not dual setSessions + setActive) ──

  describe('open/focus → session.openOrFocusSession (shell owner)', () => {
    it('facade methods exist and open path does not dual-write layout.setSessions', () => {
      const setSessions = vi.fn();
      const openOrFocusSession = vi.fn();

      const root = registerCompositionRoot({
        layout: stubLayout({ setSessions }),
        session: stubSession({ openOrFocusSession }),
      });

      root.session.openOrFocusSession('s-1', {
        title: 'Hello',
        workspaceKey: 'proj',
      });

      expect(openOrFocusSession).toHaveBeenCalledWith('s-1', {
        title: 'Hello',
        workspaceKey: 'proj',
      });
      // Forbidden dual-write companion for the same open gesture
      expect(setSessions).not.toHaveBeenCalled();
    });

    it('default session.openOrFocusSession delegates to workspaceShellStore', () => {
      const openOrFocusSession = vi.fn();
      useWorkspaceShellStore.setState({ openOrFocusSession });

      registerCompositionRoot(); // default wiring
      getCompositionRoot().session.openOrFocusSession('s-focus', {
        title: 'T',
      });

      expect(openOrFocusSession).toHaveBeenCalledWith('s-focus', {
        title: 'T',
      });
    });

    it('SHELL_TAB_OWNERSHIP forbids layout / tree dual-write companions', () => {
      expect(SHELL_TAB_OWNERSHIP.domain).toBe('shell');
      expect(SHELL_TAB_OWNERSHIP.writeOwner).toBe('compositionRoot.shell');
      expect(SHELL_TAB_OWNERSHIP.forbidAlongside).toContain(
        'compositionRoot.layout',
      );
      expect(SHELL_TAB_OWNERSHIP.forbidAlongside).toContain('layoutTreeStore');
    });
  });

  // ── 3. Naming guard: .layout ≠ layout-tree; .tree is geometry ──

  describe('naming guard: layout chrome vs tree geometry', () => {
    it('root.tree has setLeafSessionId / getState; root.layout has getAppSettings', () => {
      const root = registerCompositionRoot();

      // tree = layout-tree geometry
      expect(typeof root.tree.getState).toBe('function');
      expect(typeof root.tree.setLeafSessionId).toBe('function');
      expect(root.tree).not.toHaveProperty('getAppSettings');
      expect(root.tree).not.toHaveProperty('setSessions');
      expect(root.tree).not.toHaveProperty('setTabModeEnabled');
      expect(root.tree).not.toHaveProperty('openNewDraftTab');

      // layout = god chrome / sessions / appSettings — not tree
      expect(typeof root.layout.getAppSettings).toBe('function');
      expect(typeof root.layout.getSessions).toBe('function');
      expect(typeof root.layout.setSessions).toBe('function');
      expect(root.layout).not.toHaveProperty('setLeafSessionId');
      expect(root.layout).not.toHaveProperty('openNewDraftTab');
      expect(root.layout).not.toHaveProperty('openOrFocusSession');

      // E5 may add setAppSettings later — assert only if present
      const layoutRecord = root.layout as LayoutFacade & {
        setAppSettings?: unknown;
      };
      if (typeof layoutRecord.setAppSettings === 'function') {
        expect(layoutRecord.setAppSettings).toBeTypeOf('function');
      }
    });

    it('LAYOUT_TREE_OWNERSHIP vs shell: separate write owners', () => {
      expect(LAYOUT_TREE_OWNERSHIP.domain).toBe('layout-tree');
      expect(LAYOUT_TREE_OWNERSHIP.writeOwner).toBe('layoutTreeStore');
      expect(LAYOUT_TREE_OWNERSHIP.forbidAlongside).toContain(
        'workspaceShellStore',
      );
      expect(LAYOUT_TREE_OWNERSHIP.forbidAlongside).toContain(
        'compositionRoot.shell',
      );

      expect(SESSION_OWNERSHIP.domain).toBe('session');
      expect(SESSION_OWNERSHIP.writeOwner).toBe('sessionStore');
      // session body writes must not also own shell tabs
      expect(SESSION_OWNERSHIP.forbidAlongside).toContain('workspaceShellStore');
    });

    it('CompositionRoot key surface: tree and layout are distinct facades', () => {
      const root = registerCompositionRoot();
      const keys = Object.keys(root) as (keyof CompositionRoot)[];
      expect(keys).toEqual(
        expect.arrayContaining([
          'session',
          'shell',
          'layout',
          'tree',
          'workspace',
        ]),
      );
      // same object identity would collapse naming trap — must be different refs
      expect(root.layout).not.toBe(root.tree as unknown);
      expect(root.shell).not.toBe(root.layout as unknown);
      expect(root.session).not.toBe(root.shell as unknown);
    });
  });

  // ── 4. Empty-shell vs draft (light reuse of I-DRAFT assert) ──

  describe('empty-shell vs draft (I-DRAFT light)', () => {
    it('pending draft sentinel must not live in sessions[] (new-chat is not a row)', () => {
      const violations = findEmptyShellViolations(
        [
          {
            id: '__pending_draft__',
            title: EMPTY_SESSION_TITLE,
            messages: [],
          },
          {
            id: 'hist',
            title: '历史',
            messages: [{ sender: 'user', text: 'hi' }],
          },
        ],
        { activeSessionId: '__pending_draft__' },
      );
      expect(violations).toContainEqual({
        id: '__pending_draft__',
        reason: 'i_draft_in_sessions',
      });
    });

    it('default-title empty shells are prune candidates when not keep (no mint-as-open)', () => {
      const violations = findEmptyShellViolations(
        [
          {
            id: 'ghost',
            title: EMPTY_SESSION_TITLE,
            messages: [],
          },
          {
            id: 'real',
            title: '真实',
            messages: [{ sender: 'user', text: 'x' }],
          },
        ],
        { activeSessionId: 'real' },
      );
      expect(violations).toEqual([
        { id: 'ghost', reason: 'empty_shell_should_prune' },
      ]);
    });
  });
});
