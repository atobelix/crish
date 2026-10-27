/**
 * 结构 Intent 工厂 builders（SD-08 · structureIntents 三切 · builders）
 *
 * 字段钉死，便于单测形状断言。类型见 `structureIntentTypes`；
 * collab wire 映射见 `structureIntentToWire`。
 *
 * ## 写路径纪律（强制 · W3-D Strict / G-INV-3）
 *
 * - 本模块只构造 `StructureIntent`，**不得**直接写盘
 * - 须经 wire → `createCollabApplySink` / IPC → RS apply
 * - **≠ EL-01**；禁止 mock sink 冒充 Strict 关闭
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
// SD-05：中性 intentId；禁止 chrome→TextLeafModel 仅为 id
import { nextIntentId } from '../intentId';
import type {
  DeleteBlocksIntent,
  InsertBlockIntent,
  MoveBlocksIntent,
  SlashInsertIntent,
  StructureIntentOrigin,
  ToggleCollapseIntent,
} from './structureIntentTypes';

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
  collapsedByBlock?: Readonly<Record<BlockId, boolean>>;
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
  if (input.collapsed !== undefined && input.collapsedByBlock !== undefined) {
    throw new Error(
      'buildToggleCollapseIntent：collapsed 与 collapsedByBlock 不可同时提供'
    );
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
  if (input.collapsedByBlock !== undefined) {
    const collapsedByBlock: Partial<Record<BlockId, boolean>> = {};
    for (const id of blockIds) {
      if (
        !Object.prototype.hasOwnProperty.call(input.collapsedByBlock, id) ||
        typeof input.collapsedByBlock[id] !== 'boolean'
      ) {
        throw new Error(
          `buildToggleCollapseIntent：collapsedByBlock 缺少 ${id} 的布尔目标态`
        );
      }
      collapsedByBlock[id] = input.collapsedByBlock[id];
    }
    intent.collapsedByBlock = collapsedByBlock as Record<BlockId, boolean>;
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
