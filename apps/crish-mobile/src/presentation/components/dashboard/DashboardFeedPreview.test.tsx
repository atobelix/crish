// 首页最近动态预览组件测试（F1 §4.3 · R4 批次3）：
// 无会话不渲染 / 标题回退 id / 空动态文案 / EventRow 复用渲染 / 查看全部上抛
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedEntry } from '@/domain/store/eventReducers';
import { DashboardFeedPreview } from './DashboardFeedPreview';

function makeEntry(sequence: number): FeedEntry {
  return {
    type: 'message-end',
    sessionId: 's-1',
    sequence,
    receivedAtMs: 1000 + sequence,
    text: `消息 ${sequence}`,
  } as FeedEntry;
}

describe('DashboardFeedPreview', () => {
  it('无会话（sessionId null）→ 不渲染', async () => {
    await render(
      <DashboardFeedPreview
        sessionId={null}
        sessionTitle={null}
        entries={[]}
        onOpenSession={jest.fn()}
      />
    );
    expect(screen.toJSON()).toBeNull();
  });

  it('标题缺省回退会话 id；查看全部上抛 sessionId', async () => {
    const onOpenSession = jest.fn();
    await render(
      <DashboardFeedPreview
        sessionId="s-9"
        sessionTitle={null}
        entries={[]}
        onOpenSession={onOpenSession}
      />
    );
    expect(screen.getByText('s-9')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('dashboard-feed-open'));
    expect(onOpenSession).toHaveBeenCalledWith('s-9');
  });

  it('空动态 → 引导文案；有动态 → EventRow 渲染（复用行组件）', async () => {
    const { rerender } = await render(
      <DashboardFeedPreview
        sessionId="s-1"
        sessionTitle="重构任务"
        entries={[]}
        onOpenSession={jest.fn()}
      />
    );
    expect(screen.getByText(/暂无动态/)).toBeTruthy();

    await rerender(
      <DashboardFeedPreview
        sessionId="s-1"
        sessionTitle="重构任务"
        entries={[makeEntry(1), makeEntry(2)]}
        onOpenSession={jest.fn()}
      />
    );
    expect(screen.getByText('重构任务')).toBeTruthy();
    expect(screen.getAllByTestId('event-row')).toHaveLength(2);
  });
});
