/**
 * W3-E′ · 跨块多选 / 焦点方向（可点名可测）。
 *
 * - setMultiSelected / clear / focus 与 multi 交互
 * - selectBlockRange 跨块连续展开
 * - 可选镜像 SelectionStore.blockMulti
 *
 * **≠ EL-01**；**≠** Notion 级框选 e2e；**≠** 重复 code 叶首批。
 */
import { describe, expect, it } from 'vitest';
import { SelectionStore } from '@crish/editor-kit';
import { BlockChromeModel } from './BlockChrome';
import { BlockSelectionBridge, expandBlockRange } from './blockSelection';

const ORDER = ['b-a', 'b-b', 'b-c', 'b-d', 'b-e'] as const;

describe('W3-E′ expandBlockRange', () => {
  it('w3e_sel_expand_range: 闭区间含端点，方向无关', () => {
    expect(expandBlockRange(ORDER, 'b-b', 'b-d')).toEqual([
      'b-b',
      'b-c',
      'b-d',
    ]);
    expect(expandBlockRange(ORDER, 'b-d', 'b-b')).toEqual([
      'b-b',
      'b-c',
      'b-d',
    ]);
    expect(expandBlockRange(ORDER, 'b-c', 'b-c')).toEqual(['b-c']);
  });
});

describe('W3-E′ BlockSelectionBridge · setMulti / clear / focus', () => {
  it('w3e_sel_set_multi_focus_head: setMultiSelected 投影 chrome multi + focus head', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    const snap = sel.setMultiSelected(['b-b', 'b-a', 'b-b', '']);
    // 去重保序（调用方序，非文档序）
    expect(snap.multiSelectedIds).toEqual(['b-b', 'b-a']);
    expect(snap.mode).toBe('blockMulti');
    expect(snap.anchorBlockId).toBe('b-b');
    expect(snap.headBlockId).toBe('b-a');
    expect(snap.focusedBlockId).toBe('b-a');
    expect(chrome.getSnapshot().multiSelectedIds).toEqual(['b-b', 'b-a']);
    expect(chrome.getSnapshot().focusedBlockId).toBe('b-a');
    // multi 把手优先于 focus
    expect(chrome.getHandleVisibility('b-b')).toBe('multi');
    expect(chrome.getHandleVisibility('b-a')).toBe('multi');
    expect(chrome.getHandleVisibility('b-c')).toBe('hidden');
  });

  it('w3e_sel_clear_multi_keeps_focus: clear 默认保留焦点；clearFocus 一并清', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    sel.setMultiSelected(['b-a', 'b-c']);
    expect(chrome.getSnapshot().focusedBlockId).toBe('b-c');

    const afterClear = sel.clearMultiSelected();
    expect(afterClear.multiSelectedIds).toEqual([]);
    expect(afterClear.mode).toBe('focusOnly');
    expect(afterClear.focusedBlockId).toBe('b-c');
    expect(chrome.isMultiSelected('b-a')).toBe(false);
    expect(chrome.getHandleVisibility('b-c')).toBe('focus');

    sel.setMultiSelected(['b-b']);
    const clearedAll = sel.clearMultiSelected({ clearFocus: true });
    expect(clearedAll.multiSelectedIds).toEqual([]);
    expect(clearedAll.focusedBlockId).toBeNull();
    expect(clearedAll.mode).toBe('none');
    expect(chrome.getHandleVisibility('b-b')).toBe('hidden');
  });

  it('w3e_sel_focus_outside_clears_multi: 焦点在 multi 外默认清 multi', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    sel.setMultiSelected(['b-a', 'b-b']);
    expect(sel.getSnapshot().mode).toBe('blockMulti');

    // 焦点落到 multi 外 → 清 multi，进入 focusOnly
    const outside = sel.setFocused('b-e');
    expect(outside.mode).toBe('focusOnly');
    expect(outside.multiSelectedIds).toEqual([]);
    expect(outside.focusedBlockId).toBe('b-e');
    expect(outside.anchorBlockId).toBe('b-e');
    expect(outside.headBlockId).toBe('b-e');
    expect(chrome.getHandleVisibility('b-a')).toBe('hidden');
    expect(chrome.getHandleVisibility('b-e')).toBe('focus');
  });

  it('w3e_sel_focus_inside_multi_updates_head: 焦点在 multi 内保留 multi 并更新 head', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    sel.setMultiSelected(['b-a', 'b-b', 'b-c'], {
      anchorBlockId: 'b-a',
      headBlockId: 'b-c',
    });
    expect(sel.getSnapshot().headBlockId).toBe('b-c');
    expect(chrome.getSnapshot().focusedBlockId).toBe('b-c');

    const inside = sel.setFocused('b-b');
    expect(inside.mode).toBe('blockMulti');
    expect(inside.multiSelectedIds).toEqual(['b-a', 'b-b', 'b-c']);
    expect(inside.focusedBlockId).toBe('b-b');
    expect(inside.anchorBlockId).toBe('b-a');
    expect(inside.headBlockId).toBe('b-b');
    // multi 仍盖过 focus 把手
    expect(chrome.getHandleVisibility('b-b')).toBe('multi');
  });

  it('w3e_sel_focus_outside_keep_multi_opt: clearMultiIfOutside=false 保留 multi', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    sel.setMultiSelected(['b-a', 'b-b']);
    const kept = sel.setFocused('b-e', { clearMultiIfOutside: false });
    expect(kept.multiSelectedIds).toEqual(['b-a', 'b-b']);
    expect(kept.focusedBlockId).toBe('b-e');
    expect(kept.mode).toBe('blockMulti');
    expect(chrome.getHandleVisibility('b-a')).toBe('multi');
    expect(chrome.getHandleVisibility('b-e')).toBe('focus');
  });
});

