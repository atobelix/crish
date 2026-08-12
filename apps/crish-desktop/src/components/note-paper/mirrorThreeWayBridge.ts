/**
 * 三路 UI 决策 → mirror import IPC 桥（CONN-E）
 *
 * ## 职责
 * - 消费 `resolveThreeWayAction` / StatusBar `onAction` 产出的 `ThreeWayDecision`
 * - 仅在 `callsImport && strategy` 时调 `NoteMirrorIpc.importMirrorProposal`
 * - **X-05**：`decision.ok === false`（含 `x05_silent_drop_blocked`）**绝不**发 import
 *
 * ## 诚实边界
 * - 本桥 **不** apply Op 批；import 成功仅得提案 / 冲突
 * - **不**启动 poll timer / OS watcher；**≠ EL-03**；**≠ inotify 满关**
 * - 空态默认无 report：上层可 `detectMirrorDrift` 后注入 StatusBar
 */

import type {
  NoteImportMirrorOutcome,
  NoteMirrorIpc,
} from '../../api/noteMirrorIpc';
import type { ThreeWayDecision } from './mirrorDriftUi';

export type MirrorThreeWaySubmitOpts = {
  docId: string;
  /** 与 StatusBar / resolve 一致的 unpushed 计数 */
  unpushedOpCount: number;
  authorityRev?: number;
  useSessionTree?: boolean;
  ipc: NoteMirrorIpc;
};

export type MirrorThreeWaySubmitResult =
  | {
      submitted: false;
      /** 前端门禁或 keep_doc */
      reason:
        | 'decision_blocked'
        | 'keep_doc_no_import'
        | 'no_strategy'
        | 'empty_doc_id';
      decision: ThreeWayDecision;
      code?: string;
    }
  | {
      submitted: true;
      decision: ThreeWayDecision;
      outcome: NoteImportMirrorOutcome;
    };

/**
 * 将三路决策提交到 import IPC。
 *
 * StatusBar 用法：
 * ```ts
 * onMirrorThreeWay={async (d) => {
 *   const r = await submitThreeWayViaMirrorIpc(d, { docId, unpushedOpCount, ipc });
 *   // r.submitted && r.outcome.ok && kind === 'conflict' && silentOverwriteBlocked → 仍 X-05
 * }}
 * ```
 */
export async function submitThreeWayViaMirrorIpc(
  decision: ThreeWayDecision,
  opts: MirrorThreeWaySubmitOpts
): Promise<MirrorThreeWaySubmitResult> {
  const docId = opts.docId?.trim() ?? '';
  if (!docId) {
    return {
      submitted: false,
      reason: 'empty_doc_id',
      decision,
    };
  }

  // X-05 / no_drift：前端门禁失败 → 禁止任何 import 调用
  if (!decision.ok) {
    return {
      submitted: false,
      reason: 'decision_blocked',
      decision,
      code: decision.code,
    };
  }

  if (!decision.callsImport) {
    return {
      submitted: false,
      reason: 'keep_doc_no_import',
      decision,
    };
  }

  if (!decision.strategy) {
    return {
      submitted: false,
      reason: 'no_strategy',
      decision,
    };
  }

  const outcome = await opts.ipc.importMirrorProposal({
    docId,
    strategy: decision.strategy,
    unpushedOpCount: Math.max(0, opts.unpushedOpCount | 0),
    authorityRev: opts.authorityRev,
    useSessionTree: opts.useSessionTree,
  });

  return {
    submitted: true,
    decision,
    outcome,
  };
}

/**
 * 工厂：绑定 docId / ipc 后可直接作 StatusBar `onAction`。
 * 返回 Promise 结果；调用方可 `.then` 更新本地 lastSubmit。
 */
export function createMirrorThreeWayOnAction(
  opts: MirrorThreeWaySubmitOpts,
  onResult?: (r: MirrorThreeWaySubmitResult) => void
): (decision: ThreeWayDecision) => void {
  return (decision) => {
    void submitThreeWayViaMirrorIpc(decision, opts).then((r) => {
      onResult?.(r);
    });
  };
}
