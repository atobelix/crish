// ModelSheet 口径呈现测试（M3 + M2 失败面）：
// - 有默认且可选 → 口径行呈默认名（当前全局默认：X），无注脚；
// - 有默认但已停用/不在可选集 → 口径行 + 「当前默认已停用/不可选」注脚；
// - 未设默认 → 独立态「桌面未设全局默认」；
// - 列表失败面呈现错误码 + 重试（M2）；未连接面与失败面分开。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';
import { ModelSheet, type ModelSheetProps } from './ModelSheet';
import { modelRefKey } from '@/domain/repositories/modelCommands';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const MODEL_A: ModelEntry = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
  providerDisplayName: 'Anthropic',
  active: true,
};
const MODEL_B: ModelEntry = {
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  active: false,
};
const ACTIVE_A: ActiveModelInfo = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
};
const ACTIVE_GONE: ActiveModelInfo = {
  providerId: 'gone',
  modelId: 'retired',
  displayName: '已退役模型',
};

function renderSheet(props: Partial<ModelSheetProps> = {}) {
  return render(
    <ModelSheet
      visible
      onClose={jest.fn()}
      connected
      models={[MODEL_A, MODEL_B]}
      status="loaded"
      activeModelId={modelRefKey(ACTIVE_A.providerId, ACTIVE_A.modelId)}
      activeModel={ACTIVE_A}
      activeModelSelectable
      switching={false}
      errorCode={null}
      onSelectModel={jest.fn()}
      onRetry={jest.fn()}
      {...props}
    />,
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
      ),
    }
  );
}

describe('ModelSheet 口径呈现（M3）', () => {
  it('有默认且可选：口径行呈默认名与等价说明，无注脚，列表选中行在位', async () => {
    const view = await renderSheet();
    expect(view.getByText('当前全局默认：Claude Sonnet')).toBeTruthy();
    expect(
      view.queryByText('当前默认已停用/不可选，下方列表为可选模型')
    ).toBeNull();
    expect(view.queryByText('桌面未设全局默认')).toBeNull();
    expect(
      view.getByTestId('model-sheet-option-anthropic-claude-sonnet')
    ).toBeTruthy();
  });

  it('有默认但已停用（不在可选集）：口径行呈其名 + 注脚说明，无行选中', async () => {
    const view = await renderSheet({
      activeModel: ACTIVE_GONE,
      activeModelId: modelRefKey(ACTIVE_GONE.providerId, ACTIVE_GONE.modelId),
      activeModelSelectable: false,
    });
    expect(view.getByText('当前全局默认：已退役模型')).toBeTruthy();
    expect(
      view.getByText('当前默认已停用/不可选，下方列表为可选模型')
    ).toBeTruthy();
  });

  it('未设默认：独立态文案，不呈口径行与注脚', async () => {
    const view = await renderSheet({
      activeModel: null,
      activeModelId: null,
      activeModelSelectable: false,
    });
    expect(view.getByText('桌面未设全局默认')).toBeTruthy();
    expect(view.queryByText(/当前全局默认：/)).toBeNull();
    expect(
      view.queryByText('当前默认已停用/不可选，下方列表为可选模型')
    ).toBeNull();
  });
});

describe('ModelSheet 失败面（M2）', () => {
  it('列表失败：呈现错误码 + 重试钮，点重试回调 onRetry', async () => {
    const onRetry = jest.fn();
    const view = await renderSheet({
      models: null,
      status: 'error',
      errorCode: 'cmd.timeout',
      onRetry,
    });
    expect(view.getByText('无法获取模型列表（cmd.timeout）')).toBeTruthy();
    await fireEvent.press(view.getByText('重试'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('未连接：呈未连接面（与命令失败分开），不呈错误码', async () => {
    const view = await renderSheet({ connected: false });
    expect(view.getByText('未连接桌面')).toBeTruthy();
    expect(view.queryByText(/无法获取模型列表/)).toBeNull();
  });
});
