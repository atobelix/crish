/**
 * 结构 Intent 类型（W3-F 骨架 + W3-D 真 apply 半桥）。
 *
 * 与 `TextLeafModel` 产出的 `text_edit`（文本 Intent）区分：
 * - 文本 Intent：叶子局部替换（W0 `TextEditIntent`）
 * - 结构 Intent：插入 / 删除 / 移动 / 折叠 / slash 选中项
 *
 * 联合：`PaperIntent = TextIntent | StructureIntent | OpIntent(W0)`
 * （见下方；`OpIntent` 仍可直接下发 sink，结构 Intent 亦可经 `structureIntentToOp` 映射）。
 *
 * ## 写路径纪律（强制 · Round9 / W3-D 子集）
 *
 * - **UI StructureIntent 不得直接写盘 / 旁路 mutate 树**
 * - 必须：`StructureIntent` → `structureIntentToOps` / `paperIntentToOps` /
 *   `submitStructureToCollabWire`（collab wire JSON）
 *   → sink / IPC → RS `ops_from_json` → `DocSession::apply`
 * - wire 形状对齐 `conex-doc-collab::Op`（snake_case、tag=`op`）
 * - 默认 UI 仍可 mock sink（W3-D-S）；真 apply 库侧见
 *   `w3_d_structure_intent_or_wire_applys_to_session`（Rust）
 *
 * ## 轨声明（诚实）
 *
 * - **W3-D-S 升级面 / W3-D 子集**：plain Intent → wire →（RS）真 apply
 * - **≠ W3-D-PM**（无真 ProseMirror）
 * - **≠ W3-D Strict 终局**（09：真 PM + 双 Intent 路径集成）；禁止 mock sink 冒充
 * - **W3-F ≠ EL-01 关闭**：不关闭 A-BLK 全表、不 serialize(DOM)
 */

