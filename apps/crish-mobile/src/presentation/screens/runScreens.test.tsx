// 运行 / 终端页面测试。
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { ToastProvider } from '@/presentation/ui';
import RunDetailScreen from './runDetailScreen';
import TerminalScreen from './terminalScreen';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = 1_800_000_000_000;
const session: SessionSummary = {
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
};

const entries = [
  {
    type: 'agent-start',
    sessionId: 's-1',
    sequence: 1,
    runId: 'r-1',
    receivedAtMs: NOW - 10_000,
  },
  {
    type: 'message-end',
    sessionId: 's-1',
    sequence: 2,
    runId: 'r-1',
    message: {
      id: 'm-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '运行输出' }],
    },
    receivedAtMs: NOW - 5000,
  },
  {
    type: 'tool-end',
    sessionId: 's-1',
    sequence: 3,
    runId: 'r-1',
    toolName: 'shell',
    result: { output: 'done' },
    receivedAtMs: NOW - 4000,
  },
];

function renderWithProviders(element: React.ReactElement) {
  return render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

beforeEach(() => {
  eventStore.setState({ windows: {}, network: 'live' });
  sessionStore.setState({ sessions: [session], selectedSessionId: null });
  for (const entry of entries) {
    eventStore.getState().ingest('s-1', entry as never, false, NOW);
  }
});

describe('RunDetailScreen', () => {
  it('展示状态与时间线', async () => {
    const view = await renderWithProviders(
      <RunDetailScreen runId="r-1" onBack={jest.fn()} />
    );
    expect(view.getByText('运行')).toBeTruthy();
    expect(view.getByText('运行中')).toBeTruthy();
    expect(view.getByText('运行输出')).toBeTruthy();
  });
});

describe('TerminalScreen', () => {
  it('展示状态与终端', async () => {
    const view = await renderWithProviders(
      <TerminalScreen runId="r-1" onBack={jest.fn()} />
    );
    expect(view.getByText('终端')).toBeTruthy();
    expect(view.getByText('运行中')).toBeTruthy();
  });
});
