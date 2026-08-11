/**
 * A-SIL 子集（W3-C）+ chrome / slash 状态机单测。
 *
 * - 假数据加载不抛
 * - slash 在 composing=true 时拒绝打开
 * - 多选模型 set/clear
 */
import { describe, expect, it } from 'vitest';
import { applyProjectionDiff, createDiffApplyState } from '@crish/editor-kit';
import { BlockChromeModel } from './BlockChrome';
import {
  createSilentFixture,
  createSilentProjectionDiff,
  listSilentBlocks,
} from './silentFixture';
import {
  DEFAULT_SLASH_CATALOG,
  filterSlashCatalog,
  SlashMenuModel,
} from './SlashMenuModel';

// ---------------------------------------------------------------------------
// 假数据加载不抛（A-SIL 骨架 / 投影形状）
// ---------------------------------------------------------------------------

describe('silentFixture 假数据加载不抛', () => {
  it('createSilentFixture(0) 返回空文档且不抛', () => {
    expect(() => createSilentFixture(0)).not.toThrow();
    const f = createSilentFixture(0);
    expect(f.order).toEqual([]);
    expect(f.blocks.size).toBe(0);
    expect(f.state.fullRemountCount).toBe(0);
    expect(f.rev).toBe(1);
  });

  it('createSilentFixture(N) 生成 N 块 MemoryBlock 且 fullRemountCount=0', () => {
    const n = 16;
    const f = createSilentFixture(n, { docId: 'doc-silent', rev: 3 });
    expect(f.docId).toBe('doc-silent');
    expect(f.rev).toBe(3);
    expect(f.order).toHaveLength(n);
    expect(f.blocks.size).toBe(n);
    expect(f.state.fullRemountCount).toBe(0);
    expect(f.state.docId).toBe('doc-silent');

    const blocks = listSilentBlocks(f);
    expect(blocks).toHaveLength(n);
    for (const b of blocks) {
      expect(b.id).toBeTruthy();
      expect(b.textEpoch).toBe(0);
      expect(b.props).toBeTruthy();
      const props = b.props as { flavour?: string; text?: string };
      expect(props.flavour).toBeTruthy();
      expect(typeof props.text).toBe('string');
    }
  });

  it('initialDiff 符合 ProjectionDiff 形状并可二次 apply', () => {
    const f = createSilentFixture(4, { docId: 'd2', rev: 1 });
    const state = createDiffApplyState('d2', 0);
    expect(() => applyProjectionDiff(state, f.initialDiff)).not.toThrow();
    expect(state.order).toHaveLength(4);
    expect(state.fullRemountCount).toBe(0);

    // 仅 diff 工厂亦不抛
    const diff = createSilentProjectionDiff(2, { docId: 'd3' });
    expect(diff.upserts).toHaveLength(2);
    expect(diff.removes).toEqual([]);
    expect(diff.textTouches).toEqual([]);
  });

  it('大 N 与非法 n 不抛（钳制）', () => {
    expect(() => createSilentFixture(200)).not.toThrow();
    expect(createSilentFixture(200).order).toHaveLength(200);
    expect(createSilentFixture(-5).order).toHaveLength(0);
    expect(createSilentFixture(Number.NaN).order).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// slash：composing 时拒绝打开（A-IME-02）
// ---------------------------------------------------------------------------

describe('SlashMenuModel composing 守卫', () => {
  it('composing=true 时 open 拒绝', () => {
    const composing = true;
    const menu = new SlashMenuModel({ isComposing: () => composing });

    const r = menu.open('b-0001', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing');
      expect(r.reason).toMatch(/composing|IME/i);
    }
    expect(menu.isOpen()).toBe(false);
  });

  it('composing=false 时 open 成功，可过滤与关闭', () => {
    let composing = false;
    const menu = new SlashMenuModel({ isComposing: () => composing });

    const r = menu.open('b-0001', 3, '');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.open).toBe(true);
      expect(r.snapshot.blockId).toBe('b-0001');
      expect(r.snapshot.offset).toBe(3);
      expect(r.snapshot.items.length).toBeGreaterThan(0);
    }

    const filtered = menu.setQuery('标题');
    expect(filtered.query).toBe('标题');
    expect(
      filtered.items.every((it) => /标题|heading/i.test(it.title + it.id))
    ).toBe(true);

    // 合成开始后已打开的菜单由宿主决定是否关闭；本测只锁「不可新开」
    composing = true;
    const again = menu.open('b-0002', 0);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('composing');

    composing = false;
    menu.close();
    expect(menu.isOpen()).toBe(false);
    expect(menu.getSnapshot().blockId).toBeNull();
  });

  it('空 blockId 拒绝；已打开重复 open 拒绝', () => {
    const menu = new SlashMenuModel();
    expect(menu.open('').ok).toBe(false);
    expect(menu.open('a').ok).toBe(true);
    const dup = menu.open('b');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('already_open');
  });

  it('filterSlashCatalog 空 query 返回全量', () => {
    const all = filterSlashCatalog(DEFAULT_SLASH_CATALOG, '');
    expect(all.length).toBe(DEFAULT_SLASH_CATALOG.length);
    const none = filterSlashCatalog(DEFAULT_SLASH_CATALOG, '___no_such___');
    expect(none).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 多选模型 set / clear（A-SIL chrome + 逻辑 id）
// ---------------------------------------------------------------------------

describe('BlockChromeModel 多选 set/clear', () => {
  it('setMultiSelected 去重保序；clear 清空', () => {
    const chrome = new BlockChromeModel();
    const snap = chrome.setMultiSelected(['b-0002', 'b-0001', 'b-0002', '']);
    expect(snap.multiSelectedIds).toEqual(['b-0002', 'b-0001']);
    expect(chrome.isMultiSelected('b-0002')).toBe(true);
    expect(chrome.isMultiSelected('b-0003')).toBe(false);
    expect(chrome.getHandleVisibility('b-0002')).toBe('multi');
    expect(chrome.getHandleVisibility('b-0003')).toBe('hidden');

    const cleared = chrome.clearMultiSelected();
    expect(cleared.multiSelectedIds).toEqual([]);
    expect(chrome.isMultiSelected('b-0002')).toBe(false);
    expect(chrome.getHandleVisibility('b-0002')).toBe('hidden');
  });

  it('空列表 set 等价 clear；默认 L0 无噪声', () => {
    const chrome = new BlockChromeModel();
    const initial = chrome.getSnapshot();
    expect(initial.silentLevel).toBe('L0');
    expect(initial.multiSelectedIds).toEqual([]);
    expect(initial.hoveredBlockId).toBeNull();
    expect(initial.commandActive).toBe(false);

    chrome.setMultiSelected(['x']);
    chrome.setMultiSelected([]);
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([]);
  });

  it('折叠与 hover/focus 把手按需；resetToSilent 清交互', () => {
    const chrome = new BlockChromeModel();
    chrome.setHovered('b-1');
    expect(chrome.getHandleVisibility('b-1')).toBe('hover');
    chrome.setFocused('b-2');
    expect(chrome.getHandleVisibility('b-2')).toBe('focus');
    // focus 优先于同块 hover
    chrome.setHovered('b-2');
    expect(chrome.getHandleVisibility('b-2')).toBe('focus');

    chrome.setCollapsed('b-1', true);
    expect(chrome.isCollapsed('b-1')).toBe(true);
    chrome.toggleCollapsed('b-1');
    expect(chrome.isCollapsed('b-1')).toBe(false);
    chrome.toggleCollapsed('b-1');
    expect(chrome.isCollapsed('b-1')).toBe(true);

    chrome.setMultiSelected(['b-3']);
    chrome.setCommandActive(true);
    const after = chrome.resetToSilent();
    expect(after.hoveredBlockId).toBeNull();
    expect(after.focusedBlockId).toBeNull();
    expect(after.multiSelectedIds).toEqual([]);
    expect(after.commandActive).toBe(false);
    // 折叠保留（呈现态，非瞬时 chrome 噪声）
    expect(chrome.isCollapsed('b-1')).toBe(true);
  });
});