import type {
  BlockId,
  CollabOpWire,
  IntentId,
  OpIntent,
  TextEditIntent,
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
import { nextIntentId } from '../leaves/TextLeafModel';

// ---------------------------------------------------------------------------
// 起源 / 种类
// ---------------------------------------------------------------------------

/**
 * Intent 产生来源（审计 / 宿主路由，非 RS 权威字段）。
 * - slash：slash 菜单确认
 * - chrome：把手 / 批量条 / 多选
 * - keyboard：结构键（Enter/Tab 等，宿主映射后）
 * - drag：拖拽落点
 * - batch：批量工具
 * - unknown：未标注
 */
export type StructureIntentOrigin =
  'slash' | 'chrome' | 'keyboard' | 'drag' | 'batch' | 'unknown';

/** 结构 Intent 的 type 判别字面量 */
export type StructureIntentType =
  | 'insert_block'
  | 'delete_blocks'
  | 'move_blocks'
  | 'toggle_collapse'
  | 'slash_insert';

const STRUCTURE_INTENT_TYPES: ReadonlySet<string> =
  new Set<StructureIntentType>([
    'insert_block',
    'delete_blocks',
    'move_blocks',
    'toggle_collapse',
    'slash_insert',
  ]);

// ---------------------------------------------------------------------------
// 结构 Intent 载荷
// ---------------------------------------------------------------------------

type StructureIntentBase = {
  intentId: IntentId;
  /** 产生来源 */
  origin: StructureIntentOrigin;
};

/** 在 parent 下插入一块（flavour 指定） */
export type InsertBlockIntent = StructureIntentBase & {
  type: 'insert_block';
  /** 父块；根级用 null */
  parentId: BlockId | null;
  /** 插入参考（同级 after）；可选 */
  afterBlockId?: BlockId | null;
  flavour: string;
  /** 可选预分配 id；缺省由 RS 分配 */
  blockIds?: BlockId[];
};

/** 批量删除 */
export type DeleteBlocksIntent = StructureIntentBase & {
  type: 'delete_blocks';
  blockIds: BlockId[];
};

/** 批量移动到 parent + index */
export type MoveBlocksIntent = StructureIntentBase & {
  type: 'move_blocks';
  blockIds: BlockId[];
  parentId: BlockId | null;
  /** 目标父下插入索引；缺省由宿主/RS 约定 */
  index?: number;
};

/** 折叠 / 展开（本地呈现优先；仍走 Intent 以便权威同步） */
export type ToggleCollapseIntent = StructureIntentBase & {
  type: 'toggle_collapse';
  blockIds: BlockId[];
  /**
   * 强制目标态；缺省表示「逐块 toggle」。
   * true = 折叠；false = 展开。
   */
  collapsed?: boolean;
};

/**
 * Slash 选中 catalog 项 → 在锚点处插入/转换块。
 * 语义上是 insert_block 的 slash 特化（带 anchor offset + catalogItemId）。
 */
export type SlashInsertIntent = StructureIntentBase & {
  type: 'slash_insert';
  /** 触发 slash 的锚点块 */
  blockId: BlockId;
  /** 块内 offset（触发 `/` 的位置） */
  offset: number;
  /** 目标 flavour（通常 = catalog item id 或映射后） */
  flavour: string;
  /** 目录项 id（与 SlashContribution.id 对齐） */
  catalogItemId: string;
  /** 可选父块；缺省由锚点推导 */
  parentId?: BlockId | null;
};

export type StructureIntent =
  | InsertBlockIntent
  | DeleteBlocksIntent
  | MoveBlocksIntent
  | ToggleCollapseIntent
  | SlashInsertIntent;

// ---------------------------------------------------------------------------
// PaperIntent 联合（文本 ∪ 结构 ∪ W0 op）
// ---------------------------------------------------------------------------

/** 文本 Intent（与 TextLeafModel 对齐的别名） */
export type TextIntent = TextEditIntent;

/**
 * 纸面可下发 sink 的 Intent 联合。
 * - `TextIntent` / W0 `op`：W3-D 已通
 * - `StructureIntent`：W3-F chrome / slash 接通
 *
 * 注意：UI 扩展 `request_slash` / `structure_key`（editor-kit GuardableIntent）
 * 仍不进 sink，须先映射为本联合成员。
 */
export type PaperIntent = TextIntent | StructureIntent | OpIntent;

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

/** 是否为纸面结构 Intent（非 W0 text_edit/op，非 UI 扩展） */
export function isStructureIntent(intent: unknown): intent is StructureIntent {
  if (intent == null || typeof intent !== 'object') return false;
  const t = (intent as { type?: unknown }).type;
  return typeof t === 'string' && STRUCTURE_INTENT_TYPES.has(t);
}

/** 是否为可进 mock/未来 RS sink 的 PaperIntent */
export function isPaperIntent(intent: unknown): intent is PaperIntent {
  if (intent == null || typeof intent !== 'object') return false;
  const t = (intent as { type?: unknown }).type;
  if (t === 'text_edit' || t === 'op') return true;
  return isStructureIntent(intent);
}

// ---------------------------------------------------------------------------
// 工厂（字段钉死，便于单测形状断言）
// ---------------------------------------------------------------------------

export type BuildIntentIdFn = () => IntentId;

function resolveIntentId(createIntentId?: BuildIntentIdFn): IntentId {
  return createIntentId ? createIntentId() : nextIntentId('struct');
}

function dedupeBlockIds(ids: readonly BlockId[]): BlockId[] {
  const seen = new Set<BlockId>();
  const out: BlockId[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export type BuildInsertBlockInput = {
  parentId: BlockId | null;
  flavour: string;
  afterBlockId?: BlockId | null;
  blockIds?: readonly BlockId[];
  origin?: StructureIntentOrigin;
  createIntentId?: BuildIntentIdFn;
};

export function buildInsertBlockIntent(
  input: BuildInsertBlockInput
): InsertBlockIntent {
  if (!input.flavour) {
    throw new Error('buildInsertBlockIntent：flavour 不可为空');
  }
  const intent: InsertBlockIntent = {
    type: 'insert_block',
    intentId: resolveIntentId(input.createIntentId),
    origin: input.origin ?? 'chrome',
    parentId: input.parentId,
    flavour: input.flavour,
  };
  if (input.afterBlockId !== undefined) {
    intent.afterBlockId = input.afterBlockId;
  }
  if (input.blockIds !== undefined) {
    intent.blockIds = dedupeBlockIds(input.blockIds);
  }
  return intent;
}

export type BuildDeleteBlocksInput = {
  blockIds: readonly BlockId[];
  origin?: StructureIntentOrigin;
  createIntentId?: BuildIntentIdFn;
};

export function buildDeleteBlocksIntent(
  input: BuildDeleteBlocksInput
): DeleteBlocksIntent {
  const blockIds = dedupeBlockIds(input.blockIds);
  if (blockIds.length === 0) {
    throw new Error('buildDeleteBlocksIntent：blockIds 不可为空');
  }
  return {
    type: 'delete_blocks',
    intentId: resolveIntentId(input.createIntentId),
    origin: input.origin ?? 'chrome',
    blockIds,
  };
}

export type BuildMoveBlocksInput = {
  blockIds: readonly BlockId[];
  parentId: BlockId | null;
  index?: number;
  origin?: StructureIntentOrigin;
  createIntentId?: BuildIntentIdFn;
};

export function buildMoveBlocksIntent(
  input: BuildMoveBlocksInput
): MoveBlocksIntent {
  const blockIds = dedupeBlockIds(input.blockIds);
  if (blockIds.length === 0) {
    throw new Error('buildMoveBlocksIntent：blockIds 不可为空');
  }
  const intent: MoveBlocksIntent = {
    type: 'move_blocks',
    intentId: resolveIntentId(input.createIntentId),
    origin: input.origin ?? 'drag',
    blockIds,
    parentId: input.parentId,
  };
  if (input.index !== undefined) {
    intent.index = input.index;
  }
  return intent;
}

export type BuildToggleCollapseInput = {
  blockIds: readonly BlockId[];
  collapsed?: boolean;
  origin?: StructureIntentOrigin;
  createIntentId?: BuildIntentIdFn;
};

export function buildToggleCollapseIntent(
  input: BuildToggleCollapseInput
): ToggleCollapseIntent {
  const blockIds = dedupeBlockIds(input.blockIds);
  if (blockIds.length === 0) {
    throw new Error('buildToggleCollapseIntent：blockIds 不可为空');
  }
  const intent: ToggleCollapseIntent = {
    type: 'toggle_collapse',
    intentId: resolveIntentId(input.createIntentId),
    origin: input.origin ?? 'chrome',
    blockIds,
  };
  if (input.collapsed !== undefined) {
    intent.collapsed = input.collapsed;
  }
  return intent;
}

export type BuildSlashInsertInput = {
  blockId: BlockId;
  offset: number;
  flavour: string;
  catalogItemId: string;
  parentId?: BlockId | null;
  origin?: StructureIntentOrigin;
  createIntentId?: BuildIntentIdFn;
};

export function buildSlashInsertIntent(
  input: BuildSlashInsertInput
): SlashInsertIntent {
  if (!input.blockId) {
    throw new Error('buildSlashInsertIntent：blockId 不可为空');
  }
  if (!input.catalogItemId) {
    throw new Error('buildSlashInsertIntent：catalogItemId 不可为空');
  }
  const flavour = input.flavour || input.catalogItemId;
  const offset =
    Number.isFinite(input.offset) && input.offset >= 0
      ? Math.floor(input.offset)
      : 0;
  const intent: SlashInsertIntent = {
    type: 'slash_insert',
    intentId: resolveIntentId(input.createIntentId),
    origin: input.origin ?? 'slash',
    blockId: input.blockId,
    offset,
    flavour,
    catalogItemId: input.catalogItemId,
  };
  if (input.parentId !== undefined) {
    intent.parentId = input.parentId;
  }
  return intent;
}

// ---------------------------------------------------------------------------
// → collab Op wire / W0 OpIntent 映射（Round9 · 可测桥）
//
// UI Intent **不得**直接写盘；须 wire → apply。
// mock sink 仍可直接收 StructureIntent；接 RS 时走本段映射。
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
 * ### 轨（W3-D-S 升级面 · plain Intent 真 apply 子集）
 * ```
 * PaperIntent
 *   → paperIntentToOps / structureIntentToOps
 *   → collabOpsToJson
 *   → [宿主 IPC]
 *   → RS ops_from_json → DocSession::apply → ProjectionDiff
 * ```
 *
 * - **≠ W3-D-PM**（无 PM）
 * - **≠** 用 mock sink 宣称 W3-D Strict 完成
 * - 默认 UI 仍可用 `createMockIntentSink`；接写锥时宿主应优先本函数 → IPC → apply
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
