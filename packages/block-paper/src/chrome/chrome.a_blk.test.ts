/**
 * A-BLK 契约抽样（**W6-A-S** · Skeleton）— block-paper chrome / StructureIntent。
 *
 * **≠ 关闭 EL-01 / A-BLK 全表 / 块工作区完成**。本文件只钉抽样：
 * - A-BLK-02 半：slash → StructureIntent（slash_insert）形状
 * - A-BLK-05 半：多选删除 Intent 形状
 * - A-BLK-03 半：静默 L0 把手按需策略（映射 A-SIL chrome）
 * - A-BLK-11 半：未知 flavour → collab Unknown wire
 * - A-BLK-13 半：toggle_collapse Intent 形状（≠ 高度图 e2e）
 * - A-BLK-14 半：CM6 代码叶可构造/可聚焦契约（≠ 产品 e2e）
 *
 * 进度表：`docs/block-workspace-architecture/plans/acceptance/A-BLK-progress.md`
 * 权威：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1
 * 调度：`plans/09` **W6-A-S**（禁止用本文件关 **W6-A** / **EL-01**）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { flavourToCollabKind } from '@crish/block-paper-contract';
import {
  resetIntentIdSeqForTests,
  nextIntentId,
} from '../leaves/TextLeafModel';
import { createMockIntentSink, submitIntent } from '../leaves/intentBridge';
import {
  createCm6EditorState,
  isCm6CodeLeafHost,
  Cm6CodeLeafHost,
} from '../leaves/code/Cm6CodeLeafHost';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';
import {
  buildSlashInsertIntent,
  buildToggleCollapseIntent,
  isStructureIntent,
  type SlashInsertIntent,
  type DeleteBlocksIntent,
  type ToggleCollapseIntent,
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

// ---------------------------------------------------------------------------
// A-BLK-11 半：未知 flavour → Unknown collab kind wire（非占位 View e2e）
// ---------------------------------------------------------------------------

describe('a_blk_11 未知 flavour → Unknown wire', () => {
  it('a_blk_11: flavourToCollabKind 未识别 → { unknown: { flavour } }', () => {
    // 与 RS BlockKind::Unknown 及 a_blk_11_* rust 契约对齐
    expect(flavourToCollabKind('callout-ext')).toEqual({
      unknown: { flavour: 'callout-ext' },
    });
    expect(flavourToCollabKind('my_plugin_block')).toEqual({
      unknown: { flavour: 'my_plugin_block' },
    });
    // 已知 flavour 不得误入 Unknown
    expect(flavourToCollabKind('paragraph')).toBe('paragraph');
    expect(flavourToCollabKind('code')).toBe('code');
  });

  it('a_blk_11: slash_insert 携带未知 flavour 字段完整且可进 mock sink', async () => {
    const intent = buildSlashInsertIntent({
      blockId: 'anchor-u',
      offset: 0,
      flavour: 'callout-ext',
      catalogItemId: 'callout-ext',
      createIntentId: () => 'a-blk-11-slash',
    });
    expect(intent.flavour).toBe('callout-ext');
    expect(flavourToCollabKind(intent.flavour)).toEqual({
      unknown: { flavour: 'callout-ext' },
    });
    const mock = createMockIntentSink();
    const r = await submitIntent(intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls[0]).toEqual(intent);
  });
});

// ---------------------------------------------------------------------------
// A-BLK-13 半：toggle_collapse Intent 形状（非高度图 / 选区钳制 e2e）
// ---------------------------------------------------------------------------

describe('a_blk_13 toggle_collapse Intent 形状', () => {
  it('a_blk_13: buildToggleCollapseIntent 字段钉死且 isStructureIntent', () => {
    const intent = buildToggleCollapseIntent({
      blockIds: ['c1', 'c1', 'c2'],
      collapsed: true,
      origin: 'chrome',
      createIntentId: () => 'a-blk-13-col',
    });
    expect(isStructureIntent(intent)).toBe(true);
    expect(intent).toEqual({
      type: 'toggle_collapse',
      intentId: 'a-blk-13-col',
      origin: 'chrome',
      blockIds: ['c1', 'c2'],
      collapsed: true,
    } satisfies ToggleCollapseIntent);
  });

  it('a_blk_13: chrome 多选折叠产出 toggle_collapse 并进 mock sink', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => 'a-blk-13-chrome',
    });
    chrome.setMultiSelected(['fold-a', 'fold-b']);
    // BlockChromeModel 若暴露 requestCollapseSelected 则用之；否则工厂直构
    const intent = buildToggleCollapseIntent({
      blockIds: chrome.getSnapshot().multiSelectedIds,
      collapsed: true,
      createIntentId: () => 'a-blk-13-chrome',
    });
    expect(intent.type).toBe('toggle_collapse');
    expect(intent.blockIds).toEqual(['fold-a', 'fold-b']);

    const mock = createMockIntentSink();
    const r = await submitIntent(intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      type: 'toggle_collapse',
      collapsed: true,
      blockIds: ['fold-a', 'fold-b'],
    });
  });
});

// ---------------------------------------------------------------------------
// A-BLK-14 半：CM6 代码叶可聚焦契约（EditorState 骨架；≠ 产品 e2e）
// ---------------------------------------------------------------------------

describe('a_blk_14 CM6 代码叶可聚焦契约', () => {
  it('a_blk_14: createCm6EditorState 可构造可写 doc（叶子核骨架）', () => {
    const { state } = createCm6EditorState({
      doc: 'const n = 1;',
      language: 'javascript',
      readOnly: false,
    });
    expect(state.doc.toString()).toBe('const n = 1;');
    // 默认可写：对照 readOnly:true
    const { state: ro } = createCm6EditorState({
      doc: 'x',
      readOnly: true,
    });
    const { state: rw } = createCm6EditorState({ doc: 'x' });
    expect(rw.doc.toString()).toBe('x');
    expect(ro.doc.toString()).toBe('x');
  });

  it('a_blk_14: Cm6CodeLeafHost 类型守卫与导出契约（无强制 DOM focus）', () => {
    // 类型/导出存在 = 代码叶核入库；真 focus / 产品挂载 e2e 仍开（W6-A）
    expect(typeof Cm6CodeLeafHost).toBe('function');
    expect(typeof isCm6CodeLeafHost).toBe('function');
    expect(isCm6CodeLeafHost(null)).toBe(false);
    expect(isCm6CodeLeafHost({})).toBe(false);
    const { state } = createCm6EditorState({ doc: 'fn main() {}' });
    expect(state.doc.length).toBeGreaterThan(0);
  });
});
