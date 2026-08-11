/**
 * W3-F-S / 形状轨 · 结构 Intent + mock sink：
 * - slash 选中 → slash_insert → mock sink（**仅形状**）
 * - composing 拒绝打开 / 拒绝提交
 * - 多选删除 Intent 形状 + silent L0 守卫
 * - mock sink 成功 / 拒绝
 *
 * ## 轨声明（诚实 · G-INV-3）
 *
 * - 本文件 = **W3-F-S** 形状 / IME 守卫；`mock.calls` **不得**作 **W3-F Strict** 关闭证据
 * - **W3-F Strict** 见 `chrome.w3f_apply.test.ts`（`createCollabApplySink`）+ RS `w3_f_*` / `w3_d_*`
 * - **≠ EL-01**；**≠** A-BLK-02/04/05 全关
 * - DOM 余量见 `chrome.w3f_dom.test.ts`（**DOM ≠ EL-01**）；本文件仍是 mock 形状轨
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ImeMachine } from '@crish/editor-kit';
import {
  resetIntentIdSeqForTests,
  nextIntentId,
} from '../leaves/TextLeafModel';
import { createMockIntentSink, submitIntent } from '../leaves/intentBridge';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';
import {
  buildDeleteBlocksIntent,
  buildInsertBlockIntent,
  buildMoveBlocksIntent,
  buildSlashInsertIntent,
  buildToggleCollapseIntent,
  isStructureIntent,
  isPaperIntent,
  structureIntentToOp,
  type DeleteBlocksIntent,
  type SlashInsertIntent,
} from './structureIntents';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

// ---------------------------------------------------------------------------
// structureIntents 形状
// ---------------------------------------------------------------------------

describe('structureIntents 类型与工厂', () => {
  it('各结构 Intent 字段含 intentId / origin / 判别 type', () => {
    const insert = buildInsertBlockIntent({
      parentId: null,
      flavour: 'paragraph',
      createIntentId: () => 'i-ins',
    });
    expect(insert).toMatchObject({
      type: 'insert_block',
      intentId: 'i-ins',
      origin: 'chrome',
      parentId: null,
      flavour: 'paragraph',
    });
    expect(isStructureIntent(insert)).toBe(true);
    expect(isPaperIntent(insert)).toBe(true);

    const del = buildDeleteBlocksIntent({
      blockIds: ['a', 'b', 'a', ''],
      createIntentId: () => 'i-del',
    });
    expect(del).toEqual({
      type: 'delete_blocks',
      intentId: 'i-del',
      origin: 'chrome',
      blockIds: ['a', 'b'],
    } satisfies DeleteBlocksIntent);

    const move = buildMoveBlocksIntent({
      blockIds: ['x'],
      parentId: 'p',
      index: 2,
      origin: 'drag',
      createIntentId: () => 'i-mv',
    });
    expect(move).toMatchObject({
      type: 'move_blocks',
      parentId: 'p',
      index: 2,
      origin: 'drag',
    });

    const collapse = buildToggleCollapseIntent({
      blockIds: ['c1'],
      collapsed: true,
      createIntentId: () => 'i-col',
    });
    expect(collapse).toMatchObject({
      type: 'toggle_collapse',
      collapsed: true,
      blockIds: ['c1'],
    });

    const slash = buildSlashInsertIntent({
      blockId: 'b-1',
      offset: 3,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      createIntentId: () => 'i-sl',
    });
    expect(slash).toMatchObject({
      type: 'slash_insert',
      origin: 'slash',
      blockId: 'b-1',
      offset: 3,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
    });
  });

  it('structureIntentToOp 压成 W0 op（collab wire delete）', () => {
    const s = buildDeleteBlocksIntent({
      blockIds: ['a'],
      createIntentId: () => 'i-1',
    });
    const op = structureIntentToOp(s);
    expect(op.type).toBe('op');
    expect(op.intentId).toBe('i-1');
    expect(op.ops).toHaveLength(1);
    // Round9：ops 为 conex-doc-collab snake_case wire，非 UI 镜像
    expect(op.ops[0]).toMatchObject({ op: 'delete', id: 'a' });
    expect(isStructureIntent(op)).toBe(false);
    expect(isPaperIntent(op)).toBe(true);
  });

  it('text_edit / 未知对象 类型守卫', () => {
    expect(
      isStructureIntent({
        type: 'text_edit',
        blockId: 'b',
        range: [0, 0],
        insert: '',
        intentId: 't',
      })
    ).toBe(false);
    expect(isStructureIntent(null)).toBe(false);
    expect(
      isPaperIntent({
        type: 'text_edit',
        blockId: 'b',
        range: [0, 1],
        insert: 'x',
        intentId: 't',
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slash → Intent → sink
// ---------------------------------------------------------------------------

describe('SlashMenuModel → slash_insert → sink', () => {
  it('selectItem 产出 slash_insert 并经 submitIntent 进 mock sink', async () => {
    const menu = new SlashMenuModel({
      createIntentId: () => nextIntentId('slash'),
    });
    expect(menu.open('b-0001', 4).ok).toBe(true);

    const sel = menu.selectItem('heading-1');
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;

    const intent = sel.intent;
    expect(intent).toMatchObject({
      type: 'slash_insert',
      blockId: 'b-0001',
      offset: 4,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      origin: 'slash',
    } satisfies Partial<SlashInsertIntent>);
    expect(intent.intentId).toBeTruthy();
    // 选中后关闭
    expect(menu.isOpen()).toBe(false);
    expect(sel.snapshot.open).toBe(false);

    const mock = createMockIntentSink();
    const r = await submitIntent(intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(intent);
  });

  it('selectActive 确认高亮项', async () => {
    const menu = new SlashMenuModel({
      createIntentId: () => 'slash-active',
    });
    menu.open('b-2', 0);
    menu.setQuery('代码');
    // 应过滤到 code
    const snap = menu.getSnapshot();
    expect(snap.items.some((i) => i.id === 'code')).toBe(true);
    menu.moveActive(0); // 保持 active
    // 若多项，移到 code
    const codeIdx = snap.items.findIndex((i) => i.id === 'code');
    if (codeIdx > 0) {
      menu.moveActive(codeIdx - snap.activeIndex);
    }

    const sel = menu.selectActive();
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect(sel.intent.type).toBe('slash_insert');
    expect(sel.intent.catalogItemId).toBe('code');

    const mock = createMockIntentSink();
    await submitIntent(sel.intent, mock.sink);
    expect(mock.calls[0]).toMatchObject({
      type: 'slash_insert',
      catalogItemId: 'code',
    });
  });

  // 矩阵映射：A-IME-02（ime-matrix.md · 🟨自动化；slash 在 composing 拒绝）
  it('A-IME-02: composing 时 open 与 select 均拒绝，不进 sink', async () => {
    let composing = true;
    const menu = new SlashMenuModel({
      isComposing: () => composing,
      createIntentId: () => 's-1',
    });
    const mock = createMockIntentSink();

    const openR = menu.open('b-1', 0);
    expect(openR.ok).toBe(false);
    if (!openR.ok) expect(openR.code).toBe('composing');

    // 先非 composing 打开，再 composing 提交
    composing = false;
    expect(menu.open('b-1', 1).ok).toBe(true);
    composing = true;

    const sel = menu.selectItem('paragraph');
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.code).toBe('composing');
    // 拒绝提交时菜单仍打开（可重试）
    expect(menu.isOpen()).toBe(true);

    // 直接 submit 结构 Intent 在 composing 下也被桥拒绝
    const forged = buildSlashInsertIntent({
      blockId: 'b-1',
      offset: 0,
      flavour: 'paragraph',
      catalogItemId: 'paragraph',
      createIntentId: () => 'forged',
    });
    const r = await submitIntent(forged, mock.sink, {
      isComposing: () => true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('composing_structure_op');
    expect(mock.calls).toHaveLength(0);
  });

  it('A-IME-02: composing + ImeMachine 同样拒绝 slash_insert', async () => {
    const mock = createMockIntentSink();
    const ime = new ImeMachine();
    ime.startComposition('b-1');
    const intent = buildSlashInsertIntent({
      blockId: 'b-1',
      offset: 0,
      flavour: 'quote',
      catalogItemId: 'quote',
      createIntentId: () => 'q-1',
    });
    const r = await submitIntent(intent, mock.sink, { ime });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('composing_structure_op');
    expect(mock.calls).toHaveLength(0);
  });

  it('未打开 / 未知项拒绝', () => {
    const menu = new SlashMenuModel();
    expect(menu.selectActive().ok).toBe(false);
    menu.open('b-1', 0);
    const miss = menu.selectItem('___nope___');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.code).toBe('item_not_found');
  });
});

// ---------------------------------------------------------------------------
// BlockChrome 多选 → 批量结构 Intent
// ---------------------------------------------------------------------------

describe('BlockChromeModel 多选 → 结构 Intent', () => {
  it('多选删除 Intent 形状 + mock sink 成功', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => nextIntentId('chrome'),
    });
    chrome.setMultiSelected(['b-0002', 'b-0001', 'b-0002']);

    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    expect(del.intent).toMatchObject({
      type: 'delete_blocks',
      origin: 'batch',
      blockIds: ['b-0002', 'b-0001'],
    });
    expect(del.intent.intentId).toBeTruthy();
    // 成功后清多选
    expect(del.snapshot.multiSelectedIds).toEqual([]);
    expect(chrome.getSnapshot().multiSelectedIds).toEqual([]);

    const mock = createMockIntentSink();
    const r = await submitIntent(del.intent, mock.sink);
    expect(r.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(del.intent);
    expect(isStructureIntent(mock.calls[0])).toBe(true);
  });

  it('mock sink 拒绝 delete_blocks 透传', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => 'del-rej',
    });
    chrome.setMultiSelected(['x', 'y']);
    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    const mock = createMockIntentSink({ ok: false, reason: 'conflict' });
    const r = await submitIntent(del.intent, mock.sink);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('sink_reject');
      expect(r.reason).toBe('conflict');
    }
    expect(mock.calls).toHaveLength(1);
  });

  it('静默 L0 无多选/命令时危险删除守卫', () => {
    const chrome = new BlockChromeModel();
    expect(chrome.getSilentLevel()).toBe('L0');
    expect(chrome.canPerformDangerousStructure()).toBe(false);

    // 空选
    const empty = chrome.requestDeleteSelected();
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_selection');

    // 显式 ids 但纯 L0 无抬升 → silent_l0_guard
    const guarded = chrome.requestDeleteSelected({
      blockIds: ['sneaky'],
      createIntentId: () => 'nope',
    });
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) {
      expect(guarded.code).toBe('silent_l0_guard');
      expect(guarded.reason).toMatch(/L0|静默|A-SIL/i);
    }

    // 命令态抬升后可删
    chrome.setCommandActive(true);
    const ok = chrome.requestDeleteSelected({
      blockIds: ['sneaky'],
      createIntentId: () => 'ok-cmd',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.intent.blockIds).toEqual(['sneaky']);
    }
  });

  it('L1 或 多选 可危险删除；composing 下 submit 拒绝', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => 'l1-del',
    });
    chrome.setSilentLevel('L1');
    const del = chrome.requestDeleteSelected({ blockIds: ['a', 'b'] });
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    const mock = createMockIntentSink();
    const r = await submitIntent(del.intent, mock.sink, {
      isComposing: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('composing_structure_op');
    expect(mock.calls).toHaveLength(0);
  });

  it('多选 / 焦点折叠产出 toggle_collapse 并同步本地态', async () => {
    const chrome = new BlockChromeModel({
      createIntentId: () => 'col-1',
    });
    chrome.setMultiSelected(['b-1', 'b-2']);
    const r1 = chrome.requestToggleCollapse(true);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.intent).toMatchObject({
      type: 'toggle_collapse',
      blockIds: ['b-1', 'b-2'],
      collapsed: true,
      origin: 'chrome',
    });
    expect(chrome.isCollapsed('b-1')).toBe(true);
    expect(chrome.isCollapsed('b-2')).toBe(true);

    const mock = createMockIntentSink();
    await submitIntent(r1.intent, mock.sink);
    expect(mock.calls[0]?.type).toBe('toggle_collapse');

    // 无多选时回落焦点
    chrome.clearMultiSelected();
    chrome.setFocused('b-3');
    const r2 = chrome.requestToggleCollapse();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.intent.blockIds).toEqual(['b-3']);
    expect(chrome.isCollapsed('b-3')).toBe(true);
  });

  it('无目标折叠 empty_selection', () => {
    const chrome = new BlockChromeModel();
    const r = chrome.requestToggleCollapse();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('empty_selection');
  });
});

// ---------------------------------------------------------------------------
// 端到端：slash + 多选删除 共用 mock sink
// ---------------------------------------------------------------------------

describe('W3-F 端到端 mock sink', () => {
  it('slash_insert 与 delete_blocks 顺序进入同一 sink', async () => {
    const mock = createMockIntentSink();
    const menu = new SlashMenuModel({ createIntentId: () => 'e2e-slash' });
    const chrome = new BlockChromeModel({ createIntentId: () => 'e2e-del' });

    menu.open('anchor', 2);
    const sel = menu.selectItem('bullet');
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect((await submitIntent(sel.intent, mock.sink)).ok).toBe(true);

    chrome.setMultiSelected(['b-a', 'b-b']);
    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect((await submitIntent(del.intent, mock.sink)).ok).toBe(true);

    expect(mock.calls.map((c) => c.type)).toEqual([
      'slash_insert',
      'delete_blocks',
    ]);
  });
});
