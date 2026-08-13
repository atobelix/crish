/**
 * Intent 下发桥（W3-D + W3-F）：Intent → sink → 真 apply（或测形状 mock）。
 *
 * - `submitIntent`：经 IME 结构守卫后调用 sink
 * - composing 时 **结构 Intent**（`op` / slash / structure_key / StructureIntent）拒绝
 * - `text_edit` 在 composing 期守卫放行，但 TextLeafModel 默认不在合成中产出
 * - W3-F：`StructureIntent`（insert/delete/move/collapse/slash_insert）可直接进 sink
 *
 * ## 写路径工厂（W3-D Strict 终局 · G-INV-3）
 *
 * | 工厂 | 用途 | 可否作生产默认 |
 * | ---- | ---- | -------------- |
 * | **`createCollabApplySink`** | Intent → collab wire → 注入 `applyOps`（`DocSession::apply` / IPC 等价） | **是 · 生产默认应使用** |
 * | `createMockIntentSink` | 仅记录 `calls[]`，不接后端 | **否**；仅 W3-D-S / W3-D-PM 形状测 |
 *
 * 真 apply 库侧集成（TextEdit + Structure → 树/`read_text`）：
 * `crates/conex-doc-collab/tests/w3_d_structure_intent_or_wire_apply.rs`
 *
 * ## 轨声明（诚实 · 09 §0.4）
 *
 * - **W3-D** = 真 PM（`leaves/pm`，W3-D-PM）+ 至少一条 TextEditIntent + 一条 StructureIntent
 *   → 真 `DocSession::apply` 集成绿 + 本工厂作生产写路径形状
 * - **≠ EL-01**；**≠ A-BLK 全表 e2e**；**≠** 块工作区完成
 * - **禁止**仅以 mock sink / mock.calls 宣称 W3-D Strict 完成
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
  submitStructureToCollabWire,
  type PaperIntent,
  type StructureIntent,
  type StructureToOpsOptions,
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
 * Intent 接收端（生产：`createCollabApplySink`；测形状：`createMockIntentSink`）。
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
// 真 apply sink（W3-D 生产默认形状 · G-INV-3）
// ---------------------------------------------------------------------------

/**
 * 注入的 apply 面：collab wire JSON → 真 `DocSession::apply`（或 Tauri IPC 等价）。
 *
 * 集成测 / 宿主装配时：
 * - RS 库内：`ops_from_json_str(json)` → `session.apply(Origin::User, &ops)`
 * - 桌面：IPC `note_apply_ops`（已接 CONN-B3，`noteApplyOpsIpc.ts` 生产默认）——
 *   真 apply 经该 IPC 到达 Rust `DocSession::apply`；库内 RS 集成测证真 apply
 *   （`w3_d_*_true_apply`）。adapter 形状保持：`applyOps` 注入面不变，
 *   IPC / 库内双轨均为真写锥。
 *
 * **禁止**用空实现 + mock.calls 冒充本接口的「真 apply」关闭证据。
 */
export type ApplyOpsAdapter = (
  opsJson: string,
  meta: { intentId: string }
) => Promise<IntentSinkResult>;

/** `createCollabApplySink` 选项：wire 映射 + 强制注入 applyOps */
export type CollabApplySinkOptions = StructureToOpsOptions & {
  /**
   * 必填：wire JSON → 真写锥。
   * 生产/默认写路径 **必须** 注入真实后端；单测可注入内存 adapter（仍须产出可解析 wire）。
   */
  applyOps: ApplyOpsAdapter;
};

/** 可审计的 collab apply sink（生产形状） */
export type CollabApplySink = {
  /** 供 `submitIntent` 使用 */
  sink: IntentSink;
  /** 按调用顺序记录的 wire JSON（审计 / 测形状；≠ mock.calls 关 W3-D） */
  wireCalls: string[];
  /** 每次 applyOps 返回快照 */
  results: IntentSinkResult[];
  /** 清空审计缓冲 */
  clear: () => void;
};

/**
 * 创建 **真 apply** Intent sink（**生产默认应使用本工厂**）。
 *
 * ```
 * PaperIntent
 *   → submitStructureToCollabWire（paperIntentToOps + collabOpsToJson）
 *   → applyOps(opsJson)   // DocSession::apply / IPC 等价
 *   → IntentSinkResult
 * ```
 *
 * - TextEditIntent → `text_edit` wire → apply → 文本权威变化（RS：`read_text`）
 * - StructureIntent → insert/delete/… wire → apply → 树变化
 * - `createMockIntentSink` **仅**测形状，**不得**再当生产默认写路径
 *
 * ## 轨
 * - 本工厂 + W3-D-PM + RS `w3_d_*_true_apply` 集成绿 ⇔ **W3-D Strict** 关闭面
 * - **≠ EL-01**；**≠ A-BLK 全表**
 */
export function createCollabApplySink(
  options: CollabApplySinkOptions
): CollabApplySink {
  if (typeof options.applyOps !== 'function') {
    throw new Error(
      'createCollabApplySink：必须注入 applyOps（DocSession::apply / IPC 等价）；禁止无后端空 sink 冒充生产写路径'
    );
  }

  const wireCalls: string[] = [];
  const results: IntentSinkResult[] = [];
  const { applyOps, ...wireOpts } = options;

  const sink: IntentSink = async (intent) => {
    let payload: ReturnType<typeof submitStructureToCollabWire>;
    try {
      payload = submitStructureToCollabWire(intent, wireOpts);
    } catch (e) {
      const reason =
        e instanceof Error
          ? e.message
          : `createCollabApplySink：wire 映射失败：${String(e)}`;
      const r: IntentSinkResult = { ok: false, reason };
      results.push(r);
      return r;
    }

    wireCalls.push(payload.json);

    try {
      const applied = await applyOps(payload.json, {
        intentId: payload.intentId,
      });
      const r: IntentSinkResult = { ok: applied.ok };
      if (applied.reason !== undefined) {
        r.reason = applied.reason;
      }
      results.push(r);
      return r;
    } catch (e) {
      const reason =
        e instanceof Error
          ? e.message
          : `createCollabApplySink：applyOps 抛错：${String(e)}`;
      const r: IntentSinkResult = { ok: false, reason };
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

/**
 * @deprecated 命名别名：与 `createCollabApplySink` 同义（DocSession 面语义）。
 * @see createCollabApplySink 生产默认真 apply 工厂（本导仅为历史/文档别名）
 * @removeWhen 无外部调用方引用本别名后删除
 */
export const createDocSessionApplySink = createCollabApplySink;

// ---------------------------------------------------------------------------
// Mock sink（仅测形状 · 禁止作生产默认）
// ---------------------------------------------------------------------------

/** 可审计的 mock sink（**仅** W3-D-S / W3-D-PM 形状测） */
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
 * 创建 mock sink：记录全部调用，默认 `{ ok: true }`。
 *
 * **仅测形状**（W3-D-S / W3-D-PM）。  
 * **生产默认写路径请用 `createCollabApplySink`**——mock **不得**再当默认生产路径（G-INV-3 / plans/05 §2.2）。  
 * **禁止**以 `mock.calls` 计 A-BLK / W3-D Strict 关闭。
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
