/**
 * Round9：StructureIntent / PaperIntent → collab Op wire 双向测。
 *
 * - Intent → wire（字段齐全、tag=op snake_case）
 * - wire JSON 往返
 * - 纪律：UI Intent 不得当 collab 旧形状直接塞 OpIntent
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  assertWireFieldsPresent,
  collabOpsFromJson,
  collabOpsToJson,
  isCollabOpWire,
  type CollabOpWire,
} from '@crish/block-paper-contract';
import { resetIntentIdSeqForTests } from '../intentId';
import {
  buildDeleteBlocksIntent,
  buildInsertBlockIntent,
  buildMoveBlocksIntent,
  buildSlashInsertIntent,
  buildToggleCollapseIntent,
  paperIntentToOps,
  structureIntentToOp,
  structureIntentToOps,
  type PaperIntent,
} from './structureIntents';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID_NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

function expectAllWire(ops: CollabOpWire[]) {
  for (const op of ops) {
    expect(isCollabOpWire(op)).toBe(true);
    assertWireFieldsPresent(op);
  }
}

describe('structureIntentToOps · 四类结构 Intent', () => {
  it('slash_insert → insert wire（allocateId + flavour→kind）', () => {
    const intent = buildSlashInsertIntent({
      blockId: ID_A,
      offset: 3,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      parentId: null,
      createIntentId: () => 'si-slash',
    });
    const ops = structureIntentToOps(intent, {
      allocateId: () => ID_NEW,
    });
    expect(ops).toEqual([
      {
        op: 'insert',
        id: ID_NEW,
        parent: null,
        order: 'i0000',
        kind: { heading: { level: 1 } },
        props: { attrs: {} },
      },
    ] satisfies CollabOpWire[]);
    expectAllWire(ops);
  });

  it('slash_insert 无 allocateId 且无 blockIds → 抛错', () => {
    const intent = buildSlashInsertIntent({
      blockId: ID_A,
      offset: 0,
      flavour: 'paragraph',
      catalogItemId: 'paragraph',
      createIntentId: () => 'si-no-id',
    });
    expect(() => structureIntentToOps(intent)).toThrow(/allocateId/);
  });

  it('insert_block 带预分配 blockIds → insert', () => {
    const intent = buildInsertBlockIntent({
      parentId: ID_A,
      flavour: 'code',
      blockIds: [ID_NEW],
      createIntentId: () => 'si-ins',
    });
    const ops = structureIntentToOps(intent);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: 'insert',
      id: ID_NEW,
      parent: ID_A,
      kind: 'code',
      props: { attrs: {} },
    });
    expectAllWire(ops);
  });

  it('delete_blocks → delete × N', () => {
    const intent = buildDeleteBlocksIntent({
      blockIds: [ID_A, ID_B],
      createIntentId: () => 'si-del',
    });
    const ops = structureIntentToOps(intent);
    expect(ops).toEqual([
      { op: 'delete', id: ID_A },
      { op: 'delete', id: ID_B },
    ]);
    expectAllWire(ops);
  });

  it('move_blocks → move × N（index→order）', () => {
    const intent = buildMoveBlocksIntent({
      blockIds: [ID_A, ID_B],
      parentId: null,
      index: 2,
      createIntentId: () => 'si-mv',
    });
    const ops = structureIntentToOps(intent);
    expect(ops).toEqual([
      { op: 'move', id: ID_A, new_parent: null, order: 'i0002' },
      { op: 'move', id: ID_B, new_parent: null, order: 'i0003' },
    ]);
    expectAllWire(ops);
  });

  it('toggle_collapse → patch_attrs collapsed', () => {
    const forced = buildToggleCollapseIntent({
      blockIds: [ID_A],
      collapsed: false,
      createIntentId: () => 'si-col',
    });
    expect(structureIntentToOps(forced)).toEqual([
      {
        op: 'patch_attrs',
        id: ID_A,
        set: { collapsed: false },
        remove: [],
      },
    ]);

    const toggled = buildToggleCollapseIntent({
      blockIds: [ID_A, ID_B],
      createIntentId: () => 'si-col2',
    });
    const ops = structureIntentToOps(toggled, {
      resolveCollapsed: (id) => id === ID_B,
    });
    expect(ops).toEqual([
      {
        op: 'patch_attrs',
        id: ID_A,
        set: { collapsed: false },
        remove: [],
      },
      {
        op: 'patch_attrs',
        id: ID_B,
        set: { collapsed: true },
        remove: [],
      },
    ]);
    expectAllWire(ops);
  });

  it('逐块 toggle 目标态可展开到 wire；缺少目标态时拒绝转换', () => {
    const mixed = buildToggleCollapseIntent({
      blockIds: [ID_A, ID_B],
      collapsedByBlock: { [ID_A]: false, [ID_B]: true },
      createIntentId: () => 'si-mixed-toggle',
    });
    const ops = structureIntentToOps(mixed);
    expect(ops).toEqual([
      {
        op: 'patch_attrs',
        id: ID_A,
        set: { collapsed: false },
        remove: [],
      },
      {
        op: 'patch_attrs',
        id: ID_B,
        set: { collapsed: true },
        remove: [],
      },
    ]);
    expectAllWire(ops);

    const unresolved = buildToggleCollapseIntent({
      blockIds: [ID_A],
      createIntentId: () => 'si-unresolved-toggle',
    });
    expect(() => structureIntentToOps(unresolved)).toThrow(/缺少 .* 的目标态/);
  });
});

describe('structureIntentToOp / paperIntentToOps', () => {
  it('structureIntentToOp 包装为 W0 OpIntent', () => {
    const intent = buildDeleteBlocksIntent({
      blockIds: [ID_A],
      createIntentId: () => 'wrap-1',
    });
    const opIntent = structureIntentToOp(intent);
    expect(opIntent.type).toBe('op');
    expect(opIntent.intentId).toBe('wrap-1');
    expect(opIntent.ops).toEqual([{ op: 'delete', id: ID_A }]);
  });

  it('paperIntentToOps：text_edit → text_edit wire', () => {
    const text: PaperIntent = {
      type: 'text_edit',
      blockId: ID_A,
      range: [1, 3],
      insert: 'xy',
      intentId: 't-1',
    };
    const ops = paperIntentToOps(text);
    expect(ops).toEqual([
      { op: 'text_edit', id: ID_A, start: 1, end: 3, insert: 'xy' },
    ]);
    expectAllWire(ops);
  });

  it('paperIntentToOps：StructureIntent 与已是 wire 的 OpIntent', () => {
    const del = buildDeleteBlocksIntent({
      blockIds: [ID_A],
      createIntentId: () => 'p-del',
    });
    expect(paperIntentToOps(del)).toEqual([{ op: 'delete', id: ID_A }]);

    const already = structureIntentToOp(del);
    expect(paperIntentToOps(already)).toEqual([{ op: 'delete', id: ID_A }]);
  });

  it('paperIntentToOps：拒绝 OpIntent 内旧 UI 形状', () => {
    const bad: PaperIntent = {
      type: 'op',
      intentId: 'bad-1',
      ops: [{ type: 'delete_blocks', blockIds: [ID_A] }],
    };
    expect(() => paperIntentToOps(bad)).toThrow(/非 collab wire/);
  });
});

describe('Intent → wire JSON 往返（双向）', () => {
  it('delete/move/collapse/insert 序列化后再解析字段齐全', () => {
    const bundle: CollabOpWire[] = [
      ...structureIntentToOps(
        buildDeleteBlocksIntent({
          blockIds: [ID_A],
          createIntentId: () => 'j1',
        })
      ),
      ...structureIntentToOps(
        buildMoveBlocksIntent({
          blockIds: [ID_B],
          parentId: ID_A,
          index: 0,
          createIntentId: () => 'j2',
        })
      ),
      ...structureIntentToOps(
        buildToggleCollapseIntent({
          blockIds: [ID_A],
          collapsed: true,
          createIntentId: () => 'j3',
        })
      ),
      ...structureIntentToOps(
        buildInsertBlockIntent({
          parentId: null,
          flavour: 'paragraph',
          blockIds: [ID_NEW],
          createIntentId: () => 'j4',
        })
      ),
    ];

    const json = collabOpsToJson(bundle);
    // snake_case tags
    expect(json).toContain('"op":"delete"');
    expect(json).toContain('"op":"move"');
    expect(json).toContain('"new_parent"');
    expect(json).toContain('"op":"patch_attrs"');
    expect(json).toContain('"op":"insert"');

    const back = collabOpsFromJson(json);
    expect(back).toEqual(bundle);
    expectAllWire(back);
  });

  it('与 Rust 示例 insert 形状键一致', () => {
    const ops = structureIntentToOps(
      buildInsertBlockIntent({
        parentId: null,
        flavour: 'paragraph',
        blockIds: [ID_NEW],
        createIntentId: () => 'rust-shape',
      }),
      { resolveOrder: () => 'a0' }
    );
    expect(JSON.parse(collabOpsToJson(ops))[0]).toEqual({
      op: 'insert',
      id: ID_NEW,
      parent: null,
      order: 'a0',
      kind: 'paragraph',
      props: { attrs: {} },
    });
  });
});
