/**
 * MD 前缀可注入 sink 工厂（SD-46 · mock / provisional / 双通道审计）。
 *
 * 公开入口仍为 `mdPrefixHost.ts`（barrel）。
 * **只**走 `TurnIntoSink`；slash 仍走 `IntentSink`，**不互抹**。
 * provisional wire = strip `text_edit` + `pending_turn_into_flavour`（≠ kind）。
 * **≠ EL-01**；**≠ A-BLK-08/09 e2e**；**禁止**以 mock calls 关 e2e。
 */

import { collabOpsToJson } from '@crish/block-paper-contract';
import type {
  ApplyOpsAdapter,
  IntentSink,
  IntentSinkResult,
} from './intentBridge';
import type { PaperIntent } from '../chrome/structureIntents';
import {
  isTurnIntoIntent,
  turnIntoIntentToProvisionalOps,
  type TurnIntoIntent,
  type TurnIntoSink,
  type TurnIntoSinkResult,
} from './turnInto';

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
 * ## wire 形状
 * - strip 前缀 `text_edit` + `update_props.pending_turn_into_flavour`
 * - **非**独立 `"op":"turn_into"` JSON（真 Op 见 RS `Op::TurnInto`；pending 路径亦改 kind）
 * - CONN-D 后：真实 applyOps→RS 时 kind **会**变；mock applyOps 不证权威
 * - **≠** A-BLK-08 关闭证据；**≠** 桌面键入 e2e
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
      'createTurnIntoProvisionalCollabSink：须注入 applyOps；wire 为 strip+pending（CONN-D：RS 消费 pending 改 kind）'
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

    // provisional 形状（strip + pending）；RS CONN-D 消费 pending 改 kind
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
