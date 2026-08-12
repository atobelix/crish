/**
 * MD 前缀产品输入接线（W3-H · 可测路径）。
 *
 * 把库内纯函数 `tryMdPrefixFastPath` / `submitTurnIntoIntent` 接到叶输入的
 * 「行首 MD 前缀 + 提交」路径——模拟 / 宿主在键入 `# ` / `- ` 后调用本模块。
 *
 * ## 与 slash 通道关系
 * - **独立通道**：本 host 只走 `TurnIntoSink`，**不**改 `structureIntents` /
 *   `SlashMenuModel` / `SlashMenuOverlay` / `submitIntent` 闭包
 * - slash_insert 仍走 `IntentSink`；二者可同会话审计并列，**不互抹**
 *
 * ## 诚实边界（钉未做）
 * - RS **尚无**独立 `turn_into` collab Op（`UpdateProps` 不改 kind）
 * - `createTurnIntoProvisionalCollabSink` 仅下发**前缀剥离** `text_edit` +
 *   `attrs.pending_turn_into_flavour` 标记（见 `turnIntoIntentToProvisionalOps`）
 * - **≠ EL-01**；**≠ A-BLK-08/09 全表 e2e**；**≠** 假关 W3-H Strict 产品 e2e
 *
 * ## 轨
 * - 文件域：`leaves/mdPrefixHost.ts`（优先新文件，避 slash 大文件对撞）
 * - 可注入 sink：mock 形状测 或 provisional collab adapter
 */

