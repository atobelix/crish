// 页面级渲染与交互测试：会话 / 审批 / 通知 / 文件 / 设置 / 配对。
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement } from 'react';
import type { ApprovalItem } from '@/domain/types/domain';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { approvalStore } from '@/domain/store/approvalStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { notificationStore } from '@/domain/store/notificationStore';
import { ToastProvider } from '@/presentation/ui';
import SessionDetailScreen from './sessionDetailScreen';
import ToolSheetScreen from './toolSheetScreen';
import ApprovalListScreen from './approvalListScreen';
import ApprovalDetailScreen from './approvalDetailScreen';
import NotificationCenterScreen from './notificationCenterScreen';
import FilesScreen from './filesScreen';
import SettingsScreenView from '@/presentation/components/settings/SettingsScreenView';
import PairWelcomeScreen from '@/presentation/pair/pairWelcomeScreen';
import PairManualScreen from '@/presentation/pair/pairManualScreen';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

let currentView: Awaited<ReturnType<typeof render>> | null = null;

async function renderScreen(element: ReactElement) {
  currentView = await render(element, { wrapper: Providers });
  return currentView;
}

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

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
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
    riskMeta: { command: 'write_file src/pages/login.tsx' },
    receivedAtMs: NOW - 30_000,
    expiresAt: NOW + 90_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

function resetStores(): void {
  eventStore.setState({ windows: {}, network: 'live' });
  connectionStore.setState({ phase: 'disconnected' });
  sessionStore.setState({ sessions: [], selectedSessionId: null });
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    lastReconcileAt: null,
    history: [],
  });
  notificationStore.setState({ items: [], unreadCount: 0, hydrated: true });
}

beforeEach(() => {
  resetStores();
});

