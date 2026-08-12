/**
 * Slash 选中 → Intent → sink 统一写路径（纯 TS，可测）。
 *
 * ## 角色
 * - React 浮层 / DomHost 点击 / 键盘确认 共用：`selectItem` / `selectActive`
 *   → `slash_insert` → `submitIntent` → sink
 * - **禁止** DOM 旁路写盘；本模块不触 DOM
 *
 * ## 轨
 * - W3-F-S：mock sink 形状
 * - W3-F Strict 子集：`createCollabApplySink`（不回退 mock 默认）
 * - **≠ EL-01**；**≠** A-BLK-02 产品 e2e 全关
 */

import {
  submitIntent,
  type IntentSink,
  type SubmitIntentOptions,
  type SubmitIntentResult,
} from '../leaves/intentBridge';
import type { SlashInsertIntent } from './structureIntents';
import type {
  SlashMenuModel,
  SlashMenuSnapshot,
  SlashSelectResult,
} from './SlashMenuModel';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type SlashSelectAndSubmitOk = {
  ok: true;
  intent: SlashInsertIntent;
  /** select 后的菜单快照（已 close） */
  snapshot: SlashMenuSnapshot;
  submit: SubmitIntentResult;
};

export type SlashSelectAndSubmitFail =
  | {
      ok: false;
      stage: 'select';
      select: Extract<SlashSelectResult, { ok: false }>;
    }
  | {
      ok: false;
      stage: 'submit';
      intent: SlashInsertIntent;
      submit: Extract<SubmitIntentResult, { ok: false }>;
    };

export type SlashSelectAndSubmitResult =
  SlashSelectAndSubmitOk | SlashSelectAndSubmitFail;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 按 catalog 项 id 确认并下发 sink。
 *
 * - select 失败（composing / 未开 / 无项）→ stage=select
 * - select 成功但 submit 被 IME/sink 拒 → stage=submit（菜单已关，与 model 语义一致）
 */
export async function selectSlashItemAndSubmit(
  menu: SlashMenuModel,
  catalogItemId: string,
  sink: IntentSink,
  options: SubmitIntentOptions = {}
): Promise<SlashSelectAndSubmitResult> {
  const sel = menu.selectItem(catalogItemId);
  if (!sel.ok) {
    return { ok: false, stage: 'select', select: sel };
  }
  const submitted = await submitIntent(sel.intent, sink, options);
  if (!submitted.ok) {
    return {
      ok: false,
      stage: 'submit',
      intent: sel.intent,
      submit: submitted,
    };
  }
  return {
    ok: true,
    intent: sel.intent,
    snapshot: sel.snapshot,
    submit: submitted,
  };
}

/**
 * 确认当前高亮项并下发 sink（键盘 Enter 路径）。
 */
export async function selectSlashActiveAndSubmit(
  menu: SlashMenuModel,
  sink: IntentSink,
  options: SubmitIntentOptions = {}
): Promise<SlashSelectAndSubmitResult> {
  const sel = menu.selectActive();
  if (!sel.ok) {
    return { ok: false, stage: 'select', select: sel };
  }
  const submitted = await submitIntent(sel.intent, sink, options);
  if (!submitted.ok) {
    return {
      ok: false,
      stage: 'submit',
      intent: sel.intent,
      submit: submitted,
    };
  }
  return {
    ok: true,
    intent: sel.intent,
    snapshot: sel.snapshot,
    submit: submitted,
  };
}

// ---------------------------------------------------------------------------
// catalog 分组（React / DomHost 共用纯函数）
// ---------------------------------------------------------------------------

export type SlashCatalogSegment<T extends { group?: string }> = {
  group: string | undefined;
  items: T[];
};

/**
 * 保序分组：相邻同 group 合并；不重排 catalog 顺序。
 * React 浮层与 DomHost 投影同算法，避免双轨项序漂移。
 */
export function groupSlashCatalogItems<T extends { group?: string }>(
  items: readonly T[]
): SlashCatalogSegment<T>[] {
  const segs: SlashCatalogSegment<T>[] = [];
  for (const it of items) {
    const g = it.group;
    const last = segs[segs.length - 1];
    if (last && last.group === g) {
      last.items.push(it);
    } else {
      segs.push({ group: g, items: [it] });
    }
  }
  return segs;
}
