/**
 * Cold-start multi-unit restore validation (pure).
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
} from './types';

function multiUnitTree(): LayoutTree {
  const chatA = createLeaf('chat', ['chat'], 'chat', 'sess-a');
  const toolA = createLeaf('terminal', ['terminal'], 'terminal', 'sess-a');
  const unitA = createBranch('horizontal', chatA, toolA, 0.62);
  const chatB = createLeaf('chat', ['chat'], 'chat', 'sess-b');
  return {
    version: 2,
    root: createBranch('horizontal', unitA, chatB, 0.5),
  };
}

describe('validateRestorableLayoutTree', () => {
  it('accepts default single chat', () => {
    const v = validateRestorableLayoutTree(createDefaultTree('chat'));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.chatCount).toBe(1);
      expect(v.multiUnit).toBe(false);
    }
  });

  it('accepts valid multi-unit with session bindings', () => {
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

  it('rejects multi-unit with unbound chat leaf', () => {
    const tree: LayoutTree = {
      version: 2,
      root: createBranch(
        'horizontal',
        createLeaf('chat', ['chat'], 'chat', 'sess-a'),
        createLeaf('chat', ['chat'], 'chat'), // unbound
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('multi-unit-unbound-chat');
  });

  it('rejects duplicate session chat bindings', () => {
    const tree: LayoutTree = {
      version: 2,
      root: createBranch(
        'horizontal',
        createLeaf('chat', ['chat'], 'chat', 'sess-a'),
        createLeaf('chat', ['chat'], 'chat', 'sess-a'),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('duplicate-session-binding');
  });

  it('rejects orphan tool session without chat parent', () => {
    const tree: LayoutTree = {
      version: 2,
      root: createBranch(
        'horizontal',
        createLeaf('chat', ['chat'], 'chat', 'sess-a'),
        createLeaf('terminal', ['terminal'], 'terminal', 'sess-orphan'),
        0.5
      ),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('orphan-tool-session');
  });

  it('rejects tool-only tree (no chat)', () => {
    const tree: LayoutTree = {
      version: 2,
      root: createLeaf('terminal', ['terminal'], 'terminal'),
    };
    const v = validateRestorableLayoutTree(tree);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('no-chat-leaf');
  });

  it('rejects malformed structure', () => {
    const bad = {
      version: 2,
      root: {
        type: 'branch',
        id: 'b1',
        direction: 'horizontal',
        splitRatio: 0.5,
        children: [{ type: 'leaf', id: 'only-one' }], // not 2 children
      },
    } as unknown as LayoutTree;
    expect(isLayoutNodeStructurallyValid(bad.root)).toBe(false);
    const v = validateRestorableLayoutTree(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('malformed-structure');
  });
});
