// runDetailMeta 纯函数单测（R2-05 部分 6）：
// - 状态徽标派生：failed → error / completed·cancelled → terminal / running+paused
//   → paused / running → running / 无事件 → unknown（F1 §5.1 + 事件流派生）；
//   徽标文案与色调映射（双通道：色点 + 文字，M4 §6.5）；
// - 会话/时间派生：sessionIdOfRun / runLastSeqOf / formatDuration（<60s / <60m / h）；
// - 时间线分页（R2UX-05-08 游标 200/页）：最新窗口尾部、hasMore、滑动窗口语义
//   （新事件到达后可见窗口保持最新）；
// - 控制动作编排：终态空 / running→[暂停,取消] / paused→[恢复,取消] /
//   unknown→仅[取消]（TerminalImmutable / D4 §5.6 分级）。
import type { FeedEntry, EventWindow } from '@/domain/store/eventReducers';
import type { RunStatusView } from '@/presentation/components/terminal/terminalEvents';
import {
  deriveRunBadge,
  formatDuration,
  paginateRunEntries,
  runBadgeLabel,
  runBadgeTone,
  runControlActionsOf,
  runLastSeqOf,
  sessionIdOfRun,
  truncatedCountOfRun,
  type RunBadgeControl,
} from './runDetailMeta';

function makeEntry(
  type: string,
  runId: string,
  sequence?: number,
  overrides: Record<string, unknown> = {}
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    runId,
    sequence,
    receivedAtMs: 1_000,
    ...overrides,
  } as FeedEntry;
}

function statusOf(state: RunStatusView['state']): RunStatusView {
  return { state };
}

const controlIdle: RunBadgeControl = { paused: false };
const controlPaused: RunBadgeControl = { paused: true };

describe('deriveRunBadge（F1 §5.1 五色分组 × 事件流派生）', () => {
  it('run-terminal failed → error（红，优先于一切）', () => {
    expect(deriveRunBadge(statusOf('failed'), controlPaused)).toBe('error');
    expect(deriveRunBadge(statusOf('failed'), controlIdle)).toBe('error');
  });

  it('completed / cancelled → terminal（终态权威，F1 §5.1 终态判定）', () => {
    expect(deriveRunBadge(statusOf('completed'), controlPaused)).toBe(
      'terminal'
    );
    expect(deriveRunBadge(statusOf('cancelled'), controlIdle)).toBe('terminal');
  });

  it('running + 控制回执 paused → paused（D4 §5.6 L2 协作停止）', () => {
    expect(deriveRunBadge(statusOf('running'), controlPaused)).toBe('paused');
  });

  it('running → running（F1 §5.1 进行中）', () => {
    expect(deriveRunBadge(statusOf('running'), controlIdle)).toBe('running');
  });

  it('unknown（无 agent-start / 无 run-terminal）→ unknown（诚实化透传）', () => {
    expect(deriveRunBadge(statusOf('unknown'), controlIdle)).toBe('unknown');
    expect(deriveRunBadge(statusOf('unknown'), controlPaused)).toBe('unknown');
  });
});

describe('runBadgeLabel / runBadgeTone（双通道文案 + 色）', () => {
  it('文案：运行中 / 已暂停 / 失败 / 已完成 / 已取消 / 状态未知', () => {
    expect(runBadgeLabel('running', 'running')).toBe('运行中');
    expect(runBadgeLabel('paused', 'running')).toBe('已暂停');
    expect(runBadgeLabel('error', 'failed')).toBe('失败');
    expect(runBadgeLabel('terminal', 'completed')).toBe('已完成');
    expect(runBadgeLabel('terminal', 'cancelled')).toBe('已取消');
    expect(runBadgeLabel('unknown', 'unknown')).toBe('状态未知');
  });

  it('色调：running=info / paused=warning / error=error / completed=success / cancelled·unknown=muted', () => {
    expect(runBadgeTone('running', 'running')).toBe('info');
    expect(runBadgeTone('paused', 'running')).toBe('warning');
    expect(runBadgeTone('error', 'failed')).toBe('error');
    expect(runBadgeTone('terminal', 'completed')).toBe('success');
    expect(runBadgeTone('terminal', 'cancelled')).toBe('muted');
    expect(runBadgeTone('unknown', 'unknown')).toBe('muted');
  });
});

describe('会话 / 时间派生', () => {
  it('sessionIdOfRun：首个携带 sessionId 条目；空 → null', () => {
    const entries = [
      makeEntry('agent-start', 'r-1', 1, { sessionId: 's-x' }),
      makeEntry('message-end', 'r-1', 2),
    ];
    expect(sessionIdOfRun(entries)).toBe('s-x');
    expect(sessionIdOfRun([])).toBeNull();
  });

  it('runLastSeqOf：窗口内该 run 的最大 seq（缺失 seq 忽略）', () => {
    const entries = [
      makeEntry('agent-start', 'r-1', 5),
      makeEntry('message-end', 'r-1', 3),
      makeEntry('message-end', 'r-1', undefined),
    ];
    expect(runLastSeqOf(entries)).toBe(5);
    expect(runLastSeqOf([])).toBe(0);
  });

  it('formatDuration：<60s → Ns；<60m → Nm Ns；≥1h → Nh Nm；进行中按 nowMs', () => {
    expect(formatDuration(1_000, 11_000)).toBe('10s');
    expect(formatDuration(1_000, 21_000)).toBe('20s');
    expect(formatDuration(1_000, 62_000)).toBe('1m 1s');
    expect(formatDuration(1_000, 189_000)).toBe('3m 8s');
    expect(formatDuration(1_000, 3_661_000)).toBe('1h 1m');
    expect(formatDuration(1_000, undefined, 11_000)).toBe('10s');
    // endMs 早于 startMs（时钟回拨容错）→ 0s 不为负
    expect(formatDuration(1_000, 500)).toBe('0s');
  });
});

