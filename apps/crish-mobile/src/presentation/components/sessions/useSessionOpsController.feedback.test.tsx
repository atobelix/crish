import { act, fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { haptics } from '@/adapters/platform/haptics';
import { ToastProvider } from '@/presentation/ui';
import { useSessionOpsController } from './useSessionOpsController';

jest.mock('@/adapters/platform/haptics', () => ({
  haptics: {
    selection: jest.fn(),
    tap: jest.fn(),
    snap: jest.fn(),
    success: jest.fn(),
    failure: jest.fn(),
  },
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SESSION: SessionSummary = {
  id: 's-1',
  title: '会话',
  updatedAt: 1,
  receivedAtMs: 1,
  lastReadSequence: 0,
  unreadCount: 0,
  activeRunIds: [],
  pendingApprovalCount: 0,
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ToastProvider>{children}</ToastProvider>
    </SafeAreaProvider>
  );
}

describe('会话操作长按反馈', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('打开菜单只震一次，关掉再开是下一次动作', async () => {
    let open: ((session: SessionSummary) => void) | null = null;
    function Probe() {
      const ops = useSessionOpsController();
      open = ops.openActions;
      return <>{ops.layer}</>;
    }
    const view = await render(<Probe />, { wrapper: Wrapper });
    await act(async () => {
      open?.(SESSION);
    });
    expect(haptics.selection).toHaveBeenCalledTimes(1);
    expect(haptics.tap).not.toHaveBeenCalled();
    expect(haptics.success).not.toHaveBeenCalled();
    expect(view.getByTestId('session-actions-sheet')).toBeTruthy();

    await fireEvent.press(view.getByTestId('sheet-close'));
    await act(async () => {
      open?.(SESSION);
    });
    expect(haptics.selection).toHaveBeenCalledTimes(2);
    expect(haptics.success).not.toHaveBeenCalled();
  });
});
