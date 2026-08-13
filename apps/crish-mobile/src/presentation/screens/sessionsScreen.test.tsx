// 会话列表页组件测试（R2-05 部分 4：完整行形态 + 交互）
// 真实 sessionStore + eventStore 接线：行渲染（标题）、预览（eventStore 窗口尾部条目）、
// 相对时间、运行状态（activeRunIds）、未读角标（unreadCount，markRead 后消失）、
// 审批角标（pendingApprovalCount > 0 → 「N 待审批」）、点击行 → onOpenSession、
// 点击角标 → onOpenApprovals、空态
// 注：@testing-library/react-native v14 render/fireEvent/act 为异步 API，全部 await；
// 注：updatedAt 用相对真实时钟（Date.now() − 5min）——屏幕用真实 Date.now() 计算相对
// 时间，固定未来时间戳（如 2027）会被时钟偏移容忍按「刚刚」处理（time.ts:8）。
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import SessionsScreen from './sessionsScreen';

function makeSession(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return {
    title: `会话 ${overrides.id}`,
    updatedAt: Date.now() - 5 * 60_000,
    messageCount: 0,
    engineCursor: 0,
    ...overrides,
  };
}

function resetStore() {
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  eventStore.setState({ windows: {}, network: 'live' });
}

beforeEach(() => {
  resetStore();
});

describe('SessionsScreen 会话列表完整形态', () => {
  it('渲染会话行标题（store 驱动）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.getByTestId('session-row-s-1')).toBeTruthy();
    expect(screen.getByText('会话 s-1')).toBeTruthy();
  });

  it('预览来自 eventStore 窗口尾部条目（lastPreviewOfWindow 数据面）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    eventStore.getState().ingest('s-1', {
      type: 'message-delta',
      sessionId: 's-1',
      sequence: 1,
      text: '问题定位在 src/pages/login.tsx',
    });

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    // 尾部为 message-delta（流式增量类型）→ 预览带流式光标（R2UX-05-02 最小接入）；
    // toHaveTextContent 为精确匹配（默认 exact），断言组合串
    expect(screen.getByTestId('session-row-preview')).toHaveTextContent(
      '问题定位在 src/pages/login.tsx ▍'
    );
    expect(screen.getByTestId('session-row-preview-streaming')).toBeTruthy();
  });

  it('无事件窗口的会话不渲染预览行（诚实化）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.queryByTestId('session-row-preview')).toBeNull();
  });

  it('相对时间渲染（updatedAt → 相对文案）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.getByTestId('session-row-time')).toHaveTextContent(
      '5 分钟前'
    );
  });

  it('activeRunIds 非空 → 显示「运行中」指示（agent-start 后，F1 §5.2）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyRunActive('s-1', 'run-1', true);

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.getByTestId('session-row-running')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
  });

  it('pendingApprovalCount > 0 的会话行显示「N 待审批」角标（F2 任务书 R2-04-02）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().upsert(makeSession({ id: 's-2' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    sessionStore.getState().applyApprovalDelta('s-1', 1);

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    // s-1 有 2 项待审批 → 角标；s-2 无待审批 → 无角标
    expect(screen.getByText('2 待审批')).toBeTruthy();
    expect(screen.getAllByTestId('approval-badge')).toHaveLength(1);
    expect(screen.getByTestId('session-row-s-2')).toBeTruthy();
  });

  it('unreadCount > 0 → 未读角标（F5 §6.3 差值派生展示）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    // 未读模型：lastReadSequence=0，最新 seq=3 且为助手消息 → unreadCount=3
    sessionStore.getState().applyLatestSeq('s-1', 3, true);

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.getByTestId('session-unread-badge')).toHaveTextContent('3');
  });

  it('markRead 后未读角标消失（未读清零联动，F5 §6.3）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyLatestSeq('s-1', 3, true);

    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );
    expect(screen.getByTestId('session-unread-badge')).toBeTruthy();

    // 模拟详情打开滚动到底 → markRead（sessionDetailScreen 同款动作）；
    // RNTL v14 act 为异步 API：同步 act 不冲刷渲染 → 角标仍可见（故须 await）
    await act(async () => {
      sessionStore.getState().markRead('s-1', 3);
    });

    expect(screen.queryByTestId('session-unread-badge')).toBeNull();
  });
});

describe('SessionsScreen 点击行为', () => {
  it('点击会话行 → onOpenSession(sessionId)（进入会话详情）', async () => {
    const onOpenSession = jest.fn();
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));

    await render(
      <SessionsScreen
        onOpenApprovals={jest.fn()}
        onOpenSession={onOpenSession}
      />
    );

    await fireEvent.press(screen.getByTestId('session-row-s-1'));
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith('s-1');
  });

  it('点击角标跳转审批列表（onOpenApprovals 被调用）', async () => {
    const onOpenApprovals = jest.fn();
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);

    await render(
      <SessionsScreen
        onOpenApprovals={onOpenApprovals}
        onOpenSession={jest.fn()}
      />
    );

    await fireEvent.press(screen.getByTestId('approval-badge'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('空态：无会话显示「暂无会话」', async () => {
    await render(
      <SessionsScreen onOpenApprovals={jest.fn()} onOpenSession={jest.fn()} />
    );

    expect(screen.getByTestId('sessions-empty')).toBeTruthy();
    expect(screen.getByText('暂无会话')).toBeTruthy();
  });
});