describe('paginateRunEntries（R2UX-05-08 游标分页 200/页）', () => {
  const N = 450;
  const entries = Array.from({ length: N }, (_, i) =>
    makeEntry('message-end', 'r-1', i + 1)
  );

  it('第一页：展示最新 200 条（seq 251..450 升序）+ hasMore', () => {
    const page = paginateRunEntries(entries, 200, 1);
    expect(page.loadedCount).toBe(200);
    expect(page.totalCount).toBe(450);
    expect(page.hasMore).toBe(true);
    expect(page.visible[0]!.sequence).toBe(251);
    expect(page.visible[page.visible.length - 1]!.sequence).toBe(450);
  });

  it('第二页：窗口向历史扩展（seq 2..450）+ hasMore 仍真；第三页到尾', () => {
    const page2 = paginateRunEntries(entries, 200, 2);
    expect(page2.loadedCount).toBe(400);
    expect(page2.visible[0]!.sequence).toBe(51);
    expect(page2.hasMore).toBe(true);
    const page3 = paginateRunEntries(entries, 200, 3);
    expect(page3.loadedCount).toBe(450);
    expect(page3.visible[0]!.sequence).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  it('live 窗口滑动：新事件到达后可见窗口保持最新尾部（不丢新事件）', () => {
    const grown = [
      ...entries,
      makeEntry('message-end', 'r-1', 451),
      makeEntry('message-end', 'r-1', 452),
    ];
    const page = paginateRunEntries(grown, 200, 1);
    expect(page.totalCount).toBe(452);
    expect(page.visible[page.visible.length - 1]!.sequence).toBe(452);
    expect(page.visible[0]!.sequence).toBe(253);
  });

  it('条目不足一页 → 全量展示 + hasMore=false；空输入 → 空页', () => {
    const small = paginateRunEntries(entries.slice(0, 50), 200, 1);
    expect(small.loadedCount).toBe(50);
    expect(small.hasMore).toBe(false);
    const empty = paginateRunEntries([], 200, 1);
    expect(empty.visible).toEqual([]);
    expect(empty.loadedCount).toBe(0);
    expect(empty.hasMore).toBe(false);
  });

  it('pagesLoaded 非法值（0/负数）→ 按 1 页兜底', () => {
    const page = paginateRunEntries(entries, 200, 0);
    expect(page.loadedCount).toBe(200);
  });
});

describe('truncatedCountOfRun（F3 §3.4.2 顶部提示数据面）', () => {
  it('只汇总包含本 run 条目的窗口，不把其它 run 的淘汰计入', () => {
    const windows: Record<string, EventWindow> = {
      's-1': {
        entries: [
          makeEntry('agent-start', 'r-1', 1),
          makeEntry('message-end', 'r-1', 2),
        ],
        lastSeq: 2,
        truncatedCount: 30,
      },
      's-2': {
        entries: [makeEntry('agent-start', 'r-2', 1)],
        lastSeq: 1,
        truncatedCount: 999,
      },
    };
    expect(truncatedCountOfRun(windows, 'r-1')).toBe(30);
    expect(truncatedCountOfRun(windows, 'r-2')).toBe(999);
    expect(truncatedCountOfRun(windows, 'r-ghost')).toBe(0);
    expect(truncatedCountOfRun({}, 'r-1')).toBe(0);
  });
});

describe('runControlActionsOf（L2/L3 分级编排，D4 §5.6 / M4 §5.6）', () => {
  it('终态（completed/cancelled/failed）→ 无控制按钮（TerminalImmutable 拒绝）', () => {
    expect(runControlActionsOf(statusOf('completed'), false)).toEqual([]);
    expect(runControlActionsOf(statusOf('cancelled'), false)).toEqual([]);
    expect(runControlActionsOf(statusOf('failed'), true)).toEqual([]);
  });

  it('running → [暂停, 取消]（L2 单点 / L3 二次确认）', () => {
    expect(runControlActionsOf(statusOf('running'), false)).toEqual([
      'pause',
      'cancel',
    ]);
  });

  it('paused（控制回执）→ [恢复, 取消]', () => {
    expect(runControlActionsOf(statusOf('running'), true)).toEqual([
      'resume',
      'cancel',
    ]);
  });

  it('unknown（有事件无 agent-start）→ 仅 [取消]（不猜「在运行」）', () => {
    expect(runControlActionsOf(statusOf('unknown'), false)).toEqual(['cancel']);
  });
});
