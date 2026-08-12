/**
 * 结构 Intent → collab Op wire 映射（SD-08 · structureIntents 三切 · wire）
 *
 * UI Intent **不得**直接写盘；须 wire → apply。
 * 类型见 `structureIntentTypes`；工厂见 `structureIntentBuilders`。
 *
 * ## 写路径纪律（强制 · W3-D Strict / G-INV-3）
 *
 * - `StructureIntent` → `structureIntentToOps` / `paperIntentToOps` /
 *   `submitStructureToCollabWire`（collab wire JSON）
 *   → **`createCollabApplySink`（生产默认）** / IPC → RS `ops_from_json` → `DocSession::apply`
 * - wire 形状对齐 `conex-doc-collab::Op`（snake_case、tag=`op`）
 * - `createMockIntentSink` **仅**形状测；**不得**关 Strict 冒充 W3-D / W3-F Strict
 * - **≠ EL-01**
 *
 * ## 轨声明（诚实 · 09 §0.4）
 *
 * - 本模块提供 wire 半桥；**生产 sink** 用 `createCollabApplySink`
 * - 真 PM 叶见 `leaves/pm`（W3-D-PM）；与本 wire + RS 真 apply 合 = **W3-D**
 * - **W3-F Strict 子集**：chrome `slash_insert` / `delete_blocks` → wire → RS apply
 */

import type {
  BlockId,
  CollabOpWire,
  IntentId,
  OpIntent,
} from '@crish/block-paper-contract';
import {
  assertCollabOpsWire,
  collabOpsToJson,
  collabPropsWithAttrs,
  emptyCollabProps,
  flavourToCollabKind,
  isCollabOpWire,
  orderFromIndex,
} from '@crish/block-paper-contract';
import type {
  InsertBlockIntent,
  PaperIntent,
  SlashInsertIntent,
  StructureIntent,
} from './structureIntentTypes';

// ---------------------------------------------------------------------------
// → collab Op wire / W0 OpIntent 映射（Round9 · 可测桥）
// ---------------------------------------------------------------------------

/** Intent → wire 映射选项（占位 id / order / collapse 解析） */
export type StructureToOpsOptions = {
  /**
   * 插入时分配块 id（当 Intent 未带 `blockIds`）。
   * 未提供且缺 id 时抛错——避免静默伪造权威 id。
   */
  allocateId?: () => BlockId;
  /**
   * 解析 fractional order；缺省 `orderFromIndex(index)`。
   * `@param index` 为同批内序号或 move 的目标 index。
   */
  resolveOrder?: (ctx: {
    index: number;
    blockId: BlockId;
    parentId: BlockId | null;
  }) => string;
  /**
   * toggle_collapse 且 Intent.collapsed 缺省时，解析每块目标态。
   * 仍缺省则 **collapse=true**（桥占位；宿主应注入真实态）。
   */
  resolveCollapsed?: (blockId: BlockId) => boolean;
};

function resolveInsertId(
  intent: InsertBlockIntent | SlashInsertIntent,
  options: StructureToOpsOptions,
  slot: number
): BlockId {
  const fromIntent =
    'blockIds' in intent && intent.blockIds && intent.blockIds[slot];
  if (fromIntent) return fromIntent;
  if (options.allocateId) return options.allocateId();
  throw new Error(
    `structureIntentToOps：insert 缺 block id（slot=${slot}）；请在 Intent.blockIds 预分配或提供 options.allocateId`
  );
}

function resolveOrderKey(
  options: StructureToOpsOptions,
  ctx: { index: number; blockId: BlockId; parentId: BlockId | null }
): string {
  if (options.resolveOrder) return options.resolveOrder(ctx);
  return orderFromIndex(ctx.index);
}

/**
 * 结构 Intent → collab `Op` wire 列表（snake_case、tag=`op`）。
 *
 * | Intent            | wire                                      |
 * |-------------------|-------------------------------------------|
 * | insert_block      | insert（1+；多 id 则多条）                |
 * | slash_insert      | insert（1；id 来自 blockIds/allocateId）  |
 * | delete_blocks     | delete × N                                |
 * | move_blocks       | move × N（order 来自 index 或序号）       |
 * | toggle_collapse   | update_props × N（attrs.collapsed）       |
 *
 * **不**直接 apply；调用方须下发 sink / RS。
 */
