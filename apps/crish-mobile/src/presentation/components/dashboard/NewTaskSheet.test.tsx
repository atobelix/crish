// 发起任务 Sheet 测试：可见性、输入提交门禁、错误提示、会话 chip 选择。
import type { ReactElement } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { fireEvent, render } from '@testing-library/react-native';
import { NewTaskSheet } from './NewTaskSheet';
import { ToastProvider } from '@/presentation/ui';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';

jest.mock('@/adapters/viewmodels/useQuickRunVm', () => ({
  useQuickRunVm: jest.fn(),
}));

const useQuickRunVmMock = useQuickRunVm as jest.Mock;

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/** Sheet 依赖安全区与 Toast 上下文，测试统一包裹 */
async function renderSheet(element: ReactElement) {
  return render(element, {
    wrapper: ({ children }) => (
      <SafeAreaProvider initialMetrics={metrics}>
        <ToastProvider>{children}</ToastProvider>
      </SafeAreaProvider>
    ),
  });
}

function vm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt: '',
    setPrompt: jest.fn(),
    submit: jest.fn(),
    canSubmit: false,
    busy: false,
    feedback: { kind: 'idle' },
    recentSessions: [],
    selectedSessionId: null,
    selectSession: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('NewTaskSheet', () => {
  it('visible=false 时不渲染内容', async () => {
    useQuickRunVmMock.mockReturnValue(vm());
    const view = await renderSheet(
      <NewTaskSheet visible={false} onClose={jest.fn()} onOpenRun={jest.fn()} />
    );
    expect(view.queryByTestId('new-task-input')).toBeNull();
  });

  it('可见时渲染输入框与发送按钮', async () => {
    useQuickRunVmMock.mockReturnValue(vm());
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );
    expect(view.getByTestId('new-task-input')).toBeTruthy();
    expect(view.getByTestId('new-task-submit')).toBeTruthy();
  });

  it('输入变化调用 setPrompt', async () => {
    const setPrompt = jest.fn();
    useQuickRunVmMock.mockReturnValue(vm({ setPrompt }));
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );

    fireEvent.changeText(view.getByTestId('new-task-input'), '写个测试');

    expect(setPrompt).toHaveBeenCalledWith('写个测试');
  });

  it('点击发送调用 submit', async () => {
    const submit = jest.fn();
    useQuickRunVmMock.mockReturnValue(vm({ canSubmit: true, submit }));
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );

    fireEvent.press(view.getByTestId('new-task-submit'));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('canSubmit=false 时按钮禁用', async () => {
    useQuickRunVmMock.mockReturnValue(vm({ canSubmit: false }));
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );
    expect(
      view.getByTestId('new-task-submit').props.accessibilityState
    ).toMatchObject({ disabled: true });
  });

  it('提交成功后打开 run 并关闭 Sheet', async () => {
    const onOpenRun = jest.fn();
    const onClose = jest.fn();
    useQuickRunVmMock.mockReturnValue(
      vm({ feedback: { kind: 'success', runId: 'r-9' } })
    );

    await renderSheet(
      <NewTaskSheet visible onClose={onClose} onOpenRun={onOpenRun} />
    );

    expect(onOpenRun).toHaveBeenCalledWith('r-9');
    expect(onClose).toHaveBeenCalled();
  });

  it('提交失败时展示错误文案', async () => {
    useQuickRunVmMock.mockReturnValue(
      vm({ feedback: { kind: 'error', message: '连接已断开' } })
    );
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );

    expect(view.getByText('连接已断开')).toBeTruthy();
  });

  it('无最近会话时不显示会话选择区', async () => {
    useQuickRunVmMock.mockReturnValue(vm({ recentSessions: [] }));
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );
    expect(view.queryByText('在会话中继续')).toBeNull();
  });

  it('有最近会话时渲染「新会话」与各会话 chip', async () => {
    useQuickRunVmMock.mockReturnValue(
      vm({
        recentSessions: [
          { id: 's-1', title: '修复登录' },
          { id: 's-2', title: '' },
        ],
      })
    );
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );

    expect(view.getByText('在会话中继续')).toBeTruthy();
    expect(view.getByText('新会话')).toBeTruthy();
    expect(view.getByText('修复登录')).toBeTruthy();
    // 空标题回落到「未命名会话」
    expect(view.getByText('未命名会话')).toBeTruthy();
  });

  it('点击会话 chip 调用 selectSession', async () => {
    const selectSession = jest.fn();
    useQuickRunVmMock.mockReturnValue(
      vm({
        recentSessions: [{ id: 's-1', title: '修复登录' }],
        selectSession,
      })
    );
    const view = await renderSheet(
      <NewTaskSheet visible onClose={jest.fn()} onOpenRun={jest.fn()} />
    );

    fireEvent.press(view.getByText('修复登录'));

    expect(selectSession).toHaveBeenCalledWith('s-1');
  });
});
