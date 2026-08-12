// 会话详情页组件测试（R2-05 部分 3 验收：行渲染 / 自动滚动切换 / 空态 / 未读清零）
// - 真实 eventStore + sessionStore：挂载读选择器（windowOf 数据面）→ 事件行渲染；
// - 自动滚底切换（R2UX-05-03）：上翻超吸底阈值 → onFollowChange(false) → 「回到底部」
//   悬浮条出现；点击 → scrollToEnd + 恢复跟随（悬浮条消失）；
// - 未读清零（F5 §6.3）：详情打开且跟随底部 → markRead(sessionId, lastSeq) 只升不降；
// - 空态由 EventFeed 承接（M4 §5.9 文案）；会话元信息头（名称/状态/游标/网络相位）。
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { FlatList } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedEntry, EventWindow } from '@/domain/store/eventReducers';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { AUTO_FOLLOW_THRESHOLD_DP } from '@/presentation/components/blocks/EventFeed';
import SessionDetailScreen from './sessionDetailScreen';

function makeEntry(
  type: string,
  overrides: Record<string, unknown> = {},
  receivedAtMs = 1_000
): FeedEntry {
  return {
    type,
    sessionId: 's-1',
    receivedAtMs,
    ...overrides,
  } as FeedEntry;
}

