// run 详情页派生纯函数（R2-05 部分 6 / R2UX-05-08）：零 UI 依赖，jest 直测
// - 状态徽标（F1 §5.1 十态 → 五色分组的四态收敛 + 事件流派生）：run 状态真源 =
//   terminalEvents.deriveRunStatus（agent-start → running / run-terminal → 收口）；
//   paused 无事件载体（41 事件无 pause/resume 变体，F3 §2 盘点），由控制回执
//   派生（RunControlVm.paused，cooperative_stop 成功置位）；
// - 时间线分页（R2UX-05-08 游标分页 200/页）：窗口条目（seq 升序）展示「最新
//   pageSize×pages 条」窗口尾部（新事件到达窗口滑动、最新事件恒在底部，
//   配合 EventFeed 自动滚底语义）；「加载更早」向历史方向扩展（顶部出现更早
//   条目，F3 §3.4.2 顶部收起提示语义）；
// - 控制动作编排：终态（completed/cancelled/failed）无控制按钮（TerminalImmutable
//   拒绝，run.rs:340-364）；unknown（有事件无 agent-start）仅取消可试；
//   running → [暂停, 取消]；paused → [恢复, 取消]。
import {
  readString,
  type EventWindow,
  type FeedEntry,
} from '@/domain/store/eventReducers';
import type { RunStatusView } from '@/presentation/components/terminal/terminalEvents';

// ── 状态徽标（F1 §5.1 五色分组的四态收敛 + unknown 诚实化）──────────────

export type RunBadgeState =
  'running' | 'paused' | 'error' | 'terminal' | 'unknown';

export interface RunBadgeControl {
  /** 本地暂停态（控制回执派生；事件流无 pause 事件） */
  paused: boolean;
}

/**
 * 徽标状态派生（优先级：failed → error > 终态 → terminal > paused > running > unknown）：
 * - error：run-terminal failed（F1 §5.1 红）；
 * - terminal：run-terminal completed/cancelled（绿/淡灰，终态权威 F1 §5.1「终态判定」）；
 * - paused：控制回执 cooperative_stop 成功（D4 §5.6 L2）；
 * - running：agent-start 后未收口（F1 §5.1 进行中）；
 * - unknown：无 agent-start / 无 run-terminal（诚实化透传，F1 §5.1「未知」）。
 */
export function deriveRunBadge(
  status: RunStatusView,
  control: RunBadgeControl
): RunBadgeState {
  if (status.state === 'failed') return 'error';
  if (status.state === 'completed' || status.state === 'cancelled') {
    return 'terminal';
  }
  if (status.state === 'running') {
    return control.paused ? 'paused' : 'running';
  }
  return 'unknown';
}

/** 徽标文案（terminal 细分 completed/cancelled；未知态保真不静默改写） */
export function runBadgeLabel(
  state: RunBadgeState,
  terminal: RunStatusView['state']
): string {
  switch (state) {
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'error':
      return '失败';
    case 'terminal':
      return terminal === 'cancelled' ? '已取消' : '已完成';
    default:
      return '状态未知';
  }
}

/** 徽标色调（组件层映射主题 token；双通道：色点 + 文字，M4 §6.5） */
export type RunBadgeTone = 'info' | 'warning' | 'error' | 'success' | 'muted';

export function runBadgeTone(
  state: RunBadgeState,
  terminal: RunStatusView['state']
): RunBadgeTone {
  switch (state) {
    case 'running':
      return 'info';
    case 'paused':
      return 'warning';
    case 'error':
      return 'error';
    case 'terminal':
      return terminal === 'cancelled' ? 'muted' : 'success';
    default:
      return 'muted';
  }
}

// ── 会话 / 时间派生 ────────────────────────────────────────────────────────

/** run 归属会话 id（首个携带 sessionId 的条目；事件流不依赖会话归属） */
export function sessionIdOfRun(entries: readonly FeedEntry[]): string | null {
  for (const entry of entries) {
    const sid = readString(entry, 'sessionId');
    if (sid) return sid;
  }
  return null;
}

