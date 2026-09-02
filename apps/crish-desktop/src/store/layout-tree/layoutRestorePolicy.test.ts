/**
 * Cold-start v3 restore validation (pure).
 */
import { describe, expect, it } from 'vitest';
import {
  validateRestorableLayoutTree,
  isLayoutNodeStructurallyValid,
} from './layoutRestorePolicy';
import {
  createDefaultTree,
  createLeaf,
  createBranch,
  type LayoutTree,
  type LayoutLeaf,
} from './types';
import {
  createSessionTab,
  PENDING_DRAFT_SESSION_ID,
} from './sessionTabModel';

function multiUnitTree(): LayoutTree {
  return {
    version: 3,
    root: createBranch(
      'horizontal',
      createLeaf({
        tabs: [createSessionTab({ sessionId: 'sess-a', tabId: 'ta' })],
      }),
      createLeaf({
        tabs: [createSessionTab({ sessionId: 'sess-b', tabId: 'tb' })],
      }),
      0.5
    ),
  };
}

describe('validateRestorableLayoutTree', () => {
  it('accepts default single chat', () => {
    const v = validateRestorableLayoutTree(createDefaultTree());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.chatCount).toBe(1);
      expect(v.multiUnit).toBe(false);
    }
  });

  it('accepts valid multi-unit with distinct sessions', () => {
    const v = validateRestorableLayoutTree(multiUnitTree());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.chatCount).toBe(2);
      expect(v.multiUnit).toBe(true);
    }
  });

  it('rejects missing tree', () => {
    expect(validateRestorableLayoutTree(null).ok).toBe(false);
    expect(validateRestorableLayoutTree(undefined).ok).toBe(false);
  });

  it('accepts multi-unit with empty composing leaves (no unbound-chat reason)', () => {
    const tree: LayoutTree = {
      version: 3,
      root: createBranch(
        'horizontal',
        createLeaf(),
        createLeaf(),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(true);
  });

  it('rejects duplicate session chat bindings', () => {
    const tree: LayoutTree = {
      version: 3,
      root: createBranch(
        'horizontal',
        createLeaf({
          tabs: [createSessionTab({ sessionId: 'sess-a', tabId: 'a' })],
        }),
        createLeaf({
          tabs: [createSessionTab({ sessionId: 'sess-a', tabId: 'b' })],
        }),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('duplicate-session-binding');
  });

  it('rejects tool leaf', () => {
    const tree = {
      version: 3,
      root: {
        type: 'leaf',
        id: 't',
        panelId: 'terminal',
        tabs: [
          createSessionTab({ sessionId: 's1', tabId: 't1' }),
        ],
        activeTabId: 't1',
      },
    } as unknown as LayoutTree;
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(['tool-leaf-present', 'malformed-structure', 'no-chat-leaf']).toContain(
        v.reason
      );
    }
  });

  it('rejects malformed structure', () => {
    const bad = {
      version: 3,
      root: {
        type: 'branch',
        id: 'b1',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [{ type: 'leaf', id: 'only-one' }],
      },
    } as unknown as LayoutTree;
    expect(isLayoutNodeStructurallyValid(bad.root)).toBe(false);
    const v = validateRestorableLayoutTree(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed-structure');
  });

  it('rejects illegal global draft', () => {
    const dirty: LayoutLeaf = {
      type: 'leaf',
      id: 'L',
      panelId: 'chat',
      tabs: [
        {
          tabId: 't',
          sessionId: PENDING_DRAFT_SESSION_ID,
          title: '新对话',
          workspaceKey: '对话',
          dock: {
            collapsed: true,
            openPanelIds: [],
            activePanelId: null,
            widthRatio: 0.5,
          },
        },
      ],
      activeTabId: 't',
    };
    const v = validateRestorableLayoutTree({ version: 3, root: dirty });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('illegal-global-draft');
  });
});
