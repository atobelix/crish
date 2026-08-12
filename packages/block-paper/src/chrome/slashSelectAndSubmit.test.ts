/**
 * slashSelectAndSubmit · 选中 → Intent → sink（形状 + collab 不回退）
 *
 * ## 轨
 * - mock 形状可测；collab Strict 路径保持 createCollabApplySink
 * - **≠ EL-01**；**≠ A-BLK-02 e2e**
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  createCollabApplySink,
  createMockIntentSink,
  type ApplyOpsAdapter,
} from '../leaves/intentBridge';
import { resetIntentIdSeqForTests } from '../intentId';
import { SlashMenuModel } from './SlashMenuModel';
import {
  groupSlashCatalogItems,
  selectSlashActiveAndSubmit,
  selectSlashItemAndSubmit,
} from './slashSelectAndSubmit';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

describe('groupSlashCatalogItems', () => {
  it('相邻同 group 合并，保序', () => {
    const segs = groupSlashCatalogItems([
      { id: 'a', group: '基础' },
      { id: 'b', group: '基础' },
      { id: 'c', group: '列表' },
      { id: 'd' },
    ]);
    expect(segs).toEqual([
      {
        group: '基础',
        items: [
          { id: 'a', group: '基础' },
          { id: 'b', group: '基础' },
        ],
      },
      { group: '列表', items: [{ id: 'c', group: '列表' }] },
      { group: undefined, items: [{ id: 'd' }] },
    ]);
  });
});

describe('selectSlashItemAndSubmit → mock sink', () => {
  it('heading-1 → slash_insert 进 mock.calls', async () => {
    const menu = new SlashMenuModel({
      createIntentId: () => 'slash-sub-h1',
    });
    expect(menu.open('b-1', 2).ok).toBe(true);
    const mock = createMockIntentSink();

    const r = await selectSlashItemAndSubmit(menu, 'heading-1', mock.sink);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent).toMatchObject({
      type: 'slash_insert',
      blockId: 'b-1',
      offset: 2,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      origin: 'slash',
      intentId: 'slash-sub-h1',
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(r.intent);
    expect(menu.isOpen()).toBe(false);
  });

  it('catalog 最小集：paragraph / bullet / code 均可提交', async () => {
    const mock = createMockIntentSink();
    for (const id of ['paragraph', 'bullet', 'code'] as const) {
      const menu = new SlashMenuModel({
        createIntentId: () => `slash-${id}`,
      });
      expect(menu.open('anchor', 0).ok).toBe(true);
      const r = await selectSlashItemAndSubmit(menu, id, mock.sink);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.intent.catalogItemId).toBe(id);
        expect(r.intent.flavour).toBe(id);
      }
    }
    expect(mock.calls).toHaveLength(3);
  });

  it('未打开 → stage=select 失败，不进 sink', async () => {
    const menu = new SlashMenuModel();
    const mock = createMockIntentSink();
    const r = await selectSlashItemAndSubmit(menu, 'paragraph', mock.sink);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('select');
      if (r.stage === 'select') expect(r.select.code).toBe('not_open');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('composing 拒绝 select，不进 sink', async () => {
    let composing = false;
    const menu = new SlashMenuModel({
      isComposing: () => composing,
      createIntentId: () => 'c1',
    });
    expect(menu.open('b', 0).ok).toBe(true);
    composing = true;
    const mock = createMockIntentSink();
    const r = await selectSlashItemAndSubmit(menu, 'code', mock.sink);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('select');
    expect(mock.calls).toHaveLength(0);
    expect(menu.isOpen()).toBe(true);
  });
});

describe('selectSlashActiveAndSubmit', () => {
  it('Enter 路径：高亮项 → sink', async () => {
    const menu = new SlashMenuModel({
      createIntentId: () => 'slash-active-sub',
    });
    expect(menu.open('b-x', 1).ok).toBe(true);
    menu.moveActive(1); // 通常 heading-1
    const mock = createMockIntentSink();
    const r = await selectSlashActiveAndSubmit(menu, mock.sink);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.type).toBe('slash_insert');
    expect(mock.calls[0]).toEqual(r.intent);
  });
});

describe('selectSlashItemAndSubmit → collab sink（不回退 mock）', () => {
  it('createCollabApplySink wire insert；无 mock.calls', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const collab = createCollabApplySink({
      applyOps,
      allocateId: () => 'new-from-slash',
      resolveOrder: () => 'a0',
    });
    const menu = new SlashMenuModel({
      createIntentId: () => 'slash-collab-helper',
    });
    expect(menu.open('anchor-blk', 0).ok).toBe(true);

    const r = await selectSlashItemAndSubmit(menu, 'paragraph', collab.sink);
    expect(r.ok).toBe(true);
    expect(collab.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"insert"');
    expect(applied[0]).toContain('new-from-slash');
    // 叙事：本路径无 mock.calls
    expect('calls' in collab).toBe(false);
  });
});
