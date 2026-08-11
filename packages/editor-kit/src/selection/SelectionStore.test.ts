/**
 * SelectionStore：caret / range / 块多选；逻辑坐标，无像素测距
 */
import { describe, expect, it } from 'vitest';
import {
  SelectionStore,
  collectPinnedFromSel,
  type EditorSel,
} from './SelectionStore';

describe('SelectionStore.setCaret', () => {
  it('设置折叠光标 blockId+offset', () => {
    const store = new SelectionStore();
    const snap = store.setCaret('b1', 3);
    expect(snap.sel).toEqual({
      type: 'caret',
      pos: { blockId: 'b1', offset: 3 },
    });
    expect(snap.pinnedBlockIds).toEqual(['b1']);
  });

  it('负 offset 钳为 0', () => {
    const store = new SelectionStore();
    const snap = store.setCaret('b1', -5);
    expect(snap.sel.type).toBe('caret');
    if (snap.sel.type === 'caret') {
      expect(snap.sel.pos.offset).toBe(0);
    }
  });

  it('空 blockId 抛错', () => {
    const store = new SelectionStore();
    expect(() => store.setCaret('', 0)).toThrow(/blockId/);
  });
});

describe('SelectionStore.setRange', () => {
  it('同块文本选', () => {
    const store = new SelectionStore();
    const snap = store.setRange(
      { blockId: 'b1', offset: 1 },
      { blockId: 'b1', offset: 5 }
    );
    expect(snap.sel.type).toBe('range');
    if (snap.sel.type === 'range') {
      expect(snap.sel.range.anchor).toEqual({ blockId: 'b1', offset: 1 });
      expect(snap.sel.range.head).toEqual({ blockId: 'b1', offset: 5 });
    }
    expect(snap.pinnedBlockIds).toEqual(['b1']);
  });

  it('跨块选 pin 两端', () => {
    const store = new SelectionStore();
    const snap = store.setRange(
      { blockId: 'a', offset: 0 },
      { blockId: 'c', offset: 2 }
    );
    expect(snap.pinnedBlockIds).toEqual(['a', 'c']);
  });

  it('anchor==head 归一为 caret', () => {
    const store = new SelectionStore();
    const snap = store.setRange(
      { blockId: 'x', offset: 4 },
      { blockId: 'x', offset: 4 }
    );
    expect(snap.sel).toEqual({
      type: 'caret',
      pos: { blockId: 'x', offset: 4 },
    });
  });
});

describe('SelectionStore.setBlockMulti / clear', () => {
  it('块多选去重保序', () => {
    const store = new SelectionStore();
    const snap = store.setBlockMulti(['b1', 'b2', 'b1', 'b3']);
    expect(snap.sel).toEqual({
      type: 'blockMulti',
      blockIds: ['b1', 'b2', 'b3'],
    });
    expect(snap.pinnedBlockIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('空多选 → none', () => {
    const store = new SelectionStore();
    store.setCaret('z', 0);
    const snap = store.setBlockMulti([]);
    expect(snap.sel).toEqual({ type: 'none' });
    expect(snap.pinnedBlockIds).toEqual([]);
  });

  it('clear 清空', () => {
    const store = new SelectionStore();
    store.setBlockMulti(['a', 'b']);
    const snap = store.clear();
    expect(snap.sel.type).toBe('none');
  });

  it('后写覆盖：块多选覆盖 caret', () => {
    const store = new SelectionStore();
    store.setCaret('only', 1);
    const snap = store.setBlockMulti(['m1', 'm2']);
    expect(snap.sel.type).toBe('blockMulti');
  });
});

describe('SelectionStore.getSnapshot 隔离', () => {
  it('快照 mutation 不影响 store', () => {
    const store = new SelectionStore();
    store.setCaret('b', 2);
    const snap = store.getSnapshot();
    if (snap.sel.type === 'caret') {
      snap.sel.pos.offset = 99;
      snap.pinnedBlockIds.push('evil');
    }
    const again = store.getSnapshot();
    expect(again.sel).toEqual({
      type: 'caret',
      pos: { blockId: 'b', offset: 2 },
    });
    expect(again.pinnedBlockIds).toEqual(['b']);
  });
});

describe('collectPinnedFromSel', () => {
  it('none 为空', () => {
    const sel: EditorSel = { type: 'none' };
    expect(collectPinnedFromSel(sel)).toEqual([]);
  });
});