export function structureIntentToOps(
  intent: StructureIntent,
  options: StructureToOpsOptions = {}
): CollabOpWire[] {
  switch (intent.type) {
    case 'insert_block': {
      const ids =
        intent.blockIds && intent.blockIds.length > 0
          ? intent.blockIds
          : [resolveInsertId(intent, options, 0)];
      const kind = flavourToCollabKind(intent.flavour);
      const baseIndex =
        intent.afterBlockId != null ? 1 : 0; /* 仅占位；真 fractional 由 RS */
      return ids.map((id, i) => ({
        op: 'insert' as const,
        id,
        parent: intent.parentId,
        order: resolveOrderKey(options, {
          index: baseIndex + i,
          blockId: id,
          parentId: intent.parentId,
        }),
        kind,
        props: emptyCollabProps(),
      }));
    }
    case 'slash_insert': {
      const id = resolveInsertId(intent, options, 0);
      const parent = intent.parentId !== undefined ? intent.parentId : null;
      return [
        {
          op: 'insert',
          id,
          parent,
          order: resolveOrderKey(options, {
            index: 0,
            blockId: id,
            parentId: parent,
          }),
          kind: flavourToCollabKind(intent.flavour),
          props: emptyCollabProps(),
        },
      ];
    }
    case 'delete_blocks':
      return intent.blockIds.map((id) => ({
        op: 'delete' as const,
        id,
      }));
    case 'move_blocks': {
      const startIndex =
        intent.index !== undefined && Number.isFinite(intent.index)
          ? Math.max(0, Math.floor(intent.index))
          : 0;
      return intent.blockIds.map((id, i) => ({
        op: 'move' as const,
        id,
        new_parent: intent.parentId,
        order: resolveOrderKey(options, {
          index: startIndex + i,
          blockId: id,
          parentId: intent.parentId,
        }),
      }));
    }
    case 'toggle_collapse': {
      return intent.blockIds.map((id) => {
        let collapsed: boolean;
        if (intent.collapsed !== undefined) {
          collapsed = intent.collapsed;
        } else if (options.resolveCollapsed) {
          collapsed = options.resolveCollapsed(id);
        } else {
          collapsed = true;
        }
        return {
          op: 'update_props' as const,
          id,
          props: collabPropsWithAttrs({ collapsed }),
        };
      });
    }
    default: {
      const _exhaustive: never = intent;
      throw new Error(
        `structureIntentToOps：未知 StructureIntent ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

/**
 * 将结构 Intent 压成 W0 `op` Intent；`ops` 为 collab wire 数组。
 *
 * mock sink 默认可直接收 StructureIntent；接 RS / 序列化通道时调用本函数。
 * **UI 不得跳过 apply 写盘。**
 */
export function structureIntentToOp(
  intent: StructureIntent,
  options: StructureToOpsOptions = {}
): OpIntent {
  return {
    type: 'op',
    intentId: intent.intentId,
    ops: structureIntentToOps(intent, options),
  };
}

/**
 * PaperIntent → collab wire 列表。
 *
 * - StructureIntent → `structureIntentToOps`
 * - OpIntent：若 ops 已是 wire 则原样校验返回；否则抛错（禁止把 UI 旧形状当 collab）
 * - TextEditIntent → 单条 `text_edit` wire
 *
 * 产出仅供 sink → RS apply；**禁止** UI 直接落盘。
 */
export function paperIntentToOps(
  intent: PaperIntent,
  options: StructureToOpsOptions = {}
): CollabOpWire[] {
  if (intent.type === 'text_edit') {
    const [start, end] = intent.range;
    return [
      {
        op: 'text_edit',
        id: intent.blockId,
        start,
        end,
        insert: intent.insert,
      },
    ];
  }
  if (intent.type === 'op') {
    // 已是 wire 则通过；混入旧 UI 形状则拒绝（逼宿主走 structureIntentToOps）
    if (intent.ops.every(isCollabOpWire)) {
      return assertCollabOpsWire(intent.ops);
    }
    throw new Error(
      'paperIntentToOps：OpIntent.ops 含非 collab wire 条目；请用 structureIntentToOps 映射 StructureIntent，或直接填 collab Op wire'
    );
  }
  return structureIntentToOps(intent, options);
}

// ---------------------------------------------------------------------------
// W3-D 子集 · TS 半桥：Intent → collab wire JSON（供 RS ops_from_json）
// ---------------------------------------------------------------------------

/**
 * `submitStructureToCollabWire` 返回值。
 *
 * - `ops`：已校验 collab wire 列表
 * - `json`：可直接喂给 Rust `ops_from_json` / `ops_from_json_str` 的 JSON 字符串
 *
 * **本函数不调用 DocSession::apply**——真 apply 在 RS 侧
 *（测名 `w3_d_structure_intent_or_wire_applys_to_session`）。
 */
export type StructureCollabWirePayload = {
  ops: CollabOpWire[];
  json: string;
  /** 来源 intentId（审计；不进 wire） */
  intentId: IntentId;
};

/**
 * StructureIntent / PaperIntent → collab wire JSON（IPC / 真 apply 入口）。
 *
 * ### 轨（W3-D 写锥 · 被 `createCollabApplySink` 调用）
 * ```
 * PaperIntent
 *   → paperIntentToOps / structureIntentToOps
 *   → collabOpsToJson
 *   → applyOps / 宿主 IPC
 *   → RS ops_from_json → DocSession::apply → ProjectionDiff
 * ```
 *
 * - 生产宿主：优先 `createCollabApplySink({ applyOps })`（内部调本函数）
 * - 形状测仍可用 `createMockIntentSink`；**禁止** mock 冒充 W3-D Strict 关闭
 * - **≠ EL-01**
 *
 * @param intent 结构 / 文本 / 已是 wire 的 OpIntent
 * @param options allocateId / resolveOrder 等（同 structureIntentToOps）
 */
export function submitStructureToCollabWire(
  intent: PaperIntent,
  options: StructureToOpsOptions = {}
): StructureCollabWirePayload {
  // fail-closed：字段齐全 + tag=op snake_case（对齐 RS ops_from_json）
  const ops = assertCollabOpsWire(paperIntentToOps(intent, options));
  return {
    ops,
    json: collabOpsToJson(ops),
    intentId: intent.intentId,
  };
}
