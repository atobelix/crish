/**
 * A-BLK 契约抽样（Round9 · W6-A）— block-paper chrome / StructureIntent。
 *
 * **≠ 关闭 EL-01 / A-BLK 全表**。本文件只钉：
 * - A-BLK-02 半：slash → StructureIntent（slash_insert）形状
 * - A-BLK-05 半：多选删除 Intent 形状
 * - A-BLK-03 半：静默 L0 把手按需策略（映射 A-SIL chrome）
 *
 * 进度表：`docs/block-workspace-architecture/plans/acceptance/A-BLK-progress.md`
 * 权威：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  resetIntentIdSeqForTests,
  nextIntentId,
} from '../leaves/TextLeafModel';
import { createMockIntentSink, submitIntent } from '../leaves/intentBridge';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';
import {
  buildSlashInsertIntent,
  isStructureIntent,
  type SlashInsertIntent,
  type DeleteBlocksIntent,
} from './structureIntents';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

// ---------------------------------------------------------------------------
// A-BLK-02 半：slash → StructureIntent 形状（非 e2e / 非 IME 全路径）
// ---------------------------------------------------------------------------

describe('a_blk_02 slash → StructureIntent 形状', () => {
  it('a_blk_02: SlashMenuModel.selectItem 产出 slash_insert 完整字段', () => {
    const menu = new SlashMenuModel({
      createIntentId: () => 'a-blk-02-slash',
    });
    expect(menu.open('block-anchor', 7).ok).toBe(true);

    const sel = menu.selectItem('heading-1');
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;

    const intent = sel.intent;
    expect(isStructureIntent(intent)).toBe(true);
    expect(intent).toEqual({
      type: 'slash_insert',
      intentId: 'a-blk-02-slash',
      origin: 'slash',
      blockId: 'block-anchor',
      offset: 7,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
    } satisfies SlashInsertIntent);
  });

  it('a_blk_02: buildSlashInsertIntent 工厂字段钉死且可进 mock sink', async () => {
    const intent = buildSlashInsertIntent({
      blockId: 'b-1',
      offset: 0,
      flavour: 'code',
      catalogItemId: 'code',
      parentId: null,
      createIntentId: () => 'a-blk-02-factory',
    });
    expect(intent).toMatchObject({
      type: 'slash_insert',
      origin: 'slash',
      blockId: 'b-1',
      flavour: 'code',
      catalogItemId: 'code',
      parentId: null,
    });
    expect(isStructureIntent(intent)).toBe(true);

    const mock = createMockIntentSink();
    const r = await submitIntent(intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(intent);
  });
});

// ---------------------------------------------------------------------------
// A-BLK-05 半：多选删除 Intent 形状（非框选 e2e / 非批量转类型）
// ---------------------------------------------------------------------------

describe('a_blk_05 多选删除 Intent 形状', () => {
  it('a_blk_05: requestDeleteSelected 产出 delete_blocks 去重保序', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => nextIntentId('a-blk-05'),
    });
    chrome.setMultiSelected(['b-c', 'b-a', 'b-c', '', 'b-b']);

    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    expect(isStructureIntent(del.intent)).toBe(true);
    expect(del.intent).toMatchObject({
      type: 'delete_blocks',
      origin: 'batch',
      blockIds: ['b-c', 'b-a', 'b-b'],
    } satisfies Partial<DeleteBlocksIntent>);
    expect(del.intent.intentId).toBeTruthy();
    expect(del.intent.blockIds).toHaveLength(3);

    // 成功后清多选（契约：Intent 已产出）
    expect(del.snapshot.multiSelectedIds).toEqual([]);

    const mock = createMockIntentSink();
    const r = await submitIntent(del.intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls[0]).toEqual(del.intent);
  });

  it('a_blk_05: 显式 blockIds + 命令态亦可产出批量删除', () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => 'a-blk-05-explicit',
    });
    chrome.setCommandActive(true);
    const del = chrome.requestDeleteSelected({
      blockIds: ['x1', 'x2'],
    });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.intent).toEqual({
      type: 'delete_blocks',
      intentId: 'a-blk-05-explicit',
      origin: 'batch',
      blockIds: ['x1', 'x2'],
    } satisfies DeleteBlocksIntent);
  });
});

// ---------------------------------------------------------------------------
// A-BLK-03 半：静默 L0 把手按需（映射 A-SIL；非 e2e/视觉）
// ---------------------------------------------------------------------------

describe('a_blk_03 静默 L0 把手策略', () => {
  it('a_blk_03: L0 默认无噪声；hover/focus/multi 按需露出把手', () => {
    const chrome = new BlockChromeModel();
    const snap = chrome.getSnapshot();
    expect(snap.silentLevel).toBe('L0');
    expect(snap.hoveredBlockId).toBeNull();
    expect(snap.focusedBlockId).toBeNull();
    expect(snap.multiSelectedIds).toEqual([]);
    expect(snap.commandActive).toBe(false);

    // 默认：任意块把手 hidden（A-SIL-01 / A-BLK-03 按需）
    expect(chrome.getHandleVisibility('b-any')).toBe('hidden');
    expect(chrome.getHandleVisibility('b-1')).toBe('hidden');

    // hover 按需
    chrome.setHovered('b-1');
    expect(chrome.getHandleVisibility('b-1')).toBe('hover');
    expect(chrome.getHandleVisibility('b-2')).toBe('hidden');

    // focus 优先
    chrome.setFocused('b-2');
    expect(chrome.getHandleVisibility('b-2')).toBe('focus');
    expect(chrome.getHandleVisibility('b-1')).toBe('hover');

    // multi 最高优先级
    chrome.setMultiSelected(['b-3']);
    expect(chrome.getHandleVisibility('b-3')).toBe('multi');
    expect(chrome.getHandleVisibility('b-1')).toBe('hover');

    // 回到静默：交互清零后把手全 hidden
    chrome.resetToSilent();
    expect(chrome.getHandleVisibility('b-1')).toBe('hidden');
    expect(chrome.getHandleVisibility('b-2')).toBe('hidden');
    expect(chrome.getHandleVisibility('b-3')).toBe('hidden');
    expect(chrome.getSnapshot().silentLevel).toBe('L0');
  });

  it('a_blk_03: 命令态不强制常驻全部把手（防 L0 退化）', () => {
    const chrome = new BlockChromeModel();
    chrome.setCommandActive(true);
    // 命令态开启仍不把无关块把手设为常驻
    expect(chrome.getHandleVisibility('untouched')).toBe('hidden');
    chrome.setHovered('touched');
    expect(chrome.getHandleVisibility('touched')).toBe('hover');
  });
});
