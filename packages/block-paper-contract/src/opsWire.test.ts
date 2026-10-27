/**
 * collab Op wire 契约测：字段齐全 + JSON 往返。
 */
import { describe, expect, it } from 'vitest';
import {
  assertCollabOpsWire,
  assertWireFieldsPresent,
  collabOpsFromJson,
  collabOpsToJson,
  emptyCollabProps,
  flavourToCollabKind,
  isCollabOpWire,
  orderFromIndex,
  requiredWireFields,
  type CollabOpWire,
} from './opsWire';

const SAMPLE_ID = '11111111-1111-1111-1111-111111111111';

describe('opsWire · flavour / order', () => {
  it('flavourToCollabKind 覆盖常见 slash id', () => {
    expect(flavourToCollabKind('paragraph')).toBe('paragraph');
    expect(flavourToCollabKind('heading-1')).toEqual({
      heading: { level: 1 },
    });
    expect(flavourToCollabKind('heading-2')).toEqual({
      heading: { level: 2 },
    });
    expect(flavourToCollabKind('code')).toBe('code');
    expect(flavourToCollabKind('bullet')).toBe('bullet_item');
    expect(flavourToCollabKind('callout')).toEqual({
      unknown: { flavour: 'callout' },
    });
  });

  it('orderFromIndex 零填充字典序', () => {
    expect(orderFromIndex(0)).toBe('i0000');
    expect(orderFromIndex(12)).toBe('i0012');
    expect(orderFromIndex(0) < orderFromIndex(1)).toBe(true);
  });
});

describe('opsWire · 形状守卫与字段齐全', () => {
  const samples: CollabOpWire[] = [
    {
      op: 'insert',
      id: SAMPLE_ID,
      parent: null,
      order: 'a0',
      kind: 'paragraph',
      props: emptyCollabProps(),
    },
    {
      op: 'delete',
      id: SAMPLE_ID,
    },
    {
      op: 'move',
      id: SAMPLE_ID,
      new_parent: SAMPLE_ID,
      order: 'b0',
    },
    {
      op: 'update_props',
      id: SAMPLE_ID,
      props: { attrs: { collapsed: true } },
    },
    {
      op: 'patch_attrs',
      id: SAMPLE_ID,
      set: { collapsed: true },
      remove: ['legacy_key'],
    },
    {
      op: 'text_edit',
      id: SAMPLE_ID,
      start: 0,
      end: 1,
      insert: 'x',
    },
    {
      op: 'insert',
      id: SAMPLE_ID,
      parent: null,
      order: 'a1',
      kind: { heading: { level: 1 } },
      props: emptyCollabProps(),
    },
  ];

  it('isCollabOpWire 接受全种类合法样本', () => {
    for (const op of samples) {
      expect(isCollabOpWire(op)).toBe(true);
      assertWireFieldsPresent(op);
      for (const f of requiredWireFields(op)) {
        expect(op).toHaveProperty(f);
      }
    }
  });

  it('拒绝旧 UI 形状（type/delete_blocks）与缺字段', () => {
    expect(isCollabOpWire({ type: 'delete_blocks', blockIds: ['a'] })).toBe(
      false
    );
    expect(isCollabOpWire({ op: 'delete' })).toBe(false);
    expect(
      isCollabOpWire({
        op: 'patch_attrs',
        id: SAMPLE_ID,
        remove: [],
      })
    ).toBe(false);
    expect(
      isCollabOpWire({
        op: 'patch_attrs',
        id: SAMPLE_ID,
        set: {},
      })
    ).toBe(false);
    expect(
      isCollabOpWire({
        op: 'patch_attrs',
        id: SAMPLE_ID,
        set: { collapsed: true },
        remove: [1],
      })
    ).toBe(false);
    expect(
      isCollabOpWire({
        op: 'insert',
        id: SAMPLE_ID,
        parent: null,
        order: 'a0',
        kind: 'paragraph',
        // props 缺失
      })
    ).toBe(false);
    expect(
      isCollabOpWire({
        op: 'text_edit',
        id: SAMPLE_ID,
        start: 2,
        end: 1,
        insert: '',
      })
    ).toBe(false);
  });

  it('JSON 往返保持 op tag 与必填字段', () => {
    const json = collabOpsToJson(samples);
    const back = collabOpsFromJson(json);
    expect(back).toHaveLength(samples.length);
    expect(back.map((o) => o.op)).toEqual(samples.map((o) => o.op));
    expect(assertCollabOpsWire(back)).toEqual(back);

    // 对齐 Rust insert 形状键名
    const insert = back.find(
      (o) => o.op === 'insert' && o.kind === 'paragraph'
    );
    expect(insert).toMatchObject({
      op: 'insert',
      id: SAMPLE_ID,
      parent: null,
      order: 'a0',
      kind: 'paragraph',
      props: { attrs: {} },
    });
  });

  it('collabOpsFromJson 拒绝非数组 / 坏 JSON', () => {
    expect(() => collabOpsFromJson('{"op":"delete"}')).toThrow(/数组/);
    expect(() => collabOpsFromJson('not-json')).toThrow(/解析失败/);
  });
});
