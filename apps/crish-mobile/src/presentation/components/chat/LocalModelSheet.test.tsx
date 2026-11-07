// LocalModelSheet 呈现与切换测试
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { LocalModelSheet } from './LocalModelSheet';
import { localChatStore } from '@/domain/store/localChatStore';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';

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

describe('LocalModelSheet 选择模型（任务四后置项）', () => {
  beforeEach(() => {
    localChatSessionStore.setState({ threads: [], activeThreadId: null });
    // 与上方 describe 同一份双供应商基线配置（describe 级 beforeEach
    // 不跨块生效，本块自带一份，避免用例间配置串扰）
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

  it('标题为「选择模型」，本机模型分组来自 ondevice 同步条目', async () => {
    localChatStore.setState({
      config: {
        version: 2,
        providers: {
          ondevice: {
            displayName: '本机模型',
            protocol: 'ondevice/gguf',
            stream: true,
            enabled: true,
            models: [
              {
                id: 'qwen2.5-1.5b-q4',
                displayName: 'Qwen2.5 1.5B',
                enabled: true,
                contextWindow: 4096,
                modalities: { input: ['text'], output: ['text'] },
              },
            ],
          },
        },
        activeModel: null,
      },
    });

    const onClose = jest.fn();
    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          onClose={onClose}
          onOpenProviders={jest.fn()}
        />
      </SafeAreaProvider>
    );

    expect(view.getByText('选择模型')).toBeTruthy();
    expect(view.getByText('本机模型')).toBeTruthy();
    expect(view.getByText('Qwen2.5 1.5B')).toBeTruthy();

    // 无线程上下文：点行即设为默认
    await fireEvent.press(
      view.getByTestId('local-model-sheet-option-ondevice-qwen2.5-1.5b-q4')
    );
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'ondevice',
      modelId: 'qwen2.5-1.5b-q4',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('当前默认失效时呈现未设置与默认模型页同口径说明', async () => {
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
        },
        activeModel: { providerId: 'deepseek', modelId: 'removed-model' },
      },
    });

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          onClose={jest.fn()}
          onOpenProviders={jest.fn()}
        />
      </SafeAreaProvider>
    );

    expect(view.getByText('未设置')).toBeTruthy();
    expect(
      view.getByText(
        '当前默认已失效（模型被删除、停用，或供应商不可用），系统没有自动改用其他模型。请在下方重新选择。'
      )
    ).toBeTruthy();
  });

  it('线程内默认作用域「仅此对话」只写线程 modelRef，不动全局默认', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    const onClose = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          threadId={threadId}
          onClose={onClose}
          onOpenProviders={jest.fn()}
        />
      </SafeAreaProvider>
    );

    await fireEvent.press(
      view.getByTestId('local-model-sheet-option-openai-gpt-4o')
    );
    const meta = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === threadId);
    expect(meta?.modelRef).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('线程内切到「设为默认」只写 activeModel，不写线程覆盖', async () => {
    const threadId = localChatSessionStore.getState().createThread();
    const onClose = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          threadId={threadId}
          onClose={onClose}
          onOpenProviders={jest.fn()}
        />
      </SafeAreaProvider>
    );

    await fireEvent.press(
      view.getByTestId('local-model-sheet-scope-option-default')
    );
    await fireEvent.press(
      view.getByTestId('local-model-sheet-option-openai-gpt-4o')
    );
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    const meta = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === threadId);
    expect(meta?.modelRef).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('线程已有覆盖时「跟随默认」清覆盖，全局默认不动', async () => {
    const threadId = localChatSessionStore.getState().createThread({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    const onClose = jest.fn();

    const view = await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <LocalModelSheet
          visible
          threadId={threadId}
          onClose={onClose}
          onOpenProviders={jest.fn()}
        />
      </SafeAreaProvider>
    );

    await fireEvent.press(view.getByTestId('local-model-sheet-follow-default'));
    const meta = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === threadId);
    expect(meta?.modelRef).toBeNull();
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
