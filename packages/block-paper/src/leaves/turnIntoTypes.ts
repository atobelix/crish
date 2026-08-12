/**
 * turn-into 类型与守卫（SD-13-R · turnInto 切开 · types）
 *
 * 工厂 / 钳制 / 提交 / provisional wire 见 `turnIntoIntent`；
 * MD 前缀快路径见 `turnIntoMdPrefix`。公开入口仍为 `turnInto.ts` barrel。
 *
 * ## 写锥纪律
 * - 本模块只声明 Intent 形状与守卫，**不得**写盘
 * - **禁止** DOM / PM serialize 旁路
 * - **≠ EL-01**；**≠ A-BLK-08/09 e2e**；provisional pending 语义不在此改
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
import type { MdPrefixMatch } from './mdPrefix';

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