describe('W3-E′ BlockSelectionBridge · 跨块 range / toggle / store', () => {
  it('w3e_sel_select_block_range: 按文档序展开跨块多选 + focus head', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    const snap = sel.selectBlockRange('b-b', 'b-d');
    expect(snap.multiSelectedIds).toEqual(['b-b', 'b-c', 'b-d']);
    expect(snap.anchorBlockId).toBe('b-b');
    expect(snap.headBlockId).toBe('b-d');
    expect(snap.focusedBlockId).toBe('b-d');
    expect(snap.mode).toBe('blockMulti');
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([
      'b-b',
      'b-c',
      'b-d',
    ]);
  });

  it('w3e_sel_toggle_multi: 加入/移除并与 focus 交互', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    sel.toggleMulti('b-a');
    expect(sel.getSnapshot().multiSelectedIds).toEqual(['b-a']);
    expect(sel.getSnapshot().focusedBlockId).toBe('b-a');

    sel.toggleMulti('b-c');
    expect(sel.getSnapshot().multiSelectedIds).toEqual(['b-a', 'b-c']);
    expect(sel.getSnapshot().headBlockId).toBe('b-c');
    expect(sel.getSnapshot().focusedBlockId).toBe('b-c');

    sel.toggleMulti('b-a');
    expect(sel.getSnapshot().multiSelectedIds).toEqual(['b-c']);
    expect(chrome.isMultiSelected('b-a')).toBe(false);

    sel.toggleMulti('b-c');
    expect(sel.getSnapshot().mode).toBe('focusOnly');
    expect(sel.getSnapshot().multiSelectedIds).toEqual([]);
    // clear multi 默认保留 focus
    expect(sel.getSnapshot().focusedBlockId).toBe('b-c');
  });

  it('w3e_sel_mirror_selection_store: 多选/清空镜像到 SelectionStore.blockMulti', () => {
    const chrome = new BlockChromeModel();
    const store = new SelectionStore();
    const sel = new BlockSelectionBridge(chrome, {
      blockOrder: ORDER,
      selectionStore: store,
    });

    sel.setMultiSelected(['b-a', 'b-e']);
    const storeSnap = store.getSnapshot();
    expect(storeSnap.sel).toEqual({
      type: 'blockMulti',
      blockIds: ['b-a', 'b-e'],
    });
    expect(storeSnap.pinnedBlockIds).toEqual(['b-a', 'b-e']);

    sel.clearMultiSelected();
    expect(store.getSnapshot().sel).toEqual({ type: 'none' });
  });

  it('w3e_sel_sync_from_chrome: 外写 chrome multi 后 bridge 端点对齐', () => {
    const chrome = new BlockChromeModel();
    const sel = new BlockSelectionBridge(chrome, { blockOrder: ORDER });

    chrome.setMultiSelected(['b-c', 'b-d']);
    chrome.setFocused('b-d');
    const snap = sel.syncFromChrome();
    expect(snap.multiSelectedIds).toEqual(['b-c', 'b-d']);
    expect(snap.anchorBlockId).toBe('b-c');
    expect(snap.headBlockId).toBe('b-d');
    expect(snap.mode).toBe('blockMulti');
  });
});
