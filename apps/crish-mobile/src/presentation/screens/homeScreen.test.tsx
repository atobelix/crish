// 主屏测试：问候、空态、平铺会话列表（状态/时间/摘要）、更多下拉与提交回执。
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { RunTaskParams, RunTaskResult } from '@crish/shared-types';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { authStore } from '@/domain/store/authStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { notificationStore } from '@/domain/store/notificationStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { ToastProvider } from '@/presentation/ui';
import HomeScreen, { greetingFor } from './homeScreen';

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

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's-1',
    title: '修复登录页样式',
    folder: '常规会话',
    isPinned: false,
    isArchived: false,
    timestamp: '',
    updatedAt: NOW - 60_000,
    messageCount: 2,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    ...overrides,
  };
}

function renderHome(props: Partial<Parameters<typeof HomeScreen>[0]> = {}) {
  return render(
    <HomeScreen
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
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  eventStore.setState({ windows: {}, network: 'live' });
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

describe('HomeScreen 空态', () => {
  it('在线时显示设备胶囊与问候，不显示断线横幅', async () => {
    const view = await renderHome();
    expect(view.getByTestId('device-pill')).toBeTruthy();
    expect(view.getByText('192.168.1.2')).toBeTruthy();
    expect(view.getByText('今天想让它做点什么？')).toBeTruthy();
    expect(view.queryByLabelText('重新连接')).toBeNull();
  });

  it('未连接时显示断线横幅，输入框不可编辑', async () => {
    connectionStore.setState({ phase: 'disconnected', lastError: null });
    const view = await renderHome();
    expect(view.getByLabelText('重新连接')).toBeTruthy();
    expect(view.getByTestId('home-composer').props.editable).toBe(false);
  });
});

describe('HomeScreen 平铺会话列表', () => {
  it('渲染标题 / 时间 / 摘要，点按回调会话 id', async () => {
    sessionStore.setState({ sessions: [session()] });
    eventStore.getState().ingest(
      's-1',
      {
        type: 'message-end',
        sessionId: 's-1',
        sequence: 1,
        message: {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '登录页的主要问题已定位' }],
        },
      } as never,
      false,
      NOW
    );
    const onOpenSession = jest.fn();
    const view = await renderHome({ onOpenSession });
    expect(view.getByTestId('home-chat-list')).toBeTruthy();
    expect(view.getByText('修复登录页样式')).toBeTruthy();
    expect(view.getByText('登录页的主要问题已定位')).toBeTruthy();
    await fireEvent.press(view.getByTestId('chat-item-s-1'));
    expect(onOpenSession).toHaveBeenCalledWith('s-1');
  });

  it('待审批会话渲染橙点 + 文案，运行中渲染灰环', async () => {
    sessionStore.setState({
      sessions: [
        session({ id: 's-run', title: '运行中会话', activeRunIds: ['r-1'] }),
        session({
          id: 's-approval',
          title: '待审批会话',
          pendingApprovalCount: 2,
        }),
      ],
    });
    const view = await renderHome();
    expect(view.getByTestId('chat-item-running')).toBeTruthy();
    expect(view.getByTestId('chat-item-pending')).toBeTruthy();
    expect(view.getByText('待审批')).toBeTruthy();
  });
});

describe('HomeScreen 更多下拉', () => {
  it('展开后可进入通知中心与偏好设置', async () => {
    const onOpenNotifications = jest.fn();
    const view = await renderHome({ onOpenNotifications });
    await fireEvent.press(view.getByTestId('home-more'));
    await fireEvent.press(view.getByTestId('home-menu-notifications'));
    expect(onOpenNotifications).toHaveBeenCalledTimes(1);
  });
});

describe('HomeScreen 附件入口（G5b）', () => {
  it('Composer 渲染 ＋ 附件钮，点开附件面板呈现拍照/相册/文件三入口', async () => {
    const view = await renderHome();
    const attachButton = view.getByLabelText('添加附件');
    expect(attachButton).toBeTruthy();
    await fireEvent.press(attachButton);
    expect(view.getByTestId('home-attachment-sheet-camera')).toBeTruthy();
    expect(view.getByTestId('home-attachment-sheet-library')).toBeTruthy();
    expect(view.getByTestId('home-attachment-sheet-files')).toBeTruthy();
    expect(view.getByText('拍照')).toBeTruthy();
    expect(view.getByText('相册')).toBeTruthy();
    expect(view.getByText('文件')).toBeTruthy();
  });
});

describe('HomeScreen 提交', () => {
  it('提交后新建会话（不带 sessionId），成功回执跳转到该会话', async () => {
    mockRunTask.mockResolvedValue({ runId: 'r-9', sessionId: 's-9' });
    const onOpenSession = jest.fn();
    const view = await renderHome({ onOpenSession });
    await fireEvent.changeText(
      view.getByTestId('home-composer'),
      '整理一下登录页'
    );
    await act(async () => {
      await fireEvent.press(view.getByTestId('home-composer-send'));
    });
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('s-9'));
    expect(mockRunTask).toHaveBeenCalledWith({
      prompt: '整理一下登录页',
      // G1：权限改读持久化偏好，默认 smart（与桌面 DEFAULT_PERMISSION_MODE 一致）
      permissionMode: 'smart',
    });
  });
});
