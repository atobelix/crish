/**
 * D2 最小观测骨架：控制面内存计数器（lite，无 OpenTelemetry）。
 *
 * 信号（中控 §13 + residual）：
 * - `run_control_{L1,L2,L3}` — soft_inject / cooperative_stop / force_cancel
 * - `draft_enter` / `draft_commit` — 进入草稿 / 草稿 materialize 成真会话
 * - `message_upsert` — 消息按 id upsert（append 或 merge）
 * - `hydrate_prune` — hydrate/list 剪掉的幽灵空壳数
 * - `shell_empty_assert` — dev 空壳不变量失败次数
 * - `silent_complete` — run 完成但无用户可见正文/工具（仅 hidden thinking 或全空）
 * - `transport_degraded_direct_fetch` — inventory #10：daemon WS 不可达时自动降级 HTTP SSE
 *
 * 仅进程内累加，无 IO；供 dev assert / 单测 / 未来 health hook 读取。
 *
 * API：`record` / `incControlMetric` · `getSnapshot` / `getControlMetrics` · `reset` / `resetControlMetrics`
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §13 / Round D2
 * @see docs/architecture/run-control.md §6
 */

import { RUN_CONTROL_LEVEL, type RunControlLevel } from '@crish/shared-types';

export type ControlMetricKey =
  | 'run_control_L1'
  | 'run_control_L2'
  | 'run_control_L3'
  | 'draft_enter'
  | 'draft_commit'
  | 'message_upsert'
  | 'hydrate_prune'
  | 'shell_empty_assert'
  | 'silent_complete'
  /** inventory #10: auto fallback to streamViaDirectFetch when daemon WS down */
  | 'transport_degraded_direct_fetch';

const counters: Record<ControlMetricKey, number> = {
  run_control_L1: 0,
  run_control_L2: 0,
  run_control_L3: 0,
  draft_enter: 0,
  draft_commit: 0,
  message_upsert: 0,
  hydrate_prune: 0,
  shell_empty_assert: 0,
  silent_complete: 0,
  transport_degraded_direct_fetch: 0,
};

/** 原子 +1（或 +n，n≥1） */
export function incControlMetric(key: ControlMetricKey, n = 1): void {
  if (n <= 0) return;
  counters[key] = (counters[key] ?? 0) + n;
}

/** 简洁别名：record(name) */
export function record(key: ControlMetricKey, n = 1): void {
  incControlMetric(key, n);
}

/** 快照副本（只读语义） */
export function getControlMetrics(): Readonly<
  Record<ControlMetricKey, number>
> {
  return { ...counters };
}

/** 简洁别名：getSnapshot() */
export function getSnapshot(): Readonly<Record<ControlMetricKey, number>> {
  return getControlMetrics();
}

/** 单测 / 重置 */
export function resetControlMetrics(): void {
  for (const k of Object.keys(counters) as ControlMetricKey[]) {
    counters[k] = 0;
  }
}

/** 简洁别名：reset() */
export function reset(): void {
  resetControlMetrics();
}

/** 按 wire level 记 L1/L2/L3（L0 不计） */
export function recordRunControlLevel(
  level: RunControlLevel | string | null | undefined
): void {
  if (!level) return;
  if (level === RUN_CONTROL_LEVEL.L1 || level === 'soft_inject') {
    incControlMetric('run_control_L1');
    return;
  }
  if (level === RUN_CONTROL_LEVEL.L2 || level === 'cooperative_stop') {
    incControlMetric('run_control_L2');
    return;
  }
  if (level === RUN_CONTROL_LEVEL.L3 || level === 'force_cancel') {
    incControlMetric('run_control_L3');
  }
}

export function recordDraftEnter(): void {
  incControlMetric('draft_enter');
}

/** session.materialize：草稿 commit → 真会话 */
export function recordDraftCommit(): void {
  incControlMetric('draft_commit');
}

/** 别名：session.materialize ≡ draft_commit */
export function recordSessionMaterialize(): void {
  recordDraftCommit();
}

export function recordMessageUpsert(): void {
  incControlMetric('message_upsert');
}

/** hydrate/list 路径剪掉 n 个空壳 */
export function recordHydratePrune(count = 1): void {
  incControlMetric('hydrate_prune', count);
}

/** dev 空壳不变量失败（每次检测命中 +n） */
export function recordShellEmptyAssert(count = 1): void {
  incControlMetric('shell_empty_assert', count);
}

/**
 * run completed 但无用户可见正文/工具（D2-5 silent-complete，单消息可见性直判）。
 * 不改变 run 成功语义，仅计数。
 */
export function recordSilentComplete(count = 1): void {
  incControlMetric('silent_complete', count);
}

/**
 * inventory #10：`ALLOW_AUTO_DIRECT_FETCH_FALLBACK` 路径启动 HTTP SSE。
 * 每次降级 +1；不改变 transport 语义。
 */
export function recordTransportDegradedDirectFetch(count = 1): void {
  incControlMetric('transport_degraded_direct_fetch', count);
}
