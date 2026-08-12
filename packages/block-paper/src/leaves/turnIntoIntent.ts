/**
 * turn-into 工厂 / 选区钳制 / 提交 / provisional wire（SD-13-R）
 *
 * 类型见 `turnIntoTypes`；MD 前缀快路径见 `turnIntoMdPrefix`。
 *
 * ## 写锥纪律
 * - **禁止** DOM / PM serialize 旁路写盘
 * - 宿主：`TurnIntoIntent` → `submitTurnIntoIntent` → sink → wire → `DocSession::apply`
 * - CONN-D：RS 已消费 `attrs.pending_turn_into_flavour`（`UpdateProps` apply 后**改 kind**），
 *   且有真 `Op::TurnInto` 子集；本模块 provisional 仍发 strip `text_edit` + pending 标记
 *   （wire 可进 apply；**≠** 桌面 PM 键入全链；**不得**冒充 A-BLK-08 e2e / EL-01 关闭）
 * - **≠ EL-01**；**≠ A-BLK-08/09 全表 e2e**
 */

import type {
  BlockId,
  CollabOpWire,
  IntentId,
  TextEditIntent,
} from '@crish/block-paper-contract';
import { collabPropsWithAttrs } from '@crish/block-paper-contract';
import { nextIntentId } from '../intentId';
import {
  isTurnIntoIntent,
  type BuildTurnIntoInput,
  type LogicalSelection,
  type SubmitTurnIntoOptions,
  type SubmitTurnIntoResult,
  type TurnIntoIntent,
  type TurnIntoSink,
} from './turnIntoTypes';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

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

/** IME composing 查询（布尔或回调）。分模共享，不进 barrel 公开面。 */
export function resolveComposingFlag(
  isComposing?: boolean | (() => boolean)
): boolean {
  if (typeof isComposing === 'function') return Boolean(isComposing());
  return Boolean(isComposing);
}

