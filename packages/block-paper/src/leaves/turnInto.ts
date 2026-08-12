/**
 * turn-into Intent + MD 前缀快路径组装（W3-H · A-BLK-08/09 方向）。
 *
 * 对齐：
 * - A-BLK-08：paragraph↔heading/list/quote… **保逻辑选区**（本波交付字段 + 钳制纯函数；≠ e2e）
 * - A-BLK-09：MD 前缀快路径；**composing 禁止**
 * - editor-kit `StructureKeyKind = 'turn_into'`
 * - `plans/05`：turn-into UI 在呈现层；Op 语义归 01（心侧）；本模块只产 Intent 形状
 *
 * ## 写锥纪律
 * - **禁止** DOM / PM serialize 旁路写盘
 * - 宿主：`TurnIntoIntent` → `submitTurnIntoIntent` → sink → wire → `DocSession::apply`
 * - CONN-D：RS 已消费 `attrs.pending_turn_into_flavour`（`UpdateProps` apply 后**改 kind**），
 *   且有真 `Op::TurnInto` 子集；本模块 provisional 仍发 strip `text_edit` + pending 标记
 *   （wire 可进 apply；**≠** 桌面 PM 键入全链；**不得**冒充 A-BLK-08 e2e / EL-01 关闭）
 *
 * ## 轨
 * - **W3-H 方向子集**（本文件 + `mdPrefix.ts` + 单测）
 * - **≠** A-BLK 全表 e2e；**≠** EL-01；**≠** 与 slash Agent 抢 `structureIntents.ts`
 *
 * 优先新文件：不改 `chrome/structureIntents.ts`，避免与 W3-F slash 并行写撞车。
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
  matchMdPrefix,
  shouldTriggerMdPrefix,
  type MdPrefixMatch,
} from './mdPrefix';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** turn-into 触发源（审计） */
export type TurnIntoTrigger = 'md_prefix' | 'menu' | 'batch' | 'keyboard';

/**
 * 逻辑选区（A-BLK-08 方向）。
 * 坐标为块内 UTF-16 offset；转类型后宿主应 `clampLogicalSelection` 再投影。
 */
export type LogicalSelection = {
  blockId: BlockId;
  /** 锚点 offset（含） */
  anchor: number;
  /** 焦点 offset（可 < anchor；半开或闭由宿主统一，本波按点钳制） */
  head: number;
};

/**
 * turn-into 结构意图（纸面层；与 W3-F StructureIntent 并列，独立判别字）。
 *
 * 不并入 `structureIntents.ts` 闭包联合——W3-H 文件域优先 leaves，避免 slash 撞车。
 */
export type TurnIntoIntent = {
  type: 'turn_into';
  intentId: IntentId;
  /** 起源：与 StructureIntentOrigin 子集对齐 */
  origin: 'keyboard' | 'chrome' | 'batch' | 'slash' | 'unknown';
  /** 目标块（批量转类型可多 id；保序去重） */
  blockIds: BlockId[];
  /** 目标 flavour（heading-1 / bullet / quote / paragraph …） */
  flavour: string;
  /** 触发源 */
  trigger: TurnIntoTrigger;
  /**
   * 逻辑选区快照（转类型后保真用）。
   * MD 前缀路径：剥离前缀后 anchor/head 应减去 prefixLength（见 tryMdPrefixFastPath）。
   */
  logicalSelection?: LogicalSelection;
  /**
   * MD 前缀触发时：须从块首删除的半开区间 `[start, end)`。
   * 通常为 `[0, prefixLength)`。
   */
  stripRange?: [number, number];
  /** 匹配审计（仅 md_prefix） */
  mdPrefix?: {
    ruleId: string;
    matched: string;
  };
  /** 源 flavour（可选；批量条/菜单可填，便于同类型短路） */
  fromFlavour?: string;
};

export type BuildTurnIntoInput = {
  blockIds: readonly BlockId[];
  flavour: string;
  trigger?: TurnIntoTrigger;
  origin?: TurnIntoIntent['origin'];
  logicalSelection?: LogicalSelection;
  stripRange?: [number, number];
  mdPrefix?: TurnIntoIntent['mdPrefix'];
  fromFlavour?: string;
  createIntentId?: () => IntentId;
};

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

