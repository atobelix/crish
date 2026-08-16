/**
 * W3-D · TS wire 半桥测：StructureIntent / PaperIntent → collab wire JSON。
 *
 * ## 轨声明（诚实）
 * - `submitStructureToCollabWire` 产出可被 Rust `ops_from_json` 解析的 JSON
 * - 真 apply + `read_text`：RS `w3_d_strict_text_and_structure_intent_true_apply`
 * - 生产 sink：`createCollabApplySink`（见 `intentBridge.apply.test.ts`）
 * - **≠ EL-01**；**≠** mock sink 冒充 Strict 关闭
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  assertWireFieldsPresent,
  collabOpsFromJson,
  isCollabOpWire,
  type CollabOpWire,
} from '@crish/block-paper-contract';
import { resetIntentIdSeqForTests } from '../intentId';
import {
  buildDeleteBlocksIntent,
  buildInsertBlockIntent,
  buildSlashInsertIntent,
  submitStructureToCollabWire,
  type PaperIntent,
} from './structureIntents';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID_NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

beforeEach(() => {
  resetIntentIdSeqForTests();
});

/**
 * 与 Rust `w3_d_structure_intent_or_wire_applys_to_session` 同名语义的 TS 半桥：
 * Intent → wire JSON（可喂 ops_from_json）。
 * 真 apply / ProjectionDiff 在 Rust 侧断言。
 */
describe('w3_d_structure_intent_or_wire_applys_to_session · TS wire half', () => {
  it('insert StructureIntent → wire JSON 对齐 RS fixture 键', () => {
    const intent = buildInsertBlockIntent({
      parentId: null,
      flavour: 'paragraph',
      blockIds: [ID_A],
      createIntentId: () => 'w3d-ins',
    });
    const payload = submitStructureToCollabWire(intent, {
      resolveOrder: () => 'a0',
    });

    expect(payload.intentId).toBe('w3d-ins');
    expect(payload.ops).toHaveLength(1);
    expect(payload.ops[0]).toEqual({
      op: 'insert',
      id: ID_A,
      parent: null,
      order: 'a0',
      kind: 'paragraph',
      props: { attrs: {} },
    } satisfies CollabOpWire);

    // 可被 collabOpsFromJson 再解析（对称 ops_from_json）
    const back = collabOpsFromJson(payload.json);
    expect(back).toEqual(payload.ops);
    for (const op of back) {
      expect(isCollabOpWire(op)).toBe(true);
      assertWireFieldsPresent(op);
    }

    // 与 Rust 集成测 insert_json 首条键集一致
    expect(payload.json).toContain('"op":"insert"');
    expect(payload.json).toContain(ID_A);
    expect(payload.json).toContain('"order":"a0"');
  });

  it('slash_insert + text_edit + delete 均可出合法 wire', () => {
    const slash = buildSlashInsertIntent({
      blockId: ID_A,
      offset: 0,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      parentId: null,
      createIntentId: () => 'w3d-slash',
    });
    const slashPayload = submitStructureToCollabWire(slash, {
      allocateId: () => ID_B,
      resolveOrder: () => 'a1',
    });
    expect(slashPayload.ops[0]).toMatchObject({
      op: 'insert',
      id: ID_B,
      kind: { heading: { level: 1 } },
    });

    const text: PaperIntent = {
      type: 'text_edit',
      blockId: ID_A,
      range: [0, 0],
      insert: 'hello-w3d',
      intentId: 'w3d-text',
    };
    const textPayload = submitStructureToCollabWire(text);
    expect(textPayload.ops).toEqual([
      { op: 'text_edit', id: ID_A, start: 0, end: 0, insert: 'hello-w3d' },
    ]);
    expect(collabOpsFromJson(textPayload.json)).toEqual(textPayload.ops);

    const del = buildDeleteBlocksIntent({
      blockIds: [ID_B],
      createIntentId: () => 'w3d-del',
    });
    const delPayload = submitStructureToCollabWire(del);
    expect(delPayload.ops).toEqual([{ op: 'delete', id: ID_B }]);
    expect(collabOpsFromJson(delPayload.json)).toEqual(delPayload.ops);
  });

  it('拒绝非 collab 旧 UI 形状的 OpIntent', () => {
    const bad: PaperIntent = {
      type: 'op',
      intentId: 'bad',
      ops: [{ type: 'delete_blocks', blockIds: [ID_NEW] }],
    };
    expect(() => submitStructureToCollabWire(bad)).toThrow(/非 collab wire/);
  });
});