function clampOffset(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 构造 `TurnIntoIntent`（字段钉死，便于单测形状断言）。
 *
 * @throws flavour 空 / blockIds 空
 */
export function buildTurnIntoIntent(input: BuildTurnIntoInput): TurnIntoIntent {
  if (!input.flavour || !String(input.flavour).trim()) {
    throw new Error('buildTurnIntoIntent：flavour 不可为空');
  }
  const blockIds = dedupeBlockIds(input.blockIds);
  if (blockIds.length === 0) {
    throw new Error('buildTurnIntoIntent：blockIds 不可为空');
  }

  const trigger = input.trigger ?? 'menu';
  const origin =
    input.origin ??
    (trigger === 'md_prefix' || trigger === 'keyboard'
      ? 'keyboard'
      : trigger === 'batch'
        ? 'batch'
        : 'chrome');

  const intent: TurnIntoIntent = {
    type: 'turn_into',
    intentId: input.createIntentId
      ? input.createIntentId()
      : nextIntentId('turn'),
    origin,
    blockIds,
    flavour: String(input.flavour).trim(),
    trigger,
  };

  if (input.logicalSelection) {
    intent.logicalSelection = { ...input.logicalSelection };
  }
  if (input.stripRange) {
    intent.stripRange = [input.stripRange[0], input.stripRange[1]];
  }
  if (input.mdPrefix) {
    intent.mdPrefix = { ...input.mdPrefix };
  }
  if (input.fromFlavour !== undefined) {
    intent.fromFlavour = input.fromFlavour;
  }
  return intent;
}

// ---------------------------------------------------------------------------
// A-BLK-08 方向：逻辑选区钳制
// ---------------------------------------------------------------------------

/**
 * 转类型 / 剥前缀后，将逻辑选区钳到新文本长度。
 *
 * - 若提供 `stripPrefixLength`：anchor/head 先减此前缀长，再钳制到 `[0, newTextLength]`
 * - **不**丢 blockId；选区仍锚定同一块（保逻辑选区方向）
 */
export function clampLogicalSelection(
  sel: LogicalSelection,
  newTextLength: number,
  stripPrefixLength = 0
): LogicalSelection {
  const len = Math.max(0, Math.floor(newTextLength));
  const strip = Math.max(0, Math.floor(stripPrefixLength));
  const shift = (off: number) => clampOffset(off - strip, 0, len);
  return {
    blockId: sel.blockId,
    anchor: shift(sel.anchor),
    head: shift(sel.head),
  };
}

// ---------------------------------------------------------------------------
// 提交（composing 再守卫 + sink）
// ---------------------------------------------------------------------------

/**
 * 提交 turn-into：composing 拒绝 → sink。
 *
 * 与 `submitIntent` 并行的窄桥；不修改 intentBridge 闭包联合（防 slash 撞车）。
 * 宿主亦可先 `turnIntoToStructureKey` 走 editor-kit 守卫，再调本函数。
 */
export async function submitTurnIntoIntent(
  intent: TurnIntoIntent,
  sink: TurnIntoSink,
  options: SubmitTurnIntoOptions = {}
): Promise<SubmitTurnIntoResult> {
  if (!isTurnIntoIntent(intent)) {
    return {
      ok: false,
      code: 'invalid_intent',
      reason: 'submitTurnIntoIntent：非 turn_into Intent',
      intent: null,
    };
  }
  if (resolveComposingFlag(options.isComposing)) {
    return {
      ok: false,
      code: 'composing',
      reason:
        'IME composing：禁止 turn-into / MD 前缀结构变换（A-BLK-08/09 / A-IME-02）',
      intent,
    };
  }
  const sinkResult = await sink(intent);
  if (!sinkResult.ok) {
    return {
      ok: false,
      code: 'sink_reject',
      reason: sinkResult.reason ?? 'sink rejected',
      intent,
    };
  }
  return { ok: true, intent };
}

/**
 * 映射为 editor-kit `structure_key`（kind=turn_into），供既有 IME 守卫复用。
 * **不**进 W0 sink；仅作 GuardableIntent 形状。
 */
export function turnIntoToStructureKey(intent: TurnIntoIntent): {
  type: 'structure_key';
  kind: 'turn_into';
  blockId: BlockId;
  intentId: IntentId;
} {
  return {
    type: 'structure_key',
    kind: 'turn_into',
    blockId: intent.blockIds[0]!,
    intentId: intent.intentId,
  };
}

// ---------------------------------------------------------------------------
// 临时 wire（诚实占位 · 非 A-BLK-08 关闭证据）
// ---------------------------------------------------------------------------

/**
 * 将 turn-into 映射为 collab wire 列表（provisional 形状，可进 RS apply）：
 * 1. 若有 `stripRange` → `text_edit` 剥前缀
 * 2. `update_props` 写入 `attrs.pending_turn_into_flavour`
 *
 * CONN-D：RS `DocSession::apply` **消费**该标记并改权威 `kind`（亦支持真
 * `op:"turn_into"`）。UI **须**以投影 `kind` 为准，**禁止**仅读 pending attrs 当 flavour。
 *
 * **禁止**用本函数绿测宣称 A-BLK-08 / EL-01 关闭；**≠** 桌面键入 e2e。
 */
export function turnIntoIntentToProvisionalOps(
  intent: TurnIntoIntent
): CollabOpWire[] {
  if (!isTurnIntoIntent(intent)) {
    throw new Error('turnIntoIntentToProvisionalOps：非 turn_into Intent');
  }
  const ops: CollabOpWire[] = [];
  const primaryId = intent.blockIds[0]!;

  if (intent.stripRange) {
    const [start, end] = intent.stripRange;
    const s = Math.max(0, Math.floor(start));
    const e = Math.max(s, Math.floor(end));
    ops.push({
      op: 'text_edit',
      id: primaryId,
      start: s,
      end: e,
      insert: '',
    });
  }

  for (const id of intent.blockIds) {
    ops.push({
      op: 'update_props',
      id,
      props: collabPropsWithAttrs({
        pending_turn_into_flavour: intent.flavour,
        turn_into_trigger: intent.trigger,
      }),
    });
  }
  return ops;
}

/**
 * 由 stripRange 派生的配套 `TextEditIntent`（可选与 turn_into 同批下发）。
 * 仅 MD 前缀路径有意义。
 */
export function turnIntoStripToTextEdit(
  intent: TurnIntoIntent,
  createIntentId?: () => IntentId
): TextEditIntent | null {
  if (!intent.stripRange || intent.blockIds.length === 0) return null;
  const [start, end] = intent.stripRange;
  return {
    type: 'text_edit',
    intentId: createIntentId ? createIntentId() : nextIntentId('strip'),
    blockId: intent.blockIds[0]!,
    range: [start, end],
    insert: '',
  };
}