function resolveComposingFlag(
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

/** 类型守卫 */
export function isTurnIntoIntent(value: unknown): value is TurnIntoIntent {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Partial<TurnIntoIntent>;
  return (
    v.type === 'turn_into' &&
    typeof v.intentId === 'string' &&
    typeof v.flavour === 'string' &&
    Array.isArray(v.blockIds) &&
    v.blockIds.length > 0
  );
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
// MD 前缀快路径（A-BLK-09）
// ---------------------------------------------------------------------------

export type MdPrefixFastPathRejectCode =
  'composing' | 'no_match' | 'same_flavour' | 'invalid_block';

export type MdPrefixFastPathResult =
  | {
      ok: true;
      intent: TurnIntoIntent;
      match: MdPrefixMatch;
      /** 剥前缀后正文（宿主可先本地预览，权威仍走 Intent） */
      strippedText: string;
      /** 钳制后的逻辑选区（若输入带了 selection） */
      logicalSelection?: LogicalSelection;
    }
  | {
      ok: false;
      code: MdPrefixFastPathRejectCode;
      reason: string;
      match?: MdPrefixMatch;
    };

export type TryMdPrefixFastPathInput = {
  blockId: BlockId;
  /** 当前块 plain 文本（含尚未剥离的 MD 前缀） */
  text: string;
  /**
   * 光标 offset；缺省 = text.length。
   * 严格模式要求 caret === prefixLength（刚敲完前缀）。
   */
  caretOffset?: number;
  /**
   * IME composing 查询。为 true 时 **拒绝**（A-BLK-09 / A-IME-02）。
   * 布尔或回调。
   */
  isComposing?: boolean | (() => boolean);
  /** 当前块 flavour；与目标相同则 `same_flavour` 短路 */
  fromFlavour?: string;
  /** 当前逻辑选区；缺省用 caret 折叠选区 */
  logicalSelection?: LogicalSelection;
  /** 宽松触发（见 shouldTriggerMdPrefix） */
  loose?: boolean;
  createIntentId?: () => IntentId;
};

/**
 * MD 前缀快路径：匹配 → 组装 `TurnIntoIntent`（含 stripRange + 选区保真）。
 *
 * ### composing 铁律
 * `isComposing === true` → `{ ok: false, code: 'composing' }`，**不**产 Intent。
 *
 * ### 非完成
 * - ≠ A-BLK-09 全表 e2e
 * - ≠ 真 RS turn_into Op apply
 */
export function tryMdPrefixFastPath(
  input: TryMdPrefixFastPathInput
): MdPrefixFastPathResult {
  if (!input.blockId) {
    return {
      ok: false,
      code: 'invalid_block',
      reason: 'tryMdPrefixFastPath：blockId 不可为空',
    };
  }

  if (resolveComposingFlag(input.isComposing)) {
    return {
      ok: false,
      code: 'composing',
      reason:
        'IME composing：禁止 MD 前缀转块（A-BLK-09 / A-IME-02 / structure turn_into）',
    };
  }

  const text = input.text ?? '';
  const match = input.loose
    ? shouldTriggerMdPrefix(text, input.caretOffset, { loose: true })
    : shouldTriggerMdPrefix(text, input.caretOffset, { loose: false });

  // 无 caret 约束的纯匹配回退：loose 已覆盖；严格未命中再尝试「仅 match」不触发
  if (!match) {
    // 区分「完全无前缀」与「有前缀但 caret 未就位」
    const raw = matchMdPrefix(text);
    if (raw) {
      return {
        ok: false,
        code: 'no_match',
        reason: `MD 前缀已识别（${raw.ruleId}）但光标未处于触发位（caret 须 = ${raw.prefixLength}）；非 composing 可继续输入`,
        match: raw,
      };
    }
    return {
      ok: false,
      code: 'no_match',
      reason: '行首无 MD 前缀可触发快路径',
    };
  }

  if (input.fromFlavour && input.fromFlavour === match.flavour) {
    return {
      ok: false,
      code: 'same_flavour',
      reason: `已是 flavour=${match.flavour}，跳过 turn-into`,
      match,
    };
  }

  const strippedText = text.slice(match.prefixLength);
  const caret =
    input.caretOffset === undefined || !Number.isFinite(input.caretOffset)
      ? text.length
      : Math.max(0, Math.floor(input.caretOffset));

  const rawSel: LogicalSelection = input.logicalSelection ?? {
    blockId: input.blockId,
    anchor: caret,
    head: caret,
  };
  const logicalSelection = clampLogicalSelection(
    rawSel,
    strippedText.length,
    match.prefixLength
  );

  const buildInput: BuildTurnIntoInput = {
    blockIds: [input.blockId],
    flavour: match.flavour,
    trigger: 'md_prefix',
    origin: 'keyboard',
    stripRange: [0, match.prefixLength],
    logicalSelection,
    mdPrefix: { ruleId: match.ruleId, matched: match.matched },
  };
  // exactOptionalPropertyTypes：仅在有值时写入可选字段
  if (input.fromFlavour !== undefined) {
    buildInput.fromFlavour = input.fromFlavour;
  }
  if (input.createIntentId !== undefined) {
    buildInput.createIntentId = input.createIntentId;
  }
  const intent = buildTurnIntoIntent(buildInput);

  const result: Extract<MdPrefixFastPathResult, { ok: true }> = {
    ok: true,
    intent,
    match,
    strippedText,
    logicalSelection,
  };
  return result;
}

// ---------------------------------------------------------------------------
// 提交（composing 再守卫 + sink）
// ---------------------------------------------------------------------------

export type TurnIntoSinkResult = {
  ok: boolean;
  reason?: string;
};

export type TurnIntoSink = (
  intent: TurnIntoIntent
) => Promise<TurnIntoSinkResult>;

export type SubmitTurnIntoOptions = {
  isComposing?: boolean | (() => boolean);
};

export type SubmitTurnIntoResult =
  | { ok: true; intent: TurnIntoIntent }
  | {
      ok: false;
      code: 'composing' | 'sink_reject' | 'invalid_intent';
      reason: string;
      intent: TurnIntoIntent | null;
    };

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
