// 全局审批悬浮卡：隐藏路由、L1 直接决策、L2 跳滑动确认、多条入队列、收起成胶囊、点空白回会话。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ApprovalItem } from '@/domain/types/domain';
import { approvalStore } from '@/domain/store/approvalStore';
import { resetApprovalOutboxForTest } from '@/adapters/viewmodels/useApprovalDetailVm';
import { ApprovalFloat } from './ApprovalFloat';

let mockPathname = '/';
const mockPush = jest.fn();
const mockNavigate = jest.fn();

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  router: {
    push: (href: string) => mockPush(href),
    navigate: (href: string) => mockNavigate(href),
  },
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function makeItem(
  toolCallId: string,
  overrides: Partial<ApprovalItem> = {}
): ApprovalItem {
  const now = Date.now();
  return {
    request: {
      id: `approval-${toolCallId}`,
      sessionId: 's-1',
      cwd: 'C:/proj',
      toolCallId,
      toolName: 'write_file',
      parameters: { path: 'src/login.tsx' },
      summary: '修改登录页',
      toolMetadata: {},
    },
    runId: 'r-1',
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: now,
    expiresAt: now + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

function seed(pending: ApprovalItem[]) {
  approvalStore.setState({
    pending,
    decisionBusy: {},
    outboxCount: 0,
    lastReconcileAt: null,
    history: [],
  });
}

function renderFloat() {
  return render(<ApprovalFloat />, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
    ),
  });
}

beforeEach(() => {
  mockPathname = '/';
  mockPush.mockReset();
  mockNavigate.mockReset();
  resetApprovalOutboxForTest();
  seed([]);
});

describe('ApprovalFloat', () => {
  it('无待审批时不渲染', async () => {
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-card')).toBeNull();
  });

  it('隐藏路由下不渲染', async () => {
    seed([makeItem('tc-1')]);
    mockPathname = '/settings';
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-card')).toBeNull();
    expect(view.queryByTestId('approval-float-pill')).toBeNull();
  });

  it('L1：卡内直接允许，条目进入待发送', async () => {
    seed([makeItem('tc-1')]);
    const view = await renderFloat();
    expect(view.getByText('write_file')).toBeTruthy();
    expect(view.queryByTestId('approval-float-review')).toBeNull();
    await fireEvent.press(view.getByTestId('approval-float-allow'));
    expect(approvalStore.getState().pending[0]?.status).toBe('queued');
  });

  it('L2：只给查看并滑动确认，跳审批弹窗', async () => {
    seed([makeItem('tc-2', { dangerLevel: 2 })]);
    const view = await renderFloat();
    expect(view.queryByTestId('approval-float-allow')).toBeNull();
    await fireEvent.press(view.getByTestId('approval-float-review'));
    expect(mockPush).toHaveBeenCalledWith('/approval/tc-2');
  });

  it('多条：「还有 N 个」打开队列 sheet', async () => {
    seed([makeItem('a'), makeItem('b'), makeItem('c')]);
    const view = await renderFloat();
    expect(view.getByText('还有 2 个')).toBeTruthy();
    await fireEvent.press(view.getByTestId('approval-float-more'));
    expect(mockPush).toHaveBeenCalledWith('/approvals');
  });

  it('收起成胶囊，点胶囊再展开', async () => {
    seed([makeItem('a'), makeItem('b')]);
    const view = await renderFloat();
    await fireEvent.press(view.getByTestId('approval-float-collapse'));
    expect(view.queryByTestId('approval-float-card')).toBeNull();
    expect(view.getByText(/^2 个待审批 · \d+:\d{2}$/)).toBeTruthy();
    await fireEvent.press(view.getByTestId('approval-float-pill'));
    expect(view.getByTestId('approval-float-card')).toBeTruthy();
  });

  it('点卡片空白处回到所属会话', async () => {
    seed([makeItem('tc-1')]);
    const view = await renderFloat();
    await fireEvent.press(view.getByTestId('approval-float-card'));
    expect(mockNavigate).toHaveBeenCalledWith('/session/s-1');
  });
});
