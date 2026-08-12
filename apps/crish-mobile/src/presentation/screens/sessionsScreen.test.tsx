// 会话列表页组件测试（R2-04 任务书第 2 点：会话审批角标）
// 真实 sessionStore 接线：行渲染（标题）、角标显示（pendingApprovalCount > 0 → 「N 待审批」）、
// 无待审批会话不显示角标、点击角标/行跳转审批列表（onOpenApprovals）、空态
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SessionIndexEntry } from '../../../../../packages/shared-types/src/generated/device/types';
import { sessionStore } from '@/domain/store/sessionStore';
import SessionsScreen from './sessionsScreen';

function makeSession(
  overrides: Partial<SessionIndexEntry> & { id: string }
): SessionIndexEntry {
  return {
    title: `会话 ${overrides.id}`,
    updatedAt: 1_800_000_000_000,
    messageCount: 0,
    engineCursor: 0,
    ...overrides,
  };
}

function resetStore() {
  sessionStore.setState({ sessions: [], selectedSessionId: null });
}

beforeEach(() => {
  resetStore();
});

describe('SessionsScreen 会话列表 + 审批角标', () => {
  it('渲染会话行标题（store 驱动）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    await render(<SessionsScreen onOpenApprovals={jest.fn()} />);

    expect(screen.getByTestId('session-row-s-1')).toBeTruthy();
    expect(screen.getByText('会话 s-1')).toBeTruthy();
  });

  it('pendingApprovalCount > 0 的会话行显示「N 待审批」角标（F2 任务书 R2-04-02）', async () => {
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().upsert(makeSession({ id: 's-2' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);
    sessionStore.getState().applyApprovalDelta('s-1', 1);

    await render(<SessionsScreen onOpenApprovals={jest.fn()} />);

    // s-1 有 2 项待审批 → 角标；s-2 无待审批 → 无角标
    expect(screen.getByText('2 待审批')).toBeTruthy();
    expect(screen.getAllByTestId('approval-badge')).toHaveLength(1);
    expect(screen.getByTestId('session-row-s-2')).toBeTruthy();
  });

  it('点击角标跳转审批列表（onOpenApprovals 被调用）', async () => {
    const onOpenApprovals = jest.fn();
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));
    sessionStore.getState().applyApprovalDelta('s-1', 1);

    await render(<SessionsScreen onOpenApprovals={onOpenApprovals} />);

    await fireEvent.press(screen.getByTestId('approval-badge'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('点击会话行跳转审批列表（onOpenApprovals 被调用）', async () => {
    const onOpenApprovals = jest.fn();
    sessionStore.getState().upsert(makeSession({ id: 's-1' }));

    await render(<SessionsScreen onOpenApprovals={onOpenApprovals} />);

    await fireEvent.press(screen.getByTestId('session-row-s-1'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('空态：无会话显示「暂无会话」', async () => {
    await render(<SessionsScreen onOpenApprovals={jest.fn()} />);

    expect(screen.getByTestId('sessions-empty')).toBeTruthy();
    expect(screen.getByText('暂无会话')).toBeTruthy();
  });
});
