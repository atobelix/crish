/**
 * Intent 下发桥（W3-D + W3-F）：Intent → sink →（可选）RS apply。
 *
 * - `submitIntent`：经 IME 结构守卫后调用 sink
 * - composing 时 **结构 Intent**（`op` / slash / structure_key / StructureIntent）拒绝
 * - `text_edit` 在 composing 期守卫放行，但 TextLeafModel 默认不在合成中产出
 * - W3-F：`StructureIntent`（insert/delete/move/collapse/slash_insert）可直接进 sink
 * - **默认 mock sink** 记录调用，不接真实后端（W3-D-S 合法）
 *
 * ## 轨声明（诚实 · W3-D 子集）
 *
 * - 真 apply 路径：**`submitStructureToCollabWire`**（structureIntents）→ wire JSON →
 *   RS `ops_from_json` → `DocSession::apply`（库侧测：`w3_d_structure_intent_or_wire_applys_to_session`）
 * - **禁止**仅以 mock sink 宣称 **W3-D Strict** 完成
 * - 真 PM 叶见 `leaves/pm`（**W3-D-PM**）；本桥无 PM 实现，只收 Intent
 * - plain / PM Intent + mock sink **≠** 09 终局 **W3-D**（须真 apply）
 *
 * 对齐：
 * - W0 Intent 形状（`@crish/block-paper-contract`）
 * - editor-kit `ImeMachine.tryAcceptIntent` / `structureKeyGuard`
 * - 纸面 `PaperIntent` / `submitStructureToCollabWire`（见 `chrome/structureIntents`）
 *
 * **W3-F ≠ EL-01 关闭**：通路绿 ≠ A-BLK 全表 / 静默产品验收关闭。
 */

import type { Intent } from '@crish/block-paper-contract';
import {
  guardStructureIntent,
  type GuardableIntent,
  type ImeMachine,
  type StructureGuardRejectCode,
} from '@crish/editor-kit';
import {
  isStructureIntent,
  type PaperIntent,
  type StructureIntent,
} from '../chrome/structureIntents';

// ---------------------------------------------------------------------------
// Sink 契约
// ---------------------------------------------------------------------------

/** sink 返回：ok=false 表示 apply 拒绝（可映射 DocEvent.reject） */
export type IntentSinkResult = {
  ok: boolean;
  reason?: string;
};

/**
 * Intent 接收端（mock 或未来 RS IPC 适配）。
 * 接受 `PaperIntent`：W0 text_edit/op + W3-F StructureIntent。
 */
export type IntentSink = (intent: PaperIntent) => Promise<IntentSinkResult>;

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export type SubmitIntentOptions = {
  /**
   * ImeMachine：优先用其 `tryAcceptIntent`（与 pin/合成态一致）。
   * 注意：StructureIntent 不在 editor-kit GuardableIntent 内，composing 时本地拒绝。
   */
  ime?: ImeMachine;
  /**
   * 无 ime 时的 composing 查询；boolean 或回调。
   */
  isComposing?: boolean | (() => boolean);
};

export type SubmitIntentRejectCode =
  StructureGuardRejectCode | 'not_w0_intent' | 'sink_reject';

/** submit 入参：W0/UI 守卫联合 ∪ 纸面结构 Intent */
export type SubmittableIntent = GuardableIntent | StructureIntent;

export type SubmitIntentResult =
  | { ok: true; intent: PaperIntent }
  | {
      ok: false;
      reason: string;
      code: SubmitIntentRejectCode;
      intent: SubmittableIntent;
    };

function resolveComposing(options: SubmitIntentOptions): boolean {
  if (options.ime) {
    return options.ime.isComposing();
  }
  const c = options.isComposing;
  if (typeof c === 'function') return Boolean(c());
  return Boolean(c);
}

function isW0Intent(intent: GuardableIntent): intent is Intent {
  return intent.type === 'text_edit' || intent.type === 'op';
}

/**
 * 提交意图：IME 守卫 → sink。
 *
 * @param intent W0 Intent、UI 扩展（slash / structure_key）或 W3-F StructureIntent
 * @param sink 异步接收端（PaperIntent）
 * @param options ime / isComposing
 */
export async function submitIntent(
  intent: SubmittableIntent,
  sink: IntentSink,
  options: SubmitIntentOptions = {}
): Promise<SubmitIntentResult> {
  // ── W3-F 结构 Intent：composing 禁；通过后直接进 sink ──
  if (isStructureIntent(intent)) {
    const composing = resolveComposing(options);
    if (composing) {
      return {
        ok: false,
        reason: 'IME composing：禁止结构 Op 意图（A-IME-02）',
        code: 'composing_structure_op',
        intent,
      };
    }
    const sinkResult = await sink(intent);
    if (!sinkResult.ok) {
      return {
        ok: false,
        reason: sinkResult.reason ?? 'sink rejected',
        code: 'sink_reject',
        intent,
      };
    }
    return { ok: true, intent };
  }

  // ── W3-D：GuardableIntent（W0 + request_slash / structure_key）──
  // 1) 结构守卫（composing 禁结构）
  if (options.ime) {
    const g = options.ime.tryAcceptIntent(intent);
    if (!g.ok) {
      return {
        ok: false,
        reason: g.reason,
        code: g.code,
        intent: g.intent,
      };
    }
  } else {
    const composing = resolveComposing(options);
    const g = guardStructureIntent(composing, intent);
    if (!g.ok) {
      return {
        ok: false,
        reason: g.reason,
        code: g.code,
        intent: g.intent,
      };
    }
  }

  // 2) 仅 W0 Intent 可下发 sink（UI 扩展由宿主另行映射为 StructureIntent / op）
  if (!isW0Intent(intent)) {
    return {
      ok: false,
      reason: `intentBridge：${intent.type} 非 W0/Structure Intent，不可下发 sink（须先映射为 text_edit/op/StructureIntent）`,
      code: 'not_w0_intent',
      intent,
    };
  }

  // 3) sink（mock apply）
  const sinkResult = await sink(intent);
  if (!sinkResult.ok) {
    return {
      ok: false,
      reason: sinkResult.reason ?? 'sink rejected',
      code: 'sink_reject',
      intent,
    };
  }

  return { ok: true, intent };
}

// ---------------------------------------------------------------------------
// Mock sink
// ---------------------------------------------------------------------------

/** 可审计的 mock sink */
export type MockIntentSink = {
  /** 供 submitIntent 使用的 sink 函数 */
  sink: IntentSink;
  /** 按调用顺序记录的 Intent（含 StructureIntent） */
  calls: PaperIntent[];
  /** 每次调用时返回的结果快照 */
  results: IntentSinkResult[];
  /** 设置下一次（及之后）sink 返回值 */
  setResult: (result: IntentSinkResult) => void;
  /** 清空调用记录（不改默认 result） */
  clear: () => void;
};

/**
 * 创建默认 mock sink：记录全部调用，默认 `{ ok: true }`。
 */
export function createMockIntentSink(
  initialResult: IntentSinkResult = { ok: true }
): MockIntentSink {
  const calls: PaperIntent[] = [];
  const results: IntentSinkResult[] = [];
  let current: IntentSinkResult = { ...initialResult };

  const sink: IntentSink = async (intent) => {
    calls.push(intent);
    // exactOptionalPropertyTypes：仅拷贝已定义字段
    const r: IntentSinkResult = { ok: current.ok };
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
    setResult(result: IntentSinkResult) {
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
