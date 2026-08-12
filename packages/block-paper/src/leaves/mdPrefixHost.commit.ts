/**
 * MD 前缀叶提交核（SD-46 · 快路径 → TurnIntoSink）。
 *
 * 公开入口仍为 `mdPrefixHost.ts`（barrel）。
 * 快路径与 submit **双重** composing 守卫；composing=true → 不进 sink。
 * **只**走注入的 `TurnIntoSink`；**禁止**第二写锥。
 * **≠ EL-01**；**≠ A-BLK-08/09 e2e**。
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
import {
  tryMdPrefixFastPath,
  submitTurnIntoIntent,
  type TurnIntoIntent,
  type TurnIntoSink,
  type MdPrefixFastPathResult,
  type SubmitTurnIntoResult,
  type MdPrefixFastPathRejectCode,
} from './turnInto';

// ---------------------------------------------------------------------------
// 叶快照 / 选项
// ---------------------------------------------------------------------------

/**
 * 叶输入快照（TextLeafModel / PmTextLeaf / 宿主自持均可投影为本形状）。
 * 不绑定具体 leaf 类，便于 note-paper / chrome 钩子复用。
 */
export type MdPrefixLeafSnapshot = {
  blockId: BlockId;
  /** 当前 plain 文本（含尚未剥离的 MD 前缀） */
  text: string;
  /**
   * 逻辑 caret；缺省 = text.length。
   * 严格模式须 = prefixLength（刚敲完前缀触发空格）。
   */
  caretOffset?: number;
  /**
   * IME composing。true 时 **拒绝**（A-BLK-09 / A-IME-02）。
   * 布尔或回调。
   */
  isComposing?: boolean | (() => boolean);
  /** 当前 flavour；与目标相同则 same_flavour 短路 */
  fromFlavour?: string;
};

export type MdPrefixCommitOptions = {
  /** 必填：可注入 TurnInto sink（mock / provisional collab） */
  sink: TurnIntoSink;
  /** 严格 / 宽松 caret（透传 tryMdPrefixFastPath） */
  loose?: boolean;
  createIntentId?: () => IntentId;
  /** 提交成功后可选钩子（审计 / React setState；不得旁路写盘） */
  onCommitted?: (intent: TurnIntoIntent) => void;
};

export type MdPrefixCommitOk = {
  ok: true;
  intent: TurnIntoIntent;
  match: NonNullable<Extract<MdPrefixFastPathResult, { ok: true }>['match']>;
  strippedText: string;
  /** submitTurnIntoIntent 成功结果 */
  submit: Extract<SubmitTurnIntoResult, { ok: true }>;
};

export type MdPrefixCommitFail =
  | {
      ok: false;
      stage: 'fast_path';
      code: MdPrefixFastPathRejectCode;
      reason: string;
      match?: Extract<MdPrefixFastPathResult, { ok: false }>['match'];
    }
  | {
      ok: false;
      stage: 'submit';
      code: 'composing' | 'sink_reject' | 'invalid_intent';
      reason: string;
      intent: TurnIntoIntent | null;
    };

export type MdPrefixCommitResult = MdPrefixCommitOk | MdPrefixCommitFail;

// ---------------------------------------------------------------------------
// 提交：叶快照 → turn_into → sink
// ---------------------------------------------------------------------------

/**
 * 产品路径核心：从叶快照尝试 MD 前缀快路径并提交可注入 sink。
 *
 * 宿主典型接线（非 composing 键入空格后）：
 * ```ts
 * const r = await commitMdPrefixFromLeaf(
 *   { blockId, text: leaf.getText(), caretOffset: 2, isComposing: () => leaf.isComposing(), fromFlavour: 'paragraph' },
 *   { sink: mock.sink }
 * );
 * ```
 *
 * ### composing 铁律
 * 快路径与 submit **双重**守卫；composing=true → 不进 sink。
 */
export async function commitMdPrefixFromLeaf(
  leaf: MdPrefixLeafSnapshot,
  options: MdPrefixCommitOptions
): Promise<MdPrefixCommitResult> {
  if (!options.sink) {
    return {
      ok: false,
      stage: 'fast_path',
      code: 'invalid_block',
      reason: 'commitMdPrefixFromLeaf：须注入 TurnIntoSink',
    };
  }

  const fastInput: Parameters<typeof tryMdPrefixFastPath>[0] = {
    blockId: leaf.blockId,
    text: leaf.text ?? '',
  };
  if (leaf.caretOffset !== undefined) {
    fastInput.caretOffset = leaf.caretOffset;
  }
  if (leaf.isComposing !== undefined) {
    fastInput.isComposing = leaf.isComposing;
  }
  if (leaf.fromFlavour !== undefined) {
    fastInput.fromFlavour = leaf.fromFlavour;
  }
  if (options.loose !== undefined) {
    fastInput.loose = options.loose;
  }
  if (options.createIntentId !== undefined) {
    fastInput.createIntentId = options.createIntentId;
  }

  const fast = tryMdPrefixFastPath(fastInput);
  if (!fast.ok) {
    if (fast.match !== undefined) {
      return {
        ok: false as const,
        stage: 'fast_path' as const,
        code: fast.code,
        reason: fast.reason,
        match: fast.match,
      };
    }
    return {
      ok: false as const,
      stage: 'fast_path' as const,
      code: fast.code,
      reason: fast.reason,
    };
  }

  // submit 再守卫 composing（A-BLK-09 双闸）
  const submitOpts: Parameters<typeof submitTurnIntoIntent>[2] = {};
  if (leaf.isComposing !== undefined) {
    submitOpts.isComposing = leaf.isComposing;
  }
  const submitted = await submitTurnIntoIntent(
    fast.intent,
    options.sink,
    submitOpts
  );
  if (!submitted.ok) {
    return {
      ok: false,
      stage: 'submit',
      code: submitted.code,
      reason: submitted.reason,
      intent: submitted.intent,
    };
  }

  options.onCommitted?.(submitted.intent);
  return {
    ok: true,
    intent: submitted.intent,
    match: fast.match,
    strippedText: fast.strippedText,
    submit: submitted,
  };
}

/**
 * 叶编辑后尝试 MD 前缀（宿主在 onIntent / applyLocalEdit 后调用）。
 * 与 `simulateMdPrefixSubmit` 同写锥，但不替宿主改叶缓冲。
 */
export async function tryMdPrefixAfterLeafEdit(
  leaf: {
    blockId: BlockId;
    getText(): string;
    isComposing(): boolean;
  },
  options: MdPrefixCommitOptions & {
    caretOffset?: number;
    fromFlavour?: string;
  }
): Promise<MdPrefixCommitResult> {
  const snap: MdPrefixLeafSnapshot = {
    blockId: leaf.blockId,
    text: leaf.getText(),
    isComposing: () => leaf.isComposing(),
  };
  if (options.caretOffset !== undefined) {
    snap.caretOffset = options.caretOffset;
  } else {
    snap.caretOffset = leaf.getText().length;
  }
  if (options.fromFlavour !== undefined) {
    snap.fromFlavour = options.fromFlavour;
  }
  return commitMdPrefixFromLeaf(snap, options);
}
