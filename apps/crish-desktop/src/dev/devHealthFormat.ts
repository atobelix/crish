/**
 * D2-3：controlMetrics 快照纯格式化（无 React / 无 IO）。
 */
import type { ControlMetricKey } from '../api/controlMetrics';

export type ControlMetricsSnapshot = Readonly<Record<ControlMetricKey, number>>;

/** 展示单元格：短 text + 完整 title（原生 tooltip） */
export type DevHealthMetricCell = {
  id: string;
  label: string;
  text: string;
  value: number;
  title: string;
  warn?: boolean;
};

/** 纯函数：快照 → 展示单元格（可单测） */
export function formatControlMetricsLines(
  snap: ControlMetricsSnapshot,
): DevHealthMetricCell[] {
  const l1 = snap.run_control_L1 ?? 0;
  const l2 = snap.run_control_L2 ?? 0;
  const l3 = snap.run_control_L3 ?? 0;
  const draftEnter = snap.draft_enter ?? 0;
  const draftCommit = snap.draft_commit ?? 0;
  const upsert = snap.message_upsert ?? 0;
  const prune = snap.hydrate_prune ?? 0;
  const shell = snap.shell_empty_assert ?? 0;

  return [
    {
      id: 'L1',
      label: 'L1',
      text: `L1:${l1}`,
      value: l1,
      title: 'run_control_L1 (soft_inject)',
    },
    {
      id: 'L2',
      label: 'L2',
      text: `L2:${l2}`,
      value: l2,
      title: 'run_control_L2 (cooperative_stop)',
    },
    {
      id: 'L3',
      label: 'L3',
      text: `L3:${l3}`,
      value: l3,
      title: 'run_control_L3 (force_cancel)',
    },
    {
      id: 'draft',
      label: 'draft',
      text: `draft:${draftEnter}/${draftCommit}`,
      value: draftEnter + draftCommit,
      title: `draft_enter=${draftEnter} · draft_commit=${draftCommit}`,
    },
    {
      id: 'upsert',
      label: 'upsert',
      text: `up:${upsert}`,
      value: upsert,
      title: 'message_upsert',
    },
    {
      id: 'prune',
      label: 'prune',
      text: `prune:${prune}`,
      value: prune,
      title: 'hydrate_prune (ghost shells removed)',
    },
    {
      id: 'shell',
      label: 'shell',
      text: `shell:${shell}`,
      value: shell,
      title: 'shell_empty_assert (dev empty-shell violations)',
      warn: shell > 0,
    },
  ];
}

/** 纯函数：单行摘要字符串（可单测） */
export function formatControlMetricsStrip(snap: ControlMetricsSnapshot): string {
  return formatControlMetricsLines(snap)
    .map((c) => c.text)
    .join(' ');
}