import type { BlockId, IntentId } from '@crish/block-paper-contract';
import { collabOpsToJson } from '@crish/block-paper-contract';
import type {
  ApplyOpsAdapter,
  IntentSink,
  IntentSinkResult,
} from './intentBridge';
import type { PaperIntent } from '../chrome/structureIntents';
import { TextLeafModel } from './TextLeafModel';
import {
  tryMdPrefixFastPath,
  submitTurnIntoIntent,
  turnIntoIntentToProvisionalOps,
  isTurnIntoIntent,
  type TurnIntoIntent,
  type TurnIntoSink,
  type TurnIntoSinkResult,
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

// ---------------------------------------------------------------------------
// 模拟「行首输入 MD 前缀 + 提交」（产品形状可测）
// ---------------------------------------------------------------------------

export type SimulateMdPrefixSubmitInput = {
  blockId: BlockId;
  /**
   * 行首要键入的前缀全文（如 `'# '` / `'- '` / `'> '`）。
   * 内部经 TextLeafModel.applyLocalEdit 写入，再 commit。
   */
  prefixText: string;
  /** 键入前已有正文；缺省空（纯行首） */
  initialText?: string;
  fromFlavour?: string;
  /**
   * 若 true：叶进入 composing 后再写入前缀，期望被拒。
   * 用于产品路径 composing 回归。
   */
  composing?: boolean;
  /** 透传 createIntentId */
  createIntentId?: () => IntentId;
  loose?: boolean;
};

export type SimulateMdPrefixSubmitResult = {
  /** 叶在 commit 前的 plain 文本 */
  leafText: string;
  /** 非 composing 时 applyLocalEdit 产出的 text_edit；composing 期为 null */
  textEditIntentId: string | null;
  /** 叶 composing 快照（commit 时） */
  wasComposing: boolean;
  commit: MdPrefixCommitResult;
};

/**
 * 模拟「行首输入 MD 前缀 + 提交」完整产品形状：
 * 1. TextLeafModel 写入 prefix
 * 2. `commitMdPrefixFromLeaf` → TurnIntoIntent → 可注入 sink
 *
 * **不**碰 DOM / PM View；供 vitest 与宿主无 UI 回放。
 * RS 真 turn_into Op **仍未做**——sink 侧仅 Intent / provisional wire。
 */
export async function simulateMdPrefixSubmit(
  input: SimulateMdPrefixSubmitInput,
  sink: TurnIntoSink,
  hostOptions: Omit<MdPrefixCommitOptions, 'sink'> = {}
): Promise<SimulateMdPrefixSubmitResult> {
  const leaf = new TextLeafModel(
    input.blockId,
    input.initialText ?? '',
    input.createIntentId ? { createIntentId: input.createIntentId } : undefined
  );

  if (input.composing) {
    leaf.beginComposition(leaf.getText().length);
  }

  const prefix = input.prefixText ?? '';
  const start = leaf.getText().length;
  const textEdit = leaf.applyLocalEdit(start, start, prefix);

  const snapshot: MdPrefixLeafSnapshot = {
    blockId: leaf.blockId,
    text: leaf.getText(),
    caretOffset: leaf.getText().length,
    isComposing: () => leaf.isComposing(),
  };
  if (input.fromFlavour !== undefined) {
    snapshot.fromFlavour = input.fromFlavour;
  }

  const commitOpts: MdPrefixCommitOptions = {
    sink,
  };
  if (hostOptions.loose !== undefined) {
    commitOpts.loose = hostOptions.loose;
  } else if (input.loose !== undefined) {
    commitOpts.loose = input.loose;
  }
  if (hostOptions.createIntentId !== undefined) {
    commitOpts.createIntentId = hostOptions.createIntentId;
  } else if (input.createIntentId !== undefined) {
    commitOpts.createIntentId = input.createIntentId;
  }
  if (hostOptions.onCommitted !== undefined) {
    commitOpts.onCommitted = hostOptions.onCommitted;
  }

  const commit = await commitMdPrefixFromLeaf(snapshot, commitOpts);

  return {
    leafText: leaf.getText(),
    textEditIntentId: textEdit?.intentId ?? null,
    wasComposing: leaf.isComposing(),
    commit,
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

// ---------------------------------------------------------------------------
// 可注入 sink 工厂
// ---------------------------------------------------------------------------

/** mock TurnInto sink（仅形状 / 产品路径测；≠ 真 RS turn_into） */
export type MockTurnIntoSink = {
  sink: TurnIntoSink;
  calls: TurnIntoIntent[];
  results: TurnIntoSinkResult[];
  setResult: (result: TurnIntoSinkResult) => void;
  clear: () => void;
};

/**
 * 创建 mock TurnInto sink：记录 Intent，默认 `{ ok: true }`。
 *
 * **禁止**以 `calls.length` 宣称 A-BLK-08/09 e2e 或 RS turn_into 关闭。
 */
export function createMockTurnIntoSink(
  initialResult: TurnIntoSinkResult = { ok: true }
): MockTurnIntoSink {
  const calls: TurnIntoIntent[] = [];
  const results: TurnIntoSinkResult[] = [];
  let current: TurnIntoSinkResult = { ...initialResult };

  const sink: TurnIntoSink = async (intent) => {
    calls.push(intent);
    const r: TurnIntoSinkResult = { ok: current.ok };
    if (current.reason !== undefined) {
      r.reason = current.reason;
    }
    results.push(r);
    return r;
  };

  return {
    sink,
    calls,
    results,
    setResult(result: TurnIntoSinkResult) {
      current = { ok: result.ok };
      if (result.reason !== undefined) {
        current.reason = result.reason;
      } else {
        delete current.reason;
      }
    },
    clear() {
      calls.length = 0;
      results.length = 0;
    },
  };
}

/**
 * provisional collab sink：TurnIntoIntent → provisional ops JSON → applyOps。
 *
 * ## 诚实
 * - **不是** RS 真 `turn_into` Op（心侧尚无独立 kind 变更 Op）
 * - wire = 剥前缀 `text_edit` + `update_props.pending_turn_into_flavour`
 * - 仅作可注入 collab 形状通路；**≠** A-BLK-08 关闭证据
 */
export type TurnIntoProvisionalCollabSink = {
  sink: TurnIntoSink;
  /** 按调用顺序的 ops JSON（审计） */
  wireCalls: string[];
  results: TurnIntoSinkResult[];
  clear: () => void;
};

export function createTurnIntoProvisionalCollabSink(
  applyOps: ApplyOpsAdapter
): TurnIntoProvisionalCollabSink {
  if (typeof applyOps !== 'function') {
    throw new Error(
      'createTurnIntoProvisionalCollabSink：须注入 applyOps；RS 真 turn_into Op 仍未做，本 sink 仅 provisional wire'
    );
  }

  const wireCalls: string[] = [];
  const results: TurnIntoSinkResult[] = [];

  const sink: TurnIntoSink = async (intent) => {
    if (!isTurnIntoIntent(intent)) {
      const r: TurnIntoSinkResult = {
        ok: false,
        reason: 'createTurnIntoProvisionalCollabSink：非 turn_into Intent',
      };
      results.push(r);
      return r;
    }

    // 诚实：provisional 而非真 turn_into Op
    const ops = turnIntoIntentToProvisionalOps(intent);
    const json = collabOpsToJson(ops);
    wireCalls.push(json);

    try {
      const applied = await applyOps(json, { intentId: intent.intentId });
      const r: TurnIntoSinkResult = { ok: applied.ok };
      if (applied.reason !== undefined) {
        r.reason = applied.reason;
      }
      results.push(r);
      return r;
    } catch (e) {
      const reason =
        e instanceof Error
          ? e.message
          : `createTurnIntoProvisionalCollabSink：applyOps 抛错：${String(e)}`;
      const r: TurnIntoSinkResult = { ok: false, reason };
      results.push(r);
      return r;
    }
  };

  return {
    sink,
    wireCalls,
    results,
    clear() {
      wireCalls.length = 0;
      results.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 双通道审计（slash_insert ∥ turn_into 不互抹）
// ---------------------------------------------------------------------------

/**
 * 产品会话审计条目：paper（含 slash_insert）与 turn_into **分通道**。
 * 证明两路径可同会话共存、互不覆盖。
 */
export type ProductIntentAuditEntry =
  | { channel: 'paper'; intent: PaperIntent }
  | { channel: 'turn_into'; intent: TurnIntoIntent };

export type ProductIntentAuditSinks = {
  /** 与 SlashMenuOverlay / selectSlash*AndSubmit 共用的 IntentSink */
  paperSink: IntentSink;
  /** MD 前缀 / turn-into 专用 */
  turnIntoSink: TurnIntoSink;
  /** 保序审计（paper 与 turn_into 交错追加，互不 clear） */
  audit: ProductIntentAuditEntry[];
  clear: () => void;
};

/**
 * 创建 slash + turn_into 双通道可注入 sink。
 *
 * - `paperSink` 接 `submitIntent` / slash 浮层
 * - `turnIntoSink` 接 `commitMdPrefixFromLeaf`
 * - `audit` 保序记录两侧 Intent，**clear 一侧不会抹掉另一侧**（分通道数组语义：
 *   本实现用统一 audit 追加；clear 仅显式调用时清空——宿主不得在 slash 成功后
 *   误清 turn_into）
 */
export function createProductIntentAuditSinks(
  paperResult: IntentSinkResult = { ok: true },
  turnIntoResult: TurnIntoSinkResult = { ok: true }
): ProductIntentAuditSinks {
  const audit: ProductIntentAuditEntry[] = [];
  const paperCurrent: IntentSinkResult = { ...paperResult };
  const turnCurrent: TurnIntoSinkResult = { ...turnIntoResult };

  const paperSink: IntentSink = async (intent) => {
    audit.push({ channel: 'paper', intent });
    const r: IntentSinkResult = { ok: paperCurrent.ok };
    if (paperCurrent.reason !== undefined) {
      r.reason = paperCurrent.reason;
    }
    return r;
  };

  const turnIntoSink: TurnIntoSink = async (intent) => {
    audit.push({ channel: 'turn_into', intent });
    const r: TurnIntoSinkResult = { ok: turnCurrent.ok };
    if (turnCurrent.reason !== undefined) {
      r.reason = turnCurrent.reason;
    }
    return r;
  };

  return {
    paperSink,
    turnIntoSink,
    audit,
    clear() {
      audit.length = 0;
    },
  };
}