/** run 最大序列（游标分页数据面：窗口内该 run 的 seq 上限） */
export function runLastSeqOf(entries: readonly FeedEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    const seq = entry.sequence;
    if (typeof seq === 'number' && seq > max) max = seq;
  }
  return max;
}

/**
 * 该 run 所属窗口的环形淘汰计数（F3 §3.4.2 顶部提示数据面）：
 * 跨窗口展平时按「包含本 run 条目的窗口」汇总，不把其它 run 的淘汰计入。
 */
export function truncatedCountOfRun(
  windows: Readonly<Record<string, EventWindow>>,
  runId: string
): number {
  let total = 0;
  for (const key of Object.keys(windows)) {
    const window = windows[key];
    if (!window) continue;
    let hasRun = false;
    for (const entry of window.entries) {
      if (readString(entry, 'runId') === runId) {
        hasRun = true;
        break;
      }
    }
    if (hasRun) total += window.truncatedCount;
  }
  return total;
}

/**
 * 时长文案（F1 §4.3「运行中 · 12s」口径；endMs 缺省 = 进行中按 nowMs 计算）：
 * <60s → "Ns"；<60m → "Nm Ns"；否则 → "Nh Nm"。
 */
export function formatDuration(
  startMs: number,
  endMs?: number,
  nowMs: number = Date.now()
): string {
  const end = endMs ?? nowMs;
  const secs = Math.max(0, Math.floor((end - startMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// ── 时间线分页（R2UX-05-08 游标分页 200/页）────────────────────────────────

export interface RunTimelinePage {
  /** 展示序条目（seq 升序窗口尾部；最新在底部，跟随 EventFeed 自动滚底语义） */
  visible: FeedEntry[];
  /** 已加载条数（= visible 长度；= min(总数, pageSize×pages)） */
  loadedCount: number;
  /** 窗口内该 run 事件总数（环形上限内，R2UX-05-09） */
  totalCount: number;
  /** 还有更早事件可加载 */
  hasMore: boolean;
}

/**
 * 游标分页（200/页，R2UX-05-08）：输入 seq 升序条目（entriesOfRun 语义），
 * 展示「最新 loadedCount 条」——live 窗口尾部：新事件到达时窗口随之滑动，
 * 最新事件始终可见且位于底部（配合 EventFeed 自动滚底跟随）；「加载更早」
 * 扩展窗口向历史方向（顶部出现更早条目，F3 §3.4.2 顶部收起提示语义）。
 */
export function paginateRunEntries(
  entriesAsc: readonly FeedEntry[],
  pageSize: number,
  pagesLoaded: number
): RunTimelinePage {
  const cap = Math.max(1, pagesLoaded) * pageSize;
  const totalCount = entriesAsc.length;
  const loadedCount = Math.min(totalCount, cap);
  const visible = entriesAsc.slice(totalCount - loadedCount);
  return {
    visible,
    loadedCount,
    totalCount,
    hasMore: totalCount > cap,
  };
}

// ── 控制动作编排（L2/L3 分级；M4 §5.6 / D4 §5.6）──────────────────────────

export type RunControlAction = 'pause' | 'resume' | 'cancel';

/**
 * 控制按钮编排：
 * - 终态（completed/cancelled/failed）→ 无按钮（TerminalImmutable 终态拒绝）；
 * - running → [暂停, 取消]（L2 单点 / L3 二次确认）；
 * - paused（控制回执）→ [恢复, 取消]；
 * - unknown（有事件无 agent-start）→ 仅 [取消]（诚实化：状态未知时只提供
 *   危险动作的最小面，不猜「在运行」）。
 */
export function runControlActionsOf(
  status: RunStatusView,
  paused: boolean
): RunControlAction[] {
  if (
    status.state === 'completed' ||
    status.state === 'cancelled' ||
    status.state === 'failed'
  ) {
    return [];
  }
  if (status.state === 'unknown') return ['cancel'];
  if (paused) return ['resume', 'cancel'];
  return ['pause', 'cancel'];
}
