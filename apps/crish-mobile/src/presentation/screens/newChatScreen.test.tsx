// 新对话页测试：问候、头栏入口、汉堡待审批提示点、提交后跳转新会话。
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { RunTaskParams, RunTaskResult } from '@crish/shared-types';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { notificationStore } from '@/domain/store/notificationStore';
import { ToastProvider } from '@/presentation/ui';
import NewChatScreen, { greetingFor } from './newChatScreen';

const mockRunTask = jest.fn<Promise<RunTaskResult>, [RunTaskParams]>();

jest.mock('@/adapters/quickRunWiring', () => ({
  ...jest.requireActual('@/adapters/quickRunWiring'),
  getQuickRunContext: () => ({ repository: { runTask: mockRunTask } }),
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = 1_800_000_000_000;

const approval: ApprovalItem = {
  request: {
    id: 'pr-1',
    sessionId: 's-1',
    cwd: 'C:/proj',
    toolCallId: 'tc-1',
    toolName: 'write_file',
    parameters: { path: 'src/pages/login.tsx' },
    summary: '修改登录页样式',
    toolMetadata: {},
  },
  runId: 'r-1',
  arbiter: 'user',
  dangerLevel: 1,
  receivedAtMs: NOW - 30_000,
  expiresAt: NOW + 90_000,
  status: 'pending',
  decisionStatus: 'idle',
  decisionBusy: false,
};

function renderNewChat(
  props: Partial<Parameters<typeof NewChatScreen>[0]> = {}
) {
  return render(
    <NewChatScreen
      onOpenDrawer={jest.fn()}
      onOpenNotifications={jest.fn()}
      onOpenSession={jest.fn()}
      {...props}
    />,
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider initialMetrics={metrics}>
          <ToastProvider>{children}</ToastProvider>
        </SafeAreaProvider>
      ),
    }
  );
}

beforeEach(() => {
  mockRunTask.mockReset();
  connectionStore.setState({ phase: 'ready', lastError: null });
  authStore.setState({ host: '192.168.1.2' });
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    lastReconcileAt: null,
    history: [],
  });
  notificationStore.setState({ items: [], unreadCount: 0, hydrated: true });
});

describe('greetingFor', () => {
  it.each([
    [3, '夜深了'],
    [9, '早上好'],
    [14, '下午好'],
    [21, '晚上好'],
  ])('%i 点 → %s', (hour, text) => {
    expect(greetingFor(hour)).toBe(text);
  });
});

describe('NewChatScreen', () => {
  it('在线时显示设备胶囊与问候副行，不显示断线条', async () => {
    const view = await renderNewChat();
    expect(view.getByText('电脑在线 · 192.168.1.2')).toBeTruthy();
    expect(view.getByText('今天想让它做点什么？')).toBeTruthy();
    expect(view.queryByLabelText('重新连接')).toBeNull();
  });

  it('未连接时显示断线条，输入框不可编辑', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderNewChat();
    expect(view.getByLabelText('重新连接')).toBeTruthy();
    expect(view.getByTestId('new-chat-composer').props.editable).toBe(false);
  });

  it('汉堡与铃铛回调；有用户待审批时汉堡带提示点', async () => {
    approvalStore.setState({ pending: [approval] });
    const onOpenDrawer = jest.fn();
    const onOpenNotifications = jest.fn();
    const view = await renderNewChat({ onOpenDrawer, onOpenNotifications });
    expect(view.getByTestId('header-menu-dot')).toBeTruthy();
    await fireEvent.press(view.getByTestId('header-menu'));
    await fireEvent.press(view.getByTestId('new-chat-notifications'));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
  });

  it('提交后新建会话（不带 sessionId），成功回执跳转到该会话', async () => {
    mockRunTask.mockResolvedValue({ runId: 'r-9', sessionId: 's-9' });
    const onOpenSession = jest.fn();
    const view = await renderNewChat({ onOpenSession });
    await fireEvent.changeText(
      view.getByTestId('new-chat-composer'),
      '整理一下登录页'
    );
    await act(async () => {
      await fireEvent.press(view.getByTestId('new-chat-composer-send'));
    });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-9'));
    expect(mockRunTask).toHaveBeenCalledWith({
      prompt: '整理一下登录页',
      permissionMode: 'ask',
    });
  });
});
