// 抽屉子组件测试：设备状态头、审批两项、会话分组与空态、底部搜索与设置。
import { fireEvent, render } from '@testing-library/react-native';
import type { PermissionRequest } from '@crish/shared-types';
import { approvalStore } from '@/domain/store/approvalStore';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import type { ApprovalItem } from '@/domain/types/domain';
import { DrawerFooter } from './DrawerFooter';
import { DrawerHeader } from './DrawerHeader';
import { DrawerNav } from './DrawerNav';
import { DrawerSessionGroups } from './DrawerSessionGroups';

const NOW = 1_800_000_000_000;

const request: PermissionRequest = {
  id: 'approval-call-1',
  sessionId: 's-1',
  cwd: 'C:\\work',
  toolCallId: 'call-1',
  toolName: 'write_file',
  parameters: { path: 'a.ts' },
  summary: 'write a.ts',
  toolMetadata: {},
};

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    request,
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: NOW,
    expiresAt: NOW + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '修复登录页样式',
    updatedAt: NOW,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('DrawerHeader', () => {
  it('未登录时显示「本机」与连接状态，点新对话回调', async () => {
    connectionStore.setState({ phase: 'ready' });
    authStore.setState({ host: '192.168.1.2' });
    const onNewChat = jest.fn();
    const view = await render(<DrawerHeader onNewChat={onNewChat} />);
    expect(view.getByText('本机')).toBeTruthy();
    expect(view.getByText(/192\.168\.1\.2/)).toBeTruthy();
    await fireEvent.press(view.getByTestId('drawer-new-chat'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe('DrawerNav', () => {
  it('无用户待审批时不显示计数', async () => {
    approvalStore.setState({ pending: [approval({ arbiter: 'main-agent' })] });
    const view = await render(
      <DrawerNav onOpenApprovals={jest.fn()} onOpenHistory={jest.fn()} />
    );
    expect(view.queryByTestId('drawer-approvals-count')).toBeNull();
  });

  it('有用户待审批时显示计数，两项各自跳转', async () => {
    approvalStore.setState({
      pending: [approval(), approval({ status: 'queued' })],
    });
    const onOpenApprovals = jest.fn();
    const onOpenHistory = jest.fn();
    const view = await render(
      <DrawerNav
        onOpenApprovals={onOpenApprovals}
        onOpenHistory={onOpenHistory}
      />
    );
    expect(view.getByTestId('drawer-approvals-count')).toBeTruthy();
    expect(view.getByText('2')).toBeTruthy();
    await fireEvent.press(view.getByTestId('drawer-approvals'));
    await fireEvent.press(view.getByTestId('drawer-approval-history'));
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });
});

describe('DrawerSessionGroups', () => {
  const base = {
    hasSessions: true,
    connected: true,
    selectedSessionId: 's-2',
    onOpenSession: jest.fn(),
  };

  it('分「今天 / 更早」两组，空组不渲染标题', async () => {
    const view = await render(
      <DrawerSessionGroups
        {...base}
        today={[session()]}
        earlier={[session({ id: 's-2', title: '更早的会话' })]}
      />
    );
    expect(view.getByText('今天')).toBeTruthy();
    expect(view.getByText('更早')).toBeTruthy();
    expect(
      view.getByTestId('session-row-s-2').props.accessibilityState
    ).toEqual({ selected: true });

    await view.rerender(
      <DrawerSessionGroups {...base} today={[session()]} earlier={[]} />
    );
    expect(view.queryByText('更早')).toBeNull();
  });

  it.each([
    [true, true, '没有匹配的会话'],
    [false, true, '还没有会话'],
    [false, false, '正在同步会话…'],
  ])('空态 hasSessions=%s connected=%s → %s', async (has, connected, text) => {
    const view = await render(
      <DrawerSessionGroups
        {...base}
        hasSessions={has}
        connected={connected}
        today={[]}
        earlier={[]}
      />
    );
    expect(view.getByText(text)).toBeTruthy();
  });
});

describe('DrawerFooter', () => {
  it('搜索输入回传关键词，设置圆钮回调', async () => {
    const onChangeQuery = jest.fn();
    const onOpenSettings = jest.fn();
    const view = await render(
      <DrawerFooter
        query=""
        onChangeQuery={onChangeQuery}
        onOpenSettings={onOpenSettings}
        bottomInset={0}
      />
    );
    await fireEvent.changeText(view.getByTestId('drawer-search'), '登录');
    await fireEvent.press(view.getByTestId('drawer-settings'));
    expect(onChangeQuery).toHaveBeenCalledWith('登录');
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