function windowOf(entries: FeedEntry[], lastSeq = 0): EventWindow {
  return { entries, lastSeq, truncatedCount: 0 };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '测试会话',
    updatedAt: 1_000,
    receivedAtMs: 1_000,
    lastReadSequence: 0,
    unreadCount: 2,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function scrollEvent(distanceFromEnd: number) {
  return {
    nativeEvent: {
      contentOffset: { y: 0, x: 0 },
      contentSize: { height: 1000 + distanceFromEnd, width: 320 },
      layoutMeasurement: { height: 1000, width: 320 },
    },
  };
}

beforeEach(() => {
  eventStore.setState({ windows: {}, network: 'live' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
});

describe('会话详情页事件流（F3 §3.1 主形态 feed）', () => {
  it('事件行渲染：EventRow 摘要 + 错误行红色标记（testID）', async () => {
    eventStore.setState({
      windows: {
        's-1': windowOf(
          [
            makeEntry(
              'message-end',
              { text: '最终正文', runId: 'run-1' },
              1_000
            ),
            makeEntry(
              'tool-start',
              { toolName: 'bash', runId: 'run-1' },
              2_000
            ),
            makeEntry(
              'runtime-error',
              { error: '权限不足', runId: 'run-1' },
              3_000
            ),
          ],
          3
        ),
      },
    });
    await render(<SessionDetailScreen sessionId="s-1" />);

    expect(screen.getByText('消息完成（run run-1）')).toBeTruthy();
    expect(screen.getByText('工具 bash 启动（run run-1）')).toBeTruthy();
    expect(screen.getByText('运行错误：权限不足')).toBeTruthy();
    // 错误行独立 testID（F3 §3.3.3 错误高亮数据面）
    expect(screen.getByTestId('event-row-error')).toBeTruthy();
    expect(screen.getAllByTestId('event-row').length).toBeGreaterThanOrEqual(2);
  });

  it('空态：无事件窗口 → 主文案 + 副文案（M4 §5.9，禁「0 误导」）', async () => {
    await render(<SessionDetailScreen sessionId="s-1" />);

    expect(screen.getByTestId('feed-empty')).toBeTruthy();
    expect(screen.getByText('暂无事件')).toBeTruthy();
    expect(
      screen.getByText('桌面端 run 执行时，这里会实时更新事件流（F1 §4.7）')
    ).toBeTruthy();
  });

  it('会话元信息头：名称 / 状态 / 游标 / 网络相位（F1 §4.3）', async () => {
    sessionStore.setState({
      sessions: [makeSummary({ activeRunIds: ['run-1'] })],
      selectedSessionId: 's-1',
    });
    eventStore.setState({
      windows: {
        's-1': windowOf([makeEntry('agent-start', { runId: 'run-1' })], 7),
      },
    });
    await render(<SessionDetailScreen sessionId="s-1" />);

    expect(screen.getByTestId('session-detail-name')).toHaveTextContent(
      '测试会话'
    );
    expect(screen.getByTestId('session-detail-meta')).toHaveTextContent(
      '运行中 · 已同步 #7 · 实时'
    );
  });
});

describe('会话详情页自动滚动跟随（R2UX-05-03）', () => {
  function seedWindow() {
    eventStore.setState({
      windows: {
        's-1': windowOf(
          [
            makeEntry(
              'tool-start',
              { toolName: 'bash', runId: 'run-1' },
              1_000
            ),
            makeEntry('message-end', { text: 'ok', runId: 'run-1' }, 2_000),
          ],
          2
        ),
      },
    });
  }

  it('上翻超吸底阈值 → 暂停跟随 + 「回到底部」悬浮条出现', async () => {
    seedWindow();
    await render(<SessionDetailScreen sessionId="s-1" />);
    expect(screen.queryByTestId('session-back-to-bottom')).toBeNull();

    await fireEvent.scroll(
      screen.getByTestId('event-feed-list'),
      scrollEvent(AUTO_FOLLOW_THRESHOLD_DP + 1)
    );

    expect(screen.getByTestId('session-back-to-bottom')).toBeTruthy();
  });

  it('点击「回到底部」→ scrollToEnd + 恢复跟随（悬浮条消失）', async () => {
    const spy = jest
      .spyOn(FlatList.prototype, 'scrollToEnd')
      .mockImplementation(() => {});
    try {
      seedWindow();
      await render(<SessionDetailScreen sessionId="s-1" />);
      await fireEvent.scroll(
        screen.getByTestId('event-feed-list'),
        scrollEvent(AUTO_FOLLOW_THRESHOLD_DP + 1)
      );
      expect(screen.getByTestId('session-back-to-bottom')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('session-back-to-bottom'));

      expect(spy).toHaveBeenCalled();
      expect(screen.queryByTestId('session-back-to-bottom')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('滚回底部（阈值内）→ 跟随自动恢复（悬浮条消失）', async () => {
    seedWindow();
    await render(<SessionDetailScreen sessionId="s-1" />);

    await fireEvent.scroll(
      screen.getByTestId('event-feed-list'),
      scrollEvent(AUTO_FOLLOW_THRESHOLD_DP + 1)
    );
    expect(screen.getByTestId('session-back-to-bottom')).toBeTruthy();

    await fireEvent.scroll(
      screen.getByTestId('event-feed-list'),
      scrollEvent(AUTO_FOLLOW_THRESHOLD_DP - 1)
    );

    expect(screen.queryByTestId('session-back-to-bottom')).toBeNull();
  });
});

describe('会话详情页未读清零（F5 §6.3）', () => {
  it('详情打开且跟随底部 → markRead(sessionId, lastSeq) 游标前移', async () => {
    sessionStore.setState({
      sessions: [makeSummary({ lastReadSequence: 0, unreadCount: 5 })],
      selectedSessionId: 's-1',
    });
    eventStore.setState({
      windows: {
        's-1': windowOf([makeEntry('message-end', { text: 'ok' }, 1_000)], 9),
      },
    });
    await render(<SessionDetailScreen sessionId="s-1" />);

    expect(sessionStore.getState().sessions[0]?.lastReadSequence).toBe(9);
    expect(sessionStore.getState().sessions[0]?.unreadCount).toBe(0);
  });

  it('lastSeq = 0（无已确认帧）不清零（只处理真实游标）', async () => {
    sessionStore.setState({
      sessions: [makeSummary({ lastReadSequence: 0, unreadCount: 3 })],
      selectedSessionId: 's-1',
    });
    await render(<SessionDetailScreen sessionId="s-1" />);

    expect(sessionStore.getState().sessions[0]?.lastReadSequence).toBe(0);
    expect(sessionStore.getState().sessions[0]?.unreadCount).toBe(3);
  });
});
