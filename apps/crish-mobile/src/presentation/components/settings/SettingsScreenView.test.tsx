import { act, fireEvent, render } from '@testing-library/react-native';
import { InteractionManager } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import SettingsScreenView, {
  type SettingsScreenViewProps,
} from './SettingsScreenView';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';

const mockCheck = jest.fn();

jest.mock('@/adapters/asr/modelManager', () => ({
  asrModelManager: () => ({
    check: mockCheck,
  }),
}));

jest.mock('@/adapters/asr/voiceInputService', () => ({
  voiceInputService: {
    isAvailable: jest.fn(() => true),
  },
}));

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

function createVm(overrides: Partial<SettingsVm> = {}): SettingsVm {
  return {
    themeMode: 'system',
    fontScale: 'standard',
    hapticsEnabled: true,
    hapticsStrength: 'medium',
    statusSummary: {
      connected: false,
      title: '未连接',
      hint: '',
    },
    ...overrides,
  } as unknown as SettingsVm;
}

describe('SettingsScreenView 进出性能与懒挂载（方案 21 性能铁律）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheck.mockResolvedValue({ kind: 'ready' });
  });

  it('初始挂载时不实例化 Native Modal，仅在触发解除配对时懒挂载 Dialog', async () => {
    const onConfirmRemove = jest.fn();
    const props: SettingsScreenViewProps = {
      vm: createVm(),
      onBack: jest.fn(),
      onOpenAccount: jest.fn(),
      onOpenSessions: jest.fn(),
      onOpenTheme: jest.fn(),
      onOpenFont: jest.fn(),
      onOpenNotification: jest.fn(),
      onOpenScan: jest.fn(),
      onConfirmRemove,
    };

    const view = await render(<SettingsScreenView {...props} />, {
      wrapper: Wrapper,
    });

    // 1. 懒挂载断言：初次渲染时，remove Dialog 未挂载在 JSX 树中（原生 Modal 计数 = 0）
    expect(view.queryByTestId('settings-remove-dialog')).toBeNull();

    // 2. 点击解除配对行，触发 Dialog 懒挂载
    const removeRow = view.getByText('解除配对');
    await act(async () => {
      fireEvent.press(removeRow);
    });

    // 3. 此时 Dialog 节点被挂入 JSX
    expect(view.getByTestId('settings-remove-dialog')).toBeTruthy();

    // 4. 点击取消按键
    const cancelBtn = view.getByTestId('settings-remove-cancel');
    await act(async () => {
      fireEvent.press(cancelBtn);
    });

    // 5. 再次点击解除配对并确认
    await act(async () => {
      fireEvent.press(removeRow);
    });
    const confirmBtn = view.getByTestId('settings-remove-confirm');
    await act(async () => {
      fireEvent.press(confirmBtn);
    });
    expect(onConfirmRemove).toHaveBeenCalledTimes(1);
  });

  it('ASR 模型检查让步于转场：初次渲染不触发同步 I/O，待 InteractionManager 排队后执行', async () => {
    let interactionCallback: (() => void) | null = null;
    jest
      .spyOn(InteractionManager, 'runAfterInteractions')
      .mockImplementation((callback: any) => {
        interactionCallback = callback;
        return { cancel: jest.fn(), done: jest.fn() } as never;
      });

    const props: SettingsScreenViewProps = {
      vm: createVm(),
      onBack: jest.fn(),
      onOpenAccount: jest.fn(),
      onOpenSessions: jest.fn(),
      onOpenTheme: jest.fn(),
      onOpenFont: jest.fn(),
      onOpenNotification: jest.fn(),
      onOpenScan: jest.fn(),
      onConfirmRemove: jest.fn(),
      onOpenVoice: jest.fn(),
    };

    await render(<SettingsScreenView {...props} />, { wrapper: Wrapper });

    // 初始渲染：ASR check 未被调用，完全让位给页面入场动画
    expect(mockCheck).not.toHaveBeenCalled();
    expect(interactionCallback).not.toBeNull();

    // 模拟转场结束，InteractionManager 释放
    await act(async () => {
      interactionCallback?.();
    });

    // 转场后：check 正常执行
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});
