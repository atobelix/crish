// LocalModelSheet 呈现与切换测试
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { LocalModelSheet } from './LocalModelSheet';
import { localChatStore } from '@/domain/store/localChatStore';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

describe('LocalModelSheet 本地模型选择', () => {
  beforeEach(() => {
    localChatStore.setState({
      config: {
        version: 2,
        providers: {
          deepseek: {
            vendor: 'deepseek',
            displayName: 'DeepSeek',
            protocol: 'openai/chat',
            enabled: true,
            baseUrl: 'https://api.deepseek.com',
            models: [
              {
                id: 'deepseek-chat',
                displayName: 'DeepSeek-V3',
                enabled: true,
                contextWindow: 64000,
                maxOutputTokens: 8192,
              },
            ],
          },
          openai: {
            vendor: 'openai',
            displayName: 'OpenAI',
            protocol: 'openai/chat',
            enabled: true,
            baseUrl: 'https://api.openai.com/v1',
            models: [
              {
                id: 'gpt-4o',
                displayName: 'GPT-4o',
                enabled: true,
                contextWindow: 128000,
                maxOutputTokens: 4096,
              },
            ],
          },
        },
        activeModel: {
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
        },
      },
    });
  });

  it('渲染官方厂商徽标、模型精简名称与选中状态', async () => {
    const onClose = jest.fn();
    const onOpenProviders = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          onClose={onClose}
          onOpenProviders={onOpenProviders}
        />
      </SafeAreaProvider>
    );

    // 验证厂商矢量徽标（DeepSeek 与 OpenAI）在位
    expect(view.getByLabelText('DeepSeek logo')).toBeTruthy();
    expect(view.getByLabelText('OpenAI logo')).toBeTruthy();

    // 验证模型名称
    expect(view.getByText('DeepSeek-V3')).toBeTruthy();
    expect(view.getByText('GPT-4o')).toBeTruthy();

    // 点击切换为 GPT-4o
    await fireEvent.press(
      view.getByTestId('local-model-sheet-option-openai-gpt-4o')
    );
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('无供应商时展示空态与引导配置按钮', async () => {
    localChatStore.setState({
      config: {
        version: 2,
        providers: {},
        activeModel: null,
      },
    });

    const onClose = jest.fn();
    const onOpenProviders = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          onClose={onClose}
          onOpenProviders={onOpenProviders}
        />
      </SafeAreaProvider>
    );

    expect(view.getByText('尚未配置本地供应商')).toBeTruthy();
    await fireEvent.press(view.getByText('去配置供应商'));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
  });
});
