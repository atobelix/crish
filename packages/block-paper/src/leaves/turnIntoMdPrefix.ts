/**
 * MD 前缀快路径组装（SD-13-R · A-BLK-09 方向）
 *
 * 行首匹配纯函数仍在 `mdPrefix.ts`；本模块只做 composing 守卫 + 组装 `TurnIntoIntent`。
 * 公开入口仍为 `turnInto.ts` barrel。
 *
 * ### composing 铁律
 * `isComposing === true` → `{ ok: false, code: 'composing' }`，**不**产 Intent。
 *
 * ### 非完成
 * - ≠ A-BLK-09 全表 e2e
 * - ≠ 真 RS turn_into Op apply
 * - ≠ EL-01
 *
 * ## 写锥纪律
 * - **禁止** DOM / PM serialize 旁路写盘
 * - 产出 Intent 后仍走 `submitTurnIntoIntent` → sink → wire → `DocSession::apply`
 */

import { matchMdPrefix, shouldTriggerMdPrefix } from './mdPrefix';
import {
  buildTurnIntoIntent,
  clampLogicalSelection,
  resolveComposingFlag,
} from './turnIntoIntent';
import type {
  BuildTurnIntoInput,
  LogicalSelection,
  MdPrefixFastPathResult,
  TryMdPrefixFastPathInput,
} from './turnIntoTypes';

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
