/**
 * structureKeyGuard：composing 时过滤结构 Intent / slash。
 *
 * 对齐：
 * - A-IME-02：合成中不触发 slash / 结构键 / 块变换 / Enter 拆块
 * - W0 Intent：`text_edit` | `op`；UI 侧扩展 `request_slash` / `structure_key`
 * - round-D D5 §6.2：Composing 禁止结构键、slash、markdown 块变换
 *
 * 本模块为 **纯过滤**（stub 可测）；不接线真实 keymap / PM dispatch。
 */

import type { BlockId, Intent, IntentId } from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 可守卫意图（W0 Intent + UI 结构扩展）
// ---------------------------------------------------------------------------

/** 结构键 / 块变换种类（A-IME-02 覆盖面） */
export type StructureKeyKind =
  | 'split_block' // Enter 拆块
  | 'merge_block' // 行首 Backspace 并块
  | 'indent' // Tab
  | 'outdent' // Shift+Tab
  | 'turn_into' // MD 前缀 / 转类型
  | 'move_block' // 拖放 / 上下移
  | 'delete_block'
  | 'insert_block'
  | 'structure_op'; // 泛化结构 op

/**
 * UI 层可被 IME 守卫的意图联合。
 * - 直接复用 W0 `Intent`（text_edit / op）
 * - `request_slash`：slash 面板打开请求（`/` / `、`）
 * - `structure_key`：结构键语义（尚未落为 W0 op 前）
 */
export type GuardableIntent =
  | Intent
  | {
      type: 'request_slash';
      blockId: BlockId;
      offset: number;
      intentId?: IntentId;
    }
  | {
      type: 'structure_key';
      kind: StructureKeyKind;
      blockId?: BlockId;
      intentId?: IntentId;
    };

/** 守卫拒绝原因码 */
export type StructureGuardRejectCode =
  'composing_structure_key' | 'composing_slash' | 'composing_structure_op';

export type StructureGuardResult =
  | { ok: true; intent: GuardableIntent }
  | {
      ok: false;
      code: StructureGuardRejectCode;
      reason: string;
      intent: GuardableIntent;
    };

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

/**
 * 是否为结构类 / slash 意图（composing 时必须拒绝）。
 *
 * - `request_slash` / `structure_key` → 是
 * - W0 `op` → 视为结构/批量 op（composing 中禁止）
 * - W0 `text_edit` → 否（合成文本走独立缓冲；真正 commit 由 ImeMachine end 后处理）
 */
export function isStructureOrSlashIntent(intent: GuardableIntent): boolean {
  switch (intent.type) {
    case 'request_slash':
    case 'structure_key':
    case 'op':
      return true;
    case 'text_edit':
      return false;
    default: {
      // 穷尽检查：未来扩展默认保守视为结构
      const _exhaustive: never = intent;
      void _exhaustive;
      return true;
    }
  }
}

function rejectCodeFor(intent: GuardableIntent): StructureGuardRejectCode {
  switch (intent.type) {
    case 'request_slash':
      return 'composing_slash';
    case 'structure_key':
      return 'composing_structure_key';
    case 'op':
      return 'composing_structure_op';
    default:
      return 'composing_structure_key';
  }
}

function rejectReason(code: StructureGuardRejectCode): string {
  switch (code) {
    case 'composing_slash':
      return 'IME composing：禁止打开 slash 面板（A-IME-02）';
    case 'composing_structure_key':
      return 'IME composing：禁止结构键意图（A-IME-02）';
    case 'composing_structure_op':
      return 'IME composing：禁止结构 Op 意图（A-IME-02）';
  }
}

// ---------------------------------------------------------------------------
// 守卫 API
// ---------------------------------------------------------------------------

/**
 * 单条意图守卫。
 *
 * @param composing 当前是否处于 composition
 * @param intent 待放行意图
 */
export function guardStructureIntent(
  composing: boolean,
  intent: GuardableIntent
): StructureGuardResult {
  if (!composing) {
    return { ok: true, intent };
  }
  if (!isStructureOrSlashIntent(intent)) {
    return { ok: true, intent };
  }
  const code = rejectCodeFor(intent);
  return {
    ok: false,
    code,
    reason: rejectReason(code),
    intent,
  };
}

/**
 * 批量过滤：composing 时剔除结构/slash；Idle 时原样放行。
 *
 * @returns allowed 可继续下发；rejected 被拒项（含原因）
 */
export function filterStructureIntents(
  composing: boolean,
  intents: readonly GuardableIntent[]
): {
  allowed: GuardableIntent[];
  rejected: Array<Extract<StructureGuardResult, { ok: false }>>;
} {
  const allowed: GuardableIntent[] = [];
  const rejected: Array<Extract<StructureGuardResult, { ok: false }>> = [];
  for (const intent of intents) {
    const r = guardStructureIntent(composing, intent);
    if (r.ok) {
      allowed.push(r.intent);
    } else {
      rejected.push(r);
    }
  }
  return { allowed, rejected };
}
