// 语音设置子页测试：状态诚实呈现 + 管理动作接真实管理器通道。
// 假 manager/service 经 mock 工厂内定义（避免工厂求值时 TDZ），钉三
// 件事：缺失→可下载、就绪→可校验修复/可删除、引擎不可用→无假入口。
import { PermissionsAndroid, Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import {
  asrModelManager,
  type AsrModelState,
} from '@/adapters/asr/modelManager';
import { voiceInputService } from '@/adapters/asr/voiceInputService';
import { SettingsVoiceView } from './SettingsVoiceView';

jest.mock('@/adapters/asr/modelManager', () => {
  const manager = {
    check: jest.fn(),
    ensureReady: jest.fn(),
    removeAll: jest.fn(),
  };
  return {
    asrModelManager: () => manager,
    ASR_MODEL_TOTAL_BYTES: 240193589,
  };
});

jest.mock('@/adapters/asr/voiceInputService', () => ({
  voiceInputService: {
    isAvailable: jest.fn(() => true),
    requestPermission: jest.fn(async () => true),
  },
}));

// jest-expo 默认 Platform.OS='ios'；本页权限行是 Android 通道，钉在
// Android 口径下验（引擎可用性由 mockService 独立控制，与平台无关）
(Platform as { OS: string }).OS = 'android';

const mockManager = asrModelManager() as unknown as {
  check: jest.Mock;
  ensureReady: jest.Mock;
  removeAll: jest.Mock;
};
const mockService = voiceInputService as unknown as {
  isAvailable: jest.Mock;
  requestPermission: jest.Mock;
};

const READY: AsrModelState = {
  kind: 'ready',
  paths: {
    dir: 'file:///docs/crish-asr-models/',
    modelPath: 'file:///docs/crish-asr-models/model.int8.onnx',
    tokensPath: 'file:///docs/crish-asr-models/tokens.txt',
    vadModelPath: 'file:///docs/crish-asr-models/silero_vad.onnx',
  },
};

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

describe('SettingsVoiceView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockService.isAvailable.mockReturnValue(true);
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true as never);
  });

  it('模型缺失 → 状态未下载 + 下载入口；下载走 ensureReady 并落就绪', async () => {
    mockManager.check.mockResolvedValue({ kind: 'missing' });
    mockManager.ensureReady.mockImplementation(
      async (onState: (state: AsrModelState) => void) => {
        onState(READY);
        return READY;
      }
    );
    const view = await render(<SettingsVoiceView onBack={jest.fn()} />, {
      wrapper: Wrapper,
    });
    expect(await view.findByText('未下载')).toBeTruthy();
    expect(await view.findByText('已授权')).toBeTruthy();
    await fireEvent.press(view.getByText('下载模型'));
    expect(mockManager.ensureReady).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(view.getByText('已就绪')).toBeTruthy();
    });
    // 就绪后管理面出现：校验修复 + 删除
    expect(view.getByText('校验并修复')).toBeTruthy();
    expect(view.getByText('删除模型')).toBeTruthy();
  });

  it('删除模型 → 确认弹窗 → removeAll 真实通道，状态回未下载', async () => {
    mockManager.check
      .mockResolvedValueOnce(READY)
      .mockResolvedValue({ kind: 'missing' });
    mockManager.removeAll.mockResolvedValue(undefined);
    const view = await render(<SettingsVoiceView onBack={jest.fn()} />, {
      wrapper: Wrapper,
    });
    expect(await view.findByText('已就绪')).toBeTruthy();
    await fireEvent.press(view.getByText('删除模型'));
    expect(view.getByText('删除语音模型')).toBeTruthy();
    await fireEvent.press(view.getByText('删除'));
    expect(mockManager.removeAll).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(view.getByText('未下载')).toBeTruthy();
    });
  });

  it('引擎不可用 → 只诚实呈现不支持，无模型管理假入口', async () => {
    mockService.isAvailable.mockReturnValue(false);
    mockManager.check.mockResolvedValue({ kind: 'missing' });
    const view = await render(<SettingsVoiceView onBack={jest.fn()} />, {
      wrapper: Wrapper,
    });
    expect(await view.findByText('当前设备不支持')).toBeTruthy();
    expect(view.queryByText('下载模型')).toBeNull();
    expect(view.queryByText('删除模型')).toBeNull();
    expect(mockManager.ensureReady).not.toHaveBeenCalled();
  });
});
