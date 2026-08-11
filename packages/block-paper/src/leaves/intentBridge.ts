/**
 * Intent 下发桥（W3-D 骨架）：Intent → sink →（未来）RS apply。
 *
 * - `submitIntent`：经 IME 结构守卫后调用 sink
 * - composing 时 **结构 Intent**（`op` / slash / structure_key）拒绝
 * - `text_edit` 在 composing 期守卫放行，但 TextLeafModel 默认不在合成中产出
 * - 默认 mock sink 记录调用，不接真实后端
 *
 * 对齐：
 * - W0 Intent 形状（`@crish/block-paper-contract`）
 * - editor-kit `ImeMachine.tryAcceptIntent` / `structureKeyGuard`
 */

import type { Intent } from '@crish/block-paper-contract';
import {
  guardStructureIntent,
  type GuardableIntent,
  type ImeMachine,
  type StructureGuardRejectCode,
} from '@crish/editor-kit';

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
 * 仅接受 W0 `Intent`（text_edit | op）。
 */
export type IntentSink = (intent: Intent) => Promise<IntentSinkResult>;

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export type SubmitIntentOptions = {
  /**
   * ImeMachine：优先用其 `tryAcceptIntent`（与 pin/合成态一致）。
   */
  ime?: ImeMachine;
  /**
   * 无 ime 时的 composing 查询；boolean 或回调。
   */
  isComposing?: boolean | (() => boolean);
};

export type SubmitIntentRejectCode =
  StructureGuardRejectCode | 'not_w0_intent' | 'sink_reject';

export type SubmitIntentResult =
  | { ok: true; intent: Intent }
  | {
      ok: false;
      reason: string;
      code: SubmitIntentRejectCode;
      intent: GuardableIntent;
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
 * @param intent W0 Intent 或 UI 扩展（slash / structure_key）；扩展类型不会进 sink
 * @param sink 异步接收端
 * @param options ime / isComposing
 */
export async function submitIntent(
  intent: GuardableIntent,
  sink: IntentSink,
  options: SubmitIntentOptions = {}
): Promise<SubmitIntentResult> {
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

  // 2) 仅 W0 Intent 可下发 sink（UI 扩展由宿主另行处理）
  if (!isW0Intent(intent)) {
    return {
      ok: false,
      reason: `intentBridge：${intent.type} 非 W0 Intent，不可下发 sink（须先映射为 text_edit/op）`,
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
  /** 按调用顺序记录的 Intent */
  calls: Intent[];
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
  const calls: Intent[] = [];
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
