// RunDetailTimeline 组件测试（R2-05 部分 6 / R2UX-05-08 游标分页）：
// - 分页渲染：>200 条时展示最新 200 条窗口尾部（FlatList data 断言，避免
//   虚拟化渲染差异）+ 「加载更早（已显示 N/M）」按钮；逐页扩展至「已全部加载」；
// - 少量条目：无加载按钮 + 「已全部加载（共 N 条）」；
// - 环形淘汰提示（F3 §3.4.2）：truncatedCount > 0 顶部提示条；
// - 复用 EventFeed/EventRow：条目经 EventRow 渲染摘要（F3 §6.3 人话摘要）。
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { RunDetailTimeline, RUN_EVENTS_PAGE_SIZE } from './RunDetailTimeline';

function makeEntry(
  type: string,
  runId: string,
  sequence: number,
  overrides: Record<string, unknown> = {}
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    runId,
    sequence,
    receivedAtMs: 1_000 + sequence,
    ...overrides,
  } as FeedEntry;
}

function runEntries(count: number, runId = 'r-1'): FeedEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeEntry('message-end', runId, i + 1)
  );
}

function listData(): FeedEntry[] {
  const list = screen.getByTestId('event-feed-list');
  return (list.props.data ?? []) as FeedEntry[];
}

describe('游标分页（R2UX-05-08：200/页）', () => {
  it('≤200 条：全量展示 + 无加载按钮 + 「已全部加载（共 N 条）」', async () => {
    const entries = runEntries(3);
    await render(
      <RunDetailTimeline runId="r-1" entriesAsc={entries} truncatedCount={0} />
    );
    expect(listData()).toHaveLength(3);
    expect(screen.queryByTestId('run-timeline-load-more')).toBeNull();
    expect(screen.getByTestId('run-timeline-all-loaded')).toHaveTextContent(
      '已全部加载（共 3 条）'
    );
  });

  it('>200 条：展示最新 200 条窗口尾部（seq 升序）+ 加载按钮计数', async () => {
    const entries = runEntries(450);
    await render(
      <RunDetailTimeline runId="r-1" entriesAsc={entries} truncatedCount={0} />
    );
    const first = listData();
    expect(first).toHaveLength(RUN_EVENTS_PAGE_SIZE);
    expect(first[0]!.sequence).toBe(251);
    expect(first[first.length - 1]!.sequence).toBe(450);
    expect(screen.getByTestId('run-timeline-load-more')).toHaveTextContent(
      '加载更早（已显示 200/450）'
    );
  });

  it('点「加载更早」逐页扩展：200 → 400 → 450（按钮随 hasMore 消失）', async () => {
    const entries = runEntries(450);
    await render(
      <RunDetailTimeline runId="r-1" entriesAsc={entries} truncatedCount={0} />
    );
    await fireEvent.press(screen.getByTestId('run-timeline-load-more'));
    expect(listData()).toHaveLength(400);
    expect(listData()[0]!.sequence).toBe(51);
    expect(screen.getByTestId('run-timeline-load-more')).toHaveTextContent(
      '加载更早（已显示 400/450）'
    );
    await fireEvent.press(screen.getByTestId('run-timeline-load-more'));
    expect(listData()).toHaveLength(450);
    expect(listData()[0]!.sequence).toBe(1);
    expect(screen.queryByTestId('run-timeline-load-more')).toBeNull();
    expect(screen.getByTestId('run-timeline-all-loaded')).toHaveTextContent(
      '已全部加载（共 450 条）'
    );
  });

  it('live 窗口滑动：新事件到达后可见窗口保持最新尾部（不丢新事件）', async () => {
    const { rerender } = await render(
      <RunDetailTimeline
        runId="r-1"
        entriesAsc={runEntries(210)}
        truncatedCount={0}
      />
    );
    expect(listData()[listData().length - 1]!.sequence).toBe(210);
    // 新事件到达（总 215 条）→ 窗口仍展示最新 200 条
    await rerender(
      <RunDetailTimeline
        runId="r-1"
        entriesAsc={runEntries(215)}
        truncatedCount={0}
      />
    );
    const data = listData();
    expect(data).toHaveLength(200);
    expect(data[data.length - 1]!.sequence).toBe(215);
  });
});

describe('环形淘汰提示（F3 §3.4.2 / R2UX-05-09）', () => {
  it('truncatedCount > 0 → 顶部提示条展示淘汰计数', async () => {
    await render(
      <RunDetailTimeline
        runId="r-1"
        entriesAsc={runEntries(5)}
        truncatedCount={120}
      />
    );
    expect(screen.getByTestId('run-timeline-truncated')).toHaveTextContent(
      /已收起 120 条早期事件/
    );
  });

  it('truncatedCount = 0 → 无提示条', async () => {
    await render(
      <RunDetailTimeline
        runId="r-1"
        entriesAsc={runEntries(5)}
        truncatedCount={0}
      />
    );
    expect(screen.queryByTestId('run-timeline-truncated')).toBeNull();
  });
});

describe('复用 EventFeed/EventRow（F3 §6.3 人话摘要）', () => {
  it('条目经 EventRow 渲染摘要 + 过滤条存在（runOnly 恒开指示器）', async () => {
    const entries = [
      makeEntry('agent-start', 'r-1', 1),
      makeEntry('tool-start', 'r-1', 2, { toolName: 'bash' }),
      makeEntry('message-end', 'r-1', 3),
    ];
    await render(
      <RunDetailTimeline runId="r-1" entriesAsc={entries} truncatedCount={0} />
    );
    expect(screen.getByText('Agent 开始执行（run r-1）')).toBeTruthy();
    expect(screen.getByText('工具 bash 启动（run r-1）')).toBeTruthy();
    expect(screen.getByTestId('feed-filter-errors')).toBeTruthy();
    expect(screen.getByTestId('feed-filter-run')).toBeTruthy();
    expect(screen.getByTestId('feed-filter-tools')).toBeTruthy();
  });
});