afterEach(async () => {
  if (currentView) {
    await currentView.unmount();
    currentView = null;
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe('SessionDetailScreen', () => {
  it('渲染消息 / 工具与 composer', async () => {
    sessionStore.setState({ sessions: [session()], selectedSessionId: null });
    const entries = [
      {
        type: 'message-start',
        sessionId: 's-1',
        sequence: 1,
        message: { id: 'm-1', role: 'assistant' },
        receivedAtMs: NOW - 3000,
      },
      {
        type: 'message-end',
        sessionId: 's-1',
        sequence: 2,
        message: {
          id: 'm-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: '登录页的主要问题' }],
        },
        receivedAtMs: NOW - 2000,
      },
      {
        type: 'tool-start',
        sessionId: 's-1',
        sequence: 3,
        call: { id: 't-1', toolName: 'read_file', summary: 'src/a.ts' },
        receivedAtMs: NOW - 1000,
      },
    ];
    for (const entry of entries) {
      eventStore.getState().ingest('s-1', entry as never, false, NOW);
    }
    const onOpenDrawer = jest.fn();
    const onOpenTools = jest.fn();
    const view = await renderScreen(
      <SessionDetailScreen
        sessionId="s-1"
        onOpenDrawer={onOpenDrawer}
        onOpenTools={onOpenTools}
      />
    );
    expect(view.getByText('登录页的主要问题')).toBeTruthy();
    // 工具调用折叠成一行摘要，点按打开工具抽屉并定位到该组
    expect(view.getByText('正在执行 · src/a.ts')).toBeTruthy();
    await fireEvent.press(view.getByTestId('tool-run-t-1'));
    expect(onOpenTools).toHaveBeenCalledWith('t-1');
    await fireEvent.press(view.getByTestId('header-menu'));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('session-composer')).toBeTruthy();
  });
});

describe('ToolSheetScreen', () => {
  function ingestTools(): void {
    const entries = [
      {
        type: 'tool-start',
        sessionId: 's-1',
        sequence: 1,
        call: { id: 't-1', toolName: 'read_file', summary: 'src/a.ts' },
        receivedAtMs: NOW - 2000,
      },
      {
        type: 'tool-end',
        sessionId: 's-1',
        sequence: 2,
        toolCallId: 't-1',
        result: { output: '文件内容' },
        receivedAtMs: NOW - 1500,
      },
      {
        type: 'tool-start',
        sessionId: 's-1',
        sequence: 3,
        call: { id: 't-2', toolName: 'bash', summary: 'npm test' },
        receivedAtMs: NOW - 1000,
      },
    ];
    for (const entry of entries) {
      eventStore.getState().ingest('s-1', entry as never, false, NOW);
    }
  }

  it('列出全部工具调用，运行中显示脉冲点，点行展开输出', async () => {
    sessionStore.setState({ sessions: [session()], selectedSessionId: null });
    ingestTools();
    const view = await renderScreen(<ToolSheetScreen sessionId="s-1" />);
    expect(view.getByTestId('tool-sheet-count')).toHaveTextContent('2');
    expect(view.getByText('read_file')).toBeTruthy();
    expect(view.getByText('npm test')).toBeTruthy();
    expect(view.getByTestId('tool-status-running')).toBeTruthy();
    expect(view.queryByText('文件内容')).toBeNull();
    await fireEvent.press(view.getByTestId('tool-row-t-1'));
    expect(view.getByText('文件内容')).toBeTruthy();
  });

  it('没有工具调用时显示空状态', async () => {
    sessionStore.setState({ sessions: [session()], selectedSessionId: null });
    const view = await renderScreen(<ToolSheetScreen sessionId="s-1" />);
    expect(view.getByText('这个会话还没有工具调用')).toBeTruthy();
  });
});

describe('Approval screens', () => {
  it('列表展示待审批并回调', async () => {
    sessionStore.setState({ sessions: [session()], selectedSessionId: null });
    approvalStore.setState({
      pending: [approval()],
      decisionBusy: {},
      outboxCount: 0,
      lastReconcileAt: NOW,
      history: [],
    });
    const onOpenItem = jest.fn();
    const view = await renderScreen(
      <ApprovalListScreen onOpenItem={onOpenItem} />
    );
    expect(view.getByText('write_file')).toBeTruthy();
    fireEvent.press(view.getByTestId('approval-row-tc-1'));
    expect(onOpenItem).toHaveBeenCalledWith('tc-1');
  });

  it('详情允许提交', async () => {
    approvalStore.setState({
      pending: [approval()],
      decisionBusy: {},
      outboxCount: 0,
      lastReconcileAt: NOW,
      history: [],
    });
    const view = await renderScreen(
      <ApprovalDetailScreen toolCallId="tc-1" onBack={jest.fn()} />
    );
    expect(view.getByText('审批')).toBeTruthy();
    fireEvent.press(view.getByTestId('approval-allow'));
    await waitFor(() =>
      expect(approvalStore.getState().outboxCount).toBeGreaterThan(0)
    );
  });

  it('不存在请求的空态', async () => {
    const view = await renderScreen(
      <ApprovalDetailScreen toolCallId="missing" onBack={jest.fn()} />
    );
    expect(view.getByText('请求不存在或已过期')).toBeTruthy();
  });
});

describe('NotificationCenterScreen', () => {
  it('列表与全部已读', async () => {
    notificationStore.setState({
      hydrated: true,
      items: [
        {
          id: 'n-1',
          kind: 'approval-requested',
          title: '需要确认',
          body: '修改文件',
          route: 'crish://approval/tc-1',
          toolCallId: 'tc-1',
          runId: 'r-1',
          seq: 1,
          status: 'shown',
          receivedAt: NOW,
        },
      ],
      unreadCount: 1,
    });
    const view = await renderScreen(
      <NotificationCenterScreen
        onBack={jest.fn()}
        onOpenNotification={jest.fn()}
      />
    );
    expect(view.getByText('需要确认')).toBeTruthy();
    fireEvent.press(view.getByTestId('mark-all-read'));
    expect(notificationStore.getState().unreadCount).toBe(0);
  });
});

describe('Files / Settings / Pairing', () => {
  it('文件页未连接态', async () => {
    const view = await renderScreen(<FilesScreen />);
    expect(view.getByText('文件')).toBeTruthy();
    expect(view.getByText('未连接')).toBeTruthy();
  });

  it('设置页本地偏好与解除配对入口', async () => {
    const vm: SettingsVm = {
      connected: false,
      host: '192.168.1.2',
      port: 8765,
      themeMode: 'system',
      setThemeMode: jest.fn(),
      notifyMasterOn: true,
      notifyScenes: {
        message: true,
        taskDone: true,
        approval: true,
        error: true,
        deviceOffline: false,
      },
      notifyPermission: 'granted',
      notifySwitchGate: { enabled: true, hint: null },
      setNotifyMasterOn: jest.fn(),
      setNotifyScene: jest.fn(async () => {}),
      removeLocal: jest.fn(async () => {}),
    };
    const view = await renderScreen(
      <SettingsScreenView
        vm={vm}
        onBack={jest.fn()}
        onOpenAccount={jest.fn()}
        onOpenProfile={jest.fn()}
        onConfirmRemove={jest.fn()}
      />
    );
    expect(view.getByText('设置')).toBeTruthy();
    expect(view.getByText('192.168.1.2:8765')).toBeTruthy();
    fireEvent.press(view.getByText('深色'));
    expect(vm.setThemeMode).toHaveBeenCalledWith('dark');
    expect(view.getByText('解除配对')).toBeTruthy();
  });

  it('配对欢迎页主按钮', async () => {
    const onScan = jest.fn();
    const view = await renderScreen(
      <PairWelcomeScreen
        onLogin={jest.fn()}
        onOpenManual={jest.fn()}
        onOpenScan={onScan}
        onEnterApp={jest.fn()}
      />
    );
    fireEvent.press(view.getByTestId('pair-welcome-scan'));
    expect(onScan).toHaveBeenCalled();
  });

  it('手动配对输入校验与提交', async () => {
    const beginPairing = jest.fn(() => ({ ok: true }));
    const controller = {
      beginPairing,
      hydrate: jest.fn(async () => false),
      subscribe: jest.fn(() => () => {}),
      getSnapshot: () => ({
        machine: { state: 'waiting-input' },
        error: null,
        sessionPhase: 'disconnected',
      }),
      reset: jest.fn(),
    } as never;
    const view = await renderScreen(
      <PairManualScreen controller={controller} onBack={jest.fn()} />
    );
    fireEvent.changeText(view.getByTestId('pair-host-input'), '192.168.1.2');
    fireEvent.changeText(view.getByTestId('pair-code-input'), '7K4PQ2MB9XRT');
    await waitFor(() =>
      expect(
        view.getByTestId('pair-connect').props.accessibilityState.disabled
      ).toBe(false)
    );
    fireEvent.press(view.getByTestId('pair-connect'));
    expect(beginPairing).toHaveBeenCalled();
  });
});
